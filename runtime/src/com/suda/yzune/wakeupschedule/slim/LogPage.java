package com.suda.yzune.wakeupschedule.slim;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.Closeable;
import java.lang.ref.WeakReference;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.WeakHashMap;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.CountDownLatch;

/** Full-screen, local-only log browser. Public methods are the Smali bridge ABI. */
public final class LogPage {
    static final int EXPORT_REQUEST_CODE = 0x6c67;
    static final int RESULT_OK = -1;
    static final String ENTRY_TAG = "wakeup_noads_logs_entry";
    static final String SANITIZED_NOTICE = "日志已脱敏";
    private static final Object LOCK = new Object();
    private static final Map<Object, Controller> CONTROLLERS = new WeakHashMap<Object, Controller>();
    private static final List<String> ACTIVE_SNAPSHOTS = new ArrayList<String>();
    private static final Map<Object, Pending> ACTIVE_EXPORTS = new WeakHashMap<Object, Pending>();
    private static final AtomicLong EXPORT_TOKENS = new AtomicLong();
    private static final ExecutorService IO = Executors.newSingleThreadExecutor(new ThreadFactory() {
        @Override public Thread newThread(Runnable task) {
            Thread thread = new Thread(task, "wakeup-noads-log-io");
            thread.setDaemon(true);
            return thread;
        }
    });
    private static final ExecutorService CANCELLATION = Executors.newSingleThreadExecutor(new ThreadFactory() {
        @Override public Thread newThread(Runnable task) {
            Thread thread = new Thread(task, "wakeup-noads-log-cancel");
            thread.setDaemon(true);
            return thread;
        }
    });

    private LogPage() { }

    public static void bind(Object fragment, Object rootView) {
        if (fragment == null || rootView == null) return;
        Object row = findTaggedView(rootView);
        if (row == null) return;
        final WeakReference<Object> owner = new WeakReference<Object>(fragment);
        try {
            Class<?> listenerType = Class.forName("android.view.View$OnClickListener");
            Object listener = Proxy.newProxyInstance(listenerType.getClassLoader(), new Class<?>[] { listenerType },
                (proxy, method, args) -> {
                    if ("onClick".equals(method.getName())) show(owner.get());
                    return null;
                });
            row.getClass().getMethod("setOnClickListener", listenerType).invoke(row, listener);
        } catch (Throwable ignored) {
            // A missing Android view API must not break MineFragment creation.
        }
    }

    public static void show(Object fragment) {
        if (fragment == null) return;
        Controller controller;
        synchronized (LOCK) {
            controller = CONTROLLERS.get(fragment);
            if (controller == null || controller.closed) {
                try {
                    Object activity = fragment.getClass().getMethod("getActivity").invoke(fragment);
                    if (activity == null) return;
                    LogStore store = LogStore.forContext(activity);
                    AndroidHost host = new AndroidHost(fragment, activity);
                    controller = new Controller(fragment, store, host);
                    host.controller = controller;
                    CONTROLLERS.put(fragment, controller);
                    cleanupOrphanSnapshots((File) activity.getClass().getMethod("getCacheDir").invoke(activity));
                } catch (Throwable failure) {
                    toastFromFragment(fragment, "日志页暂不可用");
                    return;
                }
            }
        }
        controller.present();
    }

    public static void onActivityResult(Object fragment, int requestCode, int resultCode, Object intent) {
        if (requestCode != EXPORT_REQUEST_CODE) return;
        Controller controller;
        synchronized (LOCK) { controller = CONTROLLERS.get(fragment); }
        if (controller == null) {
            return;
        }
        Object uri = null;
        try { if (intent != null) uri = intent.getClass().getMethod("getData").invoke(intent); }
        catch (Throwable ignored) { }
        controller.onActivityResult(fragment, requestCode, resultCode, uri);
    }

    public static void close(Object fragment) {
        if (fragment == null) return;
        Controller controller;
        synchronized (LOCK) { controller = CONTROLLERS.remove(fragment); }
        if (controller != null) controller.close();
    }

    interface ControllerHost {
        void executeIo(Runnable task);
        default void executeCancellation(Runnable task) { CANCELLATION.execute(task); }
        void postMain(Runnable task);
        void open();
        void dismiss();
        void render(PageState state);
        void toast(String message);
        void copy(String text) throws Exception;
        void launchDocument(String title, int requestCode) throws Exception;
        boolean isContentUri(Object uri);
        OutputStream openTarget(Object uri) throws Exception;
        void deleteTarget(Object uri) throws Exception;
        default boolean deleteTargetChecked(Object uri) throws Exception { deleteTarget(uri); return true; }
        default boolean deleteSnapshot(File cacheDirectory, File snapshot) { return LogPage.deleteSnapshot(cacheDirectory, snapshot); }
        default InputStream openSnapshot(File cacheDirectory, File snapshot) throws Exception {
            LogStore.assertSnapshot(cacheDirectory, snapshot);
            return new FileInputStream(snapshot);
        }
    }

    static final class PageState {
        final LogStore.Result result;
        final LogStore.Entry selected;
        final String preview;
        final boolean detail;
        final boolean exportPending;
        final String message;

        PageState(LogStore.Result result, LogStore.Entry selected, String preview, boolean detail, boolean exportPending, String message) {
            this.result = result;
            this.selected = selected;
            this.preview = preview;
            this.detail = detail;
            this.exportPending = exportPending;
            this.message = message;
        }
    }

    static final class Controller {
        private final WeakReference<Object> owner;
        private final LogStore store;
        private final ControllerHost host;
        private LogStore.Result result = new LogStore.Result(Collections.<LogStore.Entry>emptyList(), Collections.<String>emptyList(), 0, 0);
        private LogStore.Entry selected;
        private String preview = "";
        private String message = "";
        private boolean detail;
        private boolean presented;
        private volatile boolean closed;
        private long generation;
        private Pending session;

        Controller(Object owner, LogStore store, ControllerHost host) {
            this.owner = new WeakReference<Object>(owner);
            this.store = store;
            this.host = host;
            Pending retry = null;
            synchronized (LOCK) {
                Pending existing = ACTIVE_EXPORTS.get(owner);
                if (existing != null && !existing.finalized) {
                    session = existing;
                    existing.addController(this);
                    if (existing.snapshotCleanupFailed) retry = existing;
                }
            }
            if (retry != null) {
                final Pending pending = retry;
                host.executeCancellation(new Runnable() { @Override public void run() { finishSession(pending, null, null, false); } });
            }
        }

        void present() {
            if (closed) return;
            if (!presented) {
                presented = true;
                host.open();
            }
            refresh();
        }

        void refresh() {
            if (closed) return;
            final long ticket = ++generation;
            host.executeIo(new Runnable() {
                @Override public void run() {
                    final LogStore.Result loaded = store.list();
                    host.postMain(new Runnable() {
                        @Override public void run() {
                            if (closed || ticket != generation) return;
                            result = loaded;
                            selected = null;
                            preview = "";
                            detail = false;
                            message = loaded.stateText();
                            render();
                        }
                    });
                }
            });
        }

        void select(final LogStore.Entry entry) {
            if (closed || entry == null || !result.entries.contains(entry)) return;
            selected = entry;
            detail = true;
            preview = "";
            message = "正在读取日志…";
            final long ticket = ++generation;
            render();
            host.executeIo(new Runnable() {
                @Override public void run() {
                    final LogStore.Preview loaded;
                    try { loaded = store.preview(entry); }
                    catch (Throwable failure) {
                        host.postMain(new Runnable() {
                            @Override public void run() {
                                if (closed || ticket != generation || selected != entry) return;
                                preview = "";
                                message = "日志已消失或不可读取，请刷新重试";
                                render();
                            }
                        });
                        return;
                    }
                    host.postMain(new Runnable() {
                        @Override public void run() {
                            if (closed || ticket != generation || selected != entry) return;
                            preview = loaded.text;
                            message = loaded.truncated ? "正文已截断；导出可保存完整日志" : "";
                            render();
                        }
                    });
                }
            });
        }

        void back() {
            if (closed) return;
            if (detail) {
                detail = false;
                selected = null;
                preview = "";
                message = result.stateText();
                generation++;
                render();
            } else {
                Object fragment = owner.get();
                if (fragment != null) LogPage.close(fragment);
                else close();
            }
        }

        void copySelected() {
            if (closed || selected == null) return;
            if (isBusy()) { host.toast("已有导出正在处理"); return; }
            final LogStore.Entry frozen = selected;
            final long ticket = generation;
            host.executeIo(new Runnable() {
                @Override public void run() {
                    final LogStore.CopyText copied;
                    try { copied = store.copyText(frozen); }
                    catch (final Throwable failure) {
                        host.postMain(new Runnable() { @Override public void run() { if (isCurrent(ticket, frozen)) host.toast("复制失败：日志不可读取"); } });
                        return;
                    }
                    host.postMain(new Runnable() {
                        @Override public void run() {
                            if (!isCurrent(ticket, frozen)) return;
                            try {
                                host.copy(copied.text);
                                host.toast(copied.truncated ? "已复制部分内容，完整日志请导出" : "已复制");
                            } catch (Throwable failure) { host.toast("复制失败"); }
                        }
                    });
                }
            });
        }

        void exportSelected(File cacheDirectory) {
            if (closed || selected == null) return;
            if (isBusy()) { host.toast("已有导出正在处理"); return; }
            final LogStore.Entry frozen = selected;
            final long ticket = generation;
            final Pending current = new Pending(EXPORT_TOKENS.incrementAndGet(), frozen, null, owner, ticket, cacheDirectory);
            session = current;
            current.addController(this);
            synchronized (LOCK) { ACTIVE_EXPORTS.put(owner.get(), current); }
            message = "正在准备完整日志…";
            render();
            host.executeIo(new Runnable() {
                @Override public void run() {
                    final File snapshot;
                    try { snapshot = store.snapshot(frozen, cacheDirectory); }
                    catch (Throwable failure) {
                        finishSession(current, "无法准备完整日志", "无法准备完整日志", true);
                        return;
                    }
                    current.setSnapshot(snapshot);
                    host.postMain(new Runnable() {
                        @Override public void run() {
                            if (current.isCancelled() || !isCurrentSessionResult(current)) {
                                finishSession(current, null, null, false);
                                return;
                            }
                            current.setState(SessionState.WAITING_RESULT);
                            try {
                                host.launchDocument("wakeup-noads-" + frozen.fileName, EXPORT_REQUEST_CODE);
                                if (isCurrentSessionResult(current)) message = "请选择本地保存位置";
                                renderIfOpen();
                            } catch (Throwable failure) {
                                finishSession(current, "系统文件选择器不可用", "系统文件选择器不可用", true);
                            }
                        }
                    });
                }
            });
        }

        boolean onActivityResult(Object fragment, int requestCode, int resultCode, Object uri) {
            if (requestCode != EXPORT_REQUEST_CODE || fragment == null || owner.get() != fragment) return false;
            final Pending current = session;
            if (current == null) {
                host.toast("导出已中断，请重新选择日志导出");
                return true;
            }
            if (current.owner.get() != fragment || current.state != SessionState.WAITING_RESULT || current.isCancelled()) return true;
            if (resultCode != RESULT_OK) {
                finishSession(current, "已取消导出", null, true);
                return true;
            }
            if (uri == null || !host.isContentUri(uri)) {
                finishSession(current, "未获得可写入的文件位置，未导出日志", "未获得可写入的文件位置，未导出日志", true);
                return true;
            }
            current.uri = uri;
            current.setState(SessionState.WRITING);
            host.executeIo(new Runnable() {
                @Override public void run() {
                    Throwable failure = null;
                    boolean cleanupFailed = false;
                    ManagedResource inputResource = null;
                    ManagedResource outputResource = null;
                    try {
                        ensureNotCancelled(current);
                        InputStream openedInput = host.openSnapshot(current.cacheDirectory, current.snapshot);
                        inputResource = registerResource(current, openedInput);
                        if (inputResource == null) throw new IOException("导出已取消");
                        ensureNotCancelled(current);
                        current.targetMayExist = true;
                        OutputStream openedOutput = host.openTarget(uri);
                        if (openedOutput == null) throw new IOException("目标文件不可写");
                        outputResource = registerResource(current, openedOutput);
                        if (outputResource == null) throw new IOException("导出已取消");
                        InputStream input = (InputStream) inputResource.stream;
                        OutputStream output = (OutputStream) outputResource.stream;
                        byte[] buffer = new byte[8192];
                        int count;
                        while (true) {
                            ensureNotCancelled(current);
                            count = input.read(buffer);
                            ensureNotCancelled(current);
                            if (count == -1) break;
                            output.write(buffer, 0, count);
                            ensureNotCancelled(current);
                        }
                    } catch (Throwable error) { failure = error; }
                    failure = closeResource(current, outputResource, failure);
                    failure = closeResource(current, inputResource, failure);
                    if (failure != null || current.isCancelled()) {
                        if (current.targetMayExist) {
                            try { cleanupFailed = !host.deleteTargetChecked(uri); }
                            catch (Throwable cleanupFailure) { cleanupFailed = true; }
                        }
                    }
                    current.targetCleanupFailed = cleanupFailed;
                    if (current.isCancelled()) finishSession(current, null, null, false);
                    else if (failure == null) finishSession(current, "导出成功", "导出成功", true);
                    else {
                        String safe = cleanupFailed ? "导出失败，可能留下不完整文件，请检查所选位置" : "导出失败，源日志未修改";
                        finishSession(current, safe, safe, true);
                    }
                }
            });
            return true;
        }

        void close() {
            if (closed) return;
            closed = true;
            generation++;
            Pending current = session;
            if (current != null && !current.finalized) {
                SessionState previous = current.state;
                cancelSession(current, host);
                if (previous == SessionState.WAITING_RESULT) {
                    host.executeCancellation(new Runnable() { @Override public void run() { finishSession(current, null, null, false); } });
                }
            }
            host.dismiss();
            presented = false;
        }

        private boolean isCurrent(long ticket, LogStore.Entry entry) {
            return !closed && generation == ticket && selected == entry;
        }
        private void renderIfOpen() { if (!closed && presented) render(); }
        private boolean isBusy() { return session != null && !session.finalized; }
        private boolean isCurrentSessionResult(Pending value) {
            return !closed && session == value && value.token > 0 && generation == value.generation && selected == value.entry;
        }
        private void render() { host.render(new PageState(result, selected, preview, detail, isBusy(), message)); }

        private void finishSession(final Pending value, final String resultMessage, final String toastMessage, boolean showResult) {
            synchronized (value.lock) {
                if (value.finalized || value.finishing) return;
                value.finishing = true;
                value.state = SessionState.FINALIZING;
            }
            Throwable failure = null;
            for (ManagedResource resource : value.resourcesSnapshot()) failure = closeResource(value, resource, failure);
            boolean snapshotCleaned = value.snapshot == null || host.deleteSnapshot(value.cacheDirectory, value.snapshot);
            if (!snapshotCleaned) failure = failure == null ? new IOException("无法清理导出快照") : failure;
            if (!snapshotCleaned) {
                value.snapshotCleanupFailed = true;
                synchronized (value.lock) { value.finishing = false; value.state = SessionState.CANCELLED; }
                for (final Controller observer : value.controllersSnapshot()) observer.host.postMain(new Runnable() {
                    @Override public void run() {
                        if (!observer.closed && observer.session == value) {
                            observer.message = "临时日志文件清理失败，导出仍在处理中";
                            observer.renderIfOpen();
                        }
                    }
                });
                return;
            }
            final boolean presentResult = showResult;
            synchronized (LOCK) {
                String path = canonical(value.snapshot);
                if (path != null) ACTIVE_SNAPSHOTS.remove(path);
                Object ownerValue = value.owner.get();
                if (ownerValue != null && ACTIVE_EXPORTS.get(ownerValue) == value) ACTIVE_EXPORTS.remove(ownerValue);
            }
            synchronized (value.lock) { value.finalized = true; value.finishing = false; value.state = SessionState.IDLE; }
            for (final Controller observer : value.controllersSnapshot()) {
                if (observer.session == value) observer.session = null;
                if (observer != this) observer.host.postMain(new Runnable() {
                    @Override public void run() { observer.renderIfOpen(); }
                });
            }
            host.postMain(new Runnable() {
                @Override public void run() {
                    if (closed) return;
                    boolean current = generation == value.generation && selected == value.entry && session == null;
                    if (presentResult && current && resultMessage != null) {
                        message = resultMessage;
                        if (toastMessage != null) host.toast(toastMessage);
                    }
                    renderIfOpen();
                }
            });
        }
    }

    private enum SessionState { PREPARING, WAITING_RESULT, WRITING, CANCELLED, FINALIZING, IDLE }

    private static final class Pending {
        final Object lock = new Object();
        final long token;
        final LogStore.Entry entry;
        volatile File snapshot;
        final WeakReference<Object> owner;
        final long generation;
        final File cacheDirectory;
        volatile SessionState state = SessionState.PREPARING;
        volatile boolean cancelled;
        volatile boolean finalized;
        volatile boolean finishing;
        volatile boolean snapshotCleanupFailed;
        volatile boolean targetCleanupFailed;
        volatile boolean targetMayExist;
        volatile Object uri;
        private final List<ManagedResource> resources = new ArrayList<ManagedResource>();
        private final List<WeakReference<Controller>> controllers = new ArrayList<WeakReference<Controller>>();
        Pending(long token, LogStore.Entry entry, File snapshot, WeakReference<Object> owner, long generation, File cacheDirectory) {
            this.token = token;
            this.entry = entry;
            this.snapshot = snapshot;
            this.owner = owner;
            this.generation = generation;
            this.cacheDirectory = cacheDirectory;
        }
        void setSnapshot(File value) {
            snapshot = value;
            synchronized (LOCK) { String path = canonical(value); if (path != null && !ACTIVE_SNAPSHOTS.contains(path)) ACTIVE_SNAPSHOTS.add(path); }
            synchronized (lock) { if (!cancelled) state = SessionState.WAITING_RESULT; }
        }
        void setState(SessionState value) { synchronized (lock) { if (!cancelled || value == SessionState.FINALIZING) state = value; } }
        boolean isCancelled() { synchronized (lock) { return cancelled || finalized; } }
        void addResource(ManagedResource value) { synchronized (lock) { resources.add(value); } }
        void removeResource(ManagedResource value) { synchronized (lock) { resources.remove(value); } }
        List<ManagedResource> resourcesSnapshot() { synchronized (lock) { return new ArrayList<ManagedResource>(resources); } }
        void addController(Controller value) { synchronized (lock) { controllers.add(new WeakReference<Controller>(value)); } }
        List<Controller> controllersSnapshot() {
            synchronized (lock) {
                List<Controller> values = new ArrayList<Controller>();
                for (WeakReference<Controller> reference : controllers) {
                    Controller value = reference.get();
                    if (value != null) values.add(value);
                }
                return values;
            }
        }
    }

    private static final class ManagedResource {
        final Closeable stream;
        final AtomicBoolean closing = new AtomicBoolean();
        final CountDownLatch closed = new CountDownLatch(1);
        volatile IOException closeFailure;
        ManagedResource(Closeable stream) { this.stream = stream; }
        void close() throws IOException {
            if (closing.compareAndSet(false, true)) {
                try { stream.close(); }
                catch (Throwable error) {
                    closeFailure = error instanceof IOException ? (IOException) error : new IOException("资源关闭失败", error);
                } finally { closed.countDown(); }
            } else {
                try { closed.await(); }
                catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); throw new IOException("等待资源关闭失败", interrupted); }
            }
            if (closeFailure != null) throw closeFailure;
        }
    }

    private static ManagedResource registerResource(Pending session, Closeable stream) throws IOException {
        if (stream == null) throw new IOException("导出资源不可用");
        ManagedResource resource = new ManagedResource(stream);
        synchronized (session.lock) {
            if (!session.cancelled && !session.finalized) { session.resources.add(resource); return resource; }
        }
        try { resource.close(); } catch (IOException ignored) { }
        return null;
    }

    private static void ensureNotCancelled(Pending session) throws IOException {
        if (session.isCancelled()) throw new IOException("导出已取消");
    }

    private static Throwable closeResource(Pending session, ManagedResource resource, Throwable failure) {
        if (resource == null) return failure;
        try { resource.close(); }
        catch (Throwable error) { if (failure == null) failure = error; else if (failure != error) failure.addSuppressed(error); }
        finally { session.removeResource(resource); }
        return failure;
    }

    private static void cancelSession(Pending session, ControllerHost host) {
        List<ManagedResource> resources;
        synchronized (session.lock) {
            if (session.finalized) return;
            session.cancelled = true;
            session.state = SessionState.CANCELLED;
            resources = session.resourcesSnapshot();
        }
        for (final ManagedResource resource : resources) {
            host.executeCancellation(new Runnable() { @Override public void run() { try { resource.close(); } catch (Throwable ignored) { } } });
        }
    }

    private static String canonical(File file) {
        if (file == null) return null;
        try { return file.getCanonicalPath(); } catch (IOException ignored) { return file.getAbsolutePath(); }
    }

    private static Object findTaggedView(Object view) {
        if (view == null) return null;
        try {
            Object tag = view.getClass().getMethod("getTag").invoke(view);
            if (ENTRY_TAG.equals(tag)) return view;
        } catch (Throwable ignored) { }
        try {
            int count = ((Number) view.getClass().getMethod("getChildCount").invoke(view)).intValue();
            Method childAt = view.getClass().getMethod("getChildAt", int.class);
            for (int index = 0; index < count; index++) {
                Object found = findTaggedView(childAt.invoke(view, index));
                if (found != null) return found;
            }
        } catch (Throwable ignored) { }
        return null;
    }

    private static void toastFromFragment(Object fragment, String message) {
        try {
            Object activity = fragment.getClass().getMethod("getActivity").invoke(fragment);
            if (activity != null) AndroidHost.toast(activity, message);
        } catch (Throwable ignored) { }
    }

    private static boolean deleteSnapshot(File cacheDirectory, File file) {
        return deleteSnapshot(cacheDirectory, file, new LogStore.CanonicalPaths() {
            @Override public String canonicalPath(File value) throws IOException { return value.getCanonicalPath(); }
        });
    }

    private static boolean deleteSnapshot(File cacheDirectory, File file, LogStore.CanonicalPaths paths) {
        if (file == null) return true;
        try {
            LogStore.assertSnapshot(cacheDirectory, file, paths);
            if (file.exists() && !file.delete()) return false;
            return true;
        } catch (Throwable ignored) { return false; }
    }

    static void deleteSnapshotForTest(File file) {
        File root = file == null || file.getParentFile() == null ? null : file.getParentFile().getParentFile();
        deleteSnapshot(root, file);
        synchronized (LOCK) { String path = canonical(file); if (path != null) ACTIVE_SNAPSHOTS.remove(path); }
    }
    static boolean deleteSnapshotForTest(File cacheDirectory, File file, LogStore.CanonicalPaths paths) {
        return deleteSnapshot(cacheDirectory, file, paths);
    }

    static void cleanupOrphanSnapshots(File cacheDirectory) {
        cleanupOrphanSnapshots(cacheDirectory, new LogStore.CanonicalPaths() {
            @Override public String canonicalPath(File value) throws IOException { return value.getCanonicalPath(); }
        });
    }

    static void cleanupOrphanSnapshots(File cacheDirectory, LogStore.CanonicalPaths paths) {
        if (cacheDirectory == null) return;
        File root = new File(cacheDirectory, LogStore.EXPORT_FOLDER);
        if (!root.exists() || !root.isDirectory()) return;
        try {
            String rootPath = paths.canonicalPath(root);
            String cachePath = paths.canonicalPath(cacheDirectory);
            if (!rootPath.startsWith(cachePath + File.separator)) return;
            File[] files = root.listFiles();
            if (files == null) return;
            for (File file : files) {
                boolean active;
                synchronized (LOCK) {
                    active = ACTIVE_SNAPSHOTS.contains(canonical(file));
                    if (!active) for (Pending pending : ACTIVE_EXPORTS.values()) {
                        if (pending != null && !pending.finalized && pending.state == SessionState.PREPARING
                            && cachePath.equals(canonical(pending.cacheDirectory))) { active = true; break; }
                    }
                }
                if (active) continue;
                try { LogStore.assertSnapshot(cacheDirectory, file, paths); } catch (IOException invalid) { continue; }
                String target = paths.canonicalPath(file);
                if (target.startsWith(rootPath + File.separator) && file.isFile()) file.delete();
            }
        } catch (Throwable ignored) { }
    }

    /** Reflection-only Android dialog and local SAF/clipboard adapters. */
    interface AndroidCalls {
        Object newIntent(String action) throws Exception;
        void addCategory(Object intent, String category) throws Exception;
        void setType(Object intent, String mimeType) throws Exception;
        void putStringExtra(Object intent, String key, String value) throws Exception;
        void putBooleanExtra(Object intent, String key, boolean value) throws Exception;
        void startActivityForResult(Object fragment, Object intent, int requestCode) throws Exception;
        OutputStream openTarget(Object context, Object uri) throws Exception;
        int deleteTarget(Object context, Object uri) throws Exception;
    }

    static final class AndroidHost implements ControllerHost {
        private final WeakReference<Object> fragment;
        private final WeakReference<Object> activity;
        private final AndroidCalls calls;
        private Controller controller;
        private Object dialog;
        private Object root;
        private Object body;
        private Object title;
        private Object refreshButton;
        private Object backCallback;
        private Object backDispatcher;
        private File cacheDirectory;

        AndroidHost(Object fragment, Object activity) { this(fragment, activity, new ReflectiveAndroidCalls()); }
        AndroidHost(Object fragment, Object activity, AndroidCalls calls) {
            this.fragment = new WeakReference<Object>(fragment);
            this.activity = new WeakReference<Object>(activity);
            this.calls = calls;
            try { cacheDirectory = (File) activity.getClass().getMethod("getCacheDir").invoke(activity); }
            catch (Throwable ignored) { }
        }
        @Override public void executeIo(Runnable task) { IO.execute(task); }
        @Override public void executeCancellation(Runnable task) { CANCELLATION.execute(task); }
        @Override public void postMain(Runnable task) {
            try {
                Class<?> handler = Class.forName("android.os.Handler");
                Object main = handler.getConstructor(Class.forName("android.os.Looper"))
                    .newInstance(Class.forName("android.os.Looper").getMethod("getMainLooper").invoke(null));
                handler.getMethod("post", Runnable.class).invoke(main, task);
            } catch (Throwable failure) { task.run(); }
        }
        @Override public void open() {
            Object context = activity.get();
            if (context == null || dialog != null) return;
            try {
                Class<?> dialogClass = Class.forName("android.app.Dialog");
                dialog = dialogClass.getConstructor(Class.forName("android.content.Context")).newInstance(context);
                buildDialog(context);
                dialogClass.getMethod("setContentView", Class.forName("android.view.View")).invoke(dialog, root);
                dialogClass.getMethod("setCancelable", boolean.class).invoke(dialog, true);
                try { dialogClass.getMethod("setCanceledOnTouchOutside", boolean.class).invoke(dialog, false); } catch (Throwable ignored) { }
                installBackHandling();
                dialogClass.getMethod("show").invoke(dialog);
                Object window = dialogClass.getMethod("getWindow").invoke(dialog);
                window.getClass().getMethod("setLayout", int.class, int.class).invoke(window, -1, -1);
                applyInsets(context, window, root);
            } catch (Throwable failure) {
                dismiss();
                toast("日志页暂不可用");
            }
        }
        @Override public void dismiss() {
            unregisterBack();
            if (dialog != null) try { dialog.getClass().getMethod("dismiss").invoke(dialog); } catch (Throwable ignored) { }
            dialog = null; root = null; body = null; title = null; refreshButton = null;
        }
        @Override public void render(PageState state) {
            if (dialog == null || body == null) return;
            try {
                body.getClass().getMethod("removeAllViews").invoke(body);
                setText(title, state.detail && state.selected != null ? state.selected.fileName : "本地日志");
                if (state.detail && state.selected != null) renderDetail(state);
                else renderList(state);
                if (refreshButton != null) setText(refreshButton, state.exportPending ? "导出中" : "刷新");
            } catch (Throwable ignored) { }
        }
        @Override public void toast(String message) { Object context = activity.get(); if (context != null) toast(context, message); }
        @Override public void copy(String text) throws Exception {
            Object context = activity.get();
            if (context == null) throw new IOException("宿主已关闭");
            Object manager = context.getClass().getMethod("getSystemService", String.class).invoke(context, "clipboard");
            Class<?> clipData = Class.forName("android.content.ClipData");
            Object clip = clipData.getMethod("newPlainText", CharSequence.class, CharSequence.class).invoke(null, "wakeup-noads-log", text);
            manager.getClass().getMethod("setPrimaryClip", clipData).invoke(manager, clip);
        }
        @Override public void launchDocument(String title, int requestCode) throws Exception {
            Object owner = fragment.get();
            Object context = activity.get();
            if (owner == null || context == null) throw new IOException("宿主已关闭");
            launchDocumentRequest(calls, owner, title, requestCode);
        }
        @Override public boolean isContentUri(Object uri) {
            if (uri == null) return false;
            try { return "content".equals(uri.getClass().getMethod("getScheme").invoke(uri)); }
            catch (Throwable ignored) { return false; }
        }
        @Override public OutputStream openTarget(Object uri) throws Exception {
            Object context = activity.get();
            if (context == null) throw new IOException("宿主已关闭");
            return calls.openTarget(context, uri);
        }
        @Override public void deleteTarget(Object uri) throws Exception {
            if (!deleteTargetChecked(uri)) throw new IOException("无法清理不完整导出文件");
        }
        @Override public boolean deleteTargetChecked(Object uri) throws Exception {
            Object context = activity.get();
            if (context == null) throw new IOException("宿主已关闭");
            return calls.deleteTarget(context, uri) > 0;
        }

        private static Object launchDocumentRequest(AndroidCalls calls, Object fragment, String title, int requestCode) throws Exception {
            Object intent = calls.newIntent("android.intent.action.CREATE_DOCUMENT");
            calls.addCategory(intent, "android.intent.category.OPENABLE");
            calls.setType(intent, "text/plain");
            calls.putStringExtra(intent, "android.intent.extra.TITLE", title);
            calls.putBooleanExtra(intent, "android.intent.extra.LOCAL_ONLY", true);
            calls.startActivityForResult(fragment, intent, requestCode);
            return intent;
        }

        private void buildDialog(final Object context) throws Exception {
            Class<?> linear = Class.forName("android.widget.LinearLayout");
            root = construct(linear, Class.forName("android.content.Context"), context);
            call(root, "setOrientation", new Class<?>[] { int.class }, new Object[] { 1 });
            call(root, "setPadding", new Class<?>[] { int.class, int.class, int.class, int.class }, new Object[] { dp(context, 16), dp(context, 8), dp(context, 16), dp(context, 12) });
            int background = color(context, "mine_page_background", 0xfffafafa);
            call(root, "setBackgroundColor", new Class<?>[] { int.class }, new Object[] { background });
            Object bar = construct(linear, Class.forName("android.content.Context"), context);
            call(bar, "setOrientation", new Class<?>[] { int.class }, new Object[] { 0 });
            Object back = text(context, "‹", 32, color(context, "mine_text_primary", 0xff222222));
            styleTextControl(back, context, 56, 17);
            call(back, "setMinWidth", new Class<?>[] { int.class }, new Object[] { dp(context, 48) });
            setClick(back, new Runnable() { @Override public void run() { if (controller != null) controller.back(); } });
            add(bar, back, linearParams(context, -2, -2, 0));
            title = text(context, "本地日志", 20, color(context, "mine_text_primary", 0xff222222));
            styleTextControl(title, context, 56, 16);
            add(bar, title, linearParams(context, 0, -2, 1));
            refreshButton = text(context, "刷新", 16, color(context, "mine_text_primary", 0xff222222));
            styleTextControl(refreshButton, context, 56, 17);
            call(refreshButton, "setMinWidth", new Class<?>[] { int.class }, new Object[] { dp(context, 56) });
            setClick(refreshButton, new Runnable() { @Override public void run() { if (controller != null) controller.refresh(); } });
            add(bar, refreshButton, linearParams(context, -2, -2, 0));
            add(root, bar, linearParams(context, -1, -2, 0));
            Class<?> scroll = Class.forName("android.widget.ScrollView");
            Object scroller = construct(scroll, Class.forName("android.content.Context"), context);
            body = construct(linear, Class.forName("android.content.Context"), context);
            call(body, "setOrientation", new Class<?>[] { int.class }, new Object[] { 1 });
            add(scroller, body, newLayoutParams(-1, -2));
            add(root, scroller, linearParams(context, -1, 0, 1));
            Object window = dialog.getClass().getMethod("getWindow").invoke(dialog);
            if (window != null) {
                try { window.getClass().getMethod("setBackgroundDrawable", Class.forName("android.graphics.drawable.Drawable"))
                    .invoke(window, Class.forName("android.graphics.drawable.ColorDrawable").getConstructor(int.class).newInstance(background)); }
                catch (Throwable ignored) { }
                try { window.getClass().getMethod("setStatusBarColor", int.class).invoke(window, 0); } catch (Throwable ignored) { }
                try { window.getClass().getMethod("setNavigationBarColor", int.class).invoke(window, 0); } catch (Throwable ignored) { }
            }
        }

        private void renderList(PageState state) throws Exception {
            addLabel(SANITIZED_NOTICE, 14, false);
            if (state.result.entries.isEmpty() && !state.result.hasErrors()) addLabel("暂无日志", 16, false);
            for (String error : state.result.sourceErrors) addLabel(error, 14, false);
            for (final LogStore.Entry entry : state.result.entries) {
                String label = entry.fileName + "\n" + entry.kind() + " · " + CrashLog.formatTime(entry.modifiedMillis)
                    + "\n" + entry.sourceLabel;
                Object row = text(activity.get(), label, 15, color(activity.get(), "mine_text_primary", 0xff222222));
                call(row, "setPadding", new Class<?>[] { int.class, int.class, int.class, int.class }, new Object[] { dp(activity.get(), 8), dp(activity.get(), 12), dp(activity.get(), 8), dp(activity.get(), 12) });
                setClick(row, new Runnable() { @Override public void run() { if (controller != null) controller.select(entry); } });
                add(body, row, newLayoutParams(-1, -2));
                addDivider(activity.get());
            }
            if (!state.message.isEmpty() && !(state.result.isEmpty() && !state.result.hasErrors() && "暂无日志".equals(state.message))) addLabel(state.message, 14, false);
        }

        private void renderDetail(PageState state) throws Exception {
            addLabel(SANITIZED_NOTICE, 14, false);
            addLabel(state.selected.kind() + " · " + state.selected.sourceLabel, 14, false);
            Object actions = construct(Class.forName("android.widget.LinearLayout"), Class.forName("android.content.Context"), activity.get());
            call(actions, "setOrientation", new Class<?>[] { int.class }, new Object[] { 0 });
            Object copy = text(activity.get(), "复制", 16, color(activity.get(), "mine_text_primary", 0xff222222));
            styleTextControl(copy, activity.get(), 48, 17);
            setClick(copy, new Runnable() { @Override public void run() { if (controller != null) controller.copySelected(); } });
            Object export = text(activity.get(), "导出", 16, color(activity.get(), "mine_text_primary", 0xff222222));
            styleTextControl(export, activity.get(), 48, 17);
            setClick(export, new Runnable() { @Override public void run() { if (controller != null) controller.exportSelected(cacheDirectory); } });
            add(actions, copy, linearParams(activity.get(), 0, -2, 1));
            add(actions, export, linearParams(activity.get(), 0, -2, 1));
            add(body, actions, newLayoutParams(-1, -2));
            Object text = text(activity.get(), state.preview, 14, color(activity.get(), "mine_text_primary", 0xff222222));
            call(text, "setTextIsSelectable", new Class<?>[] { boolean.class }, new Object[] { true });
            Object typeface = Class.forName("android.graphics.Typeface").getField("MONOSPACE").get(null);
            call(text, "setTypeface", new Class<?>[] { Class.forName("android.graphics.Typeface") }, new Object[] { typeface });
            call(text, "setPadding", new Class<?>[] { int.class, int.class, int.class, int.class }, new Object[] { dp(activity.get(), 4), dp(activity.get(), 12), dp(activity.get(), 4), dp(activity.get(), 12) });
            add(body, text, newLayoutParams(-1, -2));
            if (!state.message.isEmpty()) addLabel(state.message, 14, false);
        }

        private void addLabel(String value, int size, boolean monospace) throws Exception {
            Object view = text(activity.get(), value, size, color(activity.get(), "mine_text_primary", 0xff222222));
            call(view, "setPadding", new Class<?>[] { int.class, int.class, int.class, int.class }, new Object[] { dp(activity.get(), 8), dp(activity.get(), 12), dp(activity.get(), 8), dp(activity.get(), 12) });
            add(body, view, newLayoutParams(-1, -2));
        }
        private void addDivider(Object context) throws Exception {
            Object divider = construct(Class.forName("android.view.View"), Class.forName("android.content.Context"), context);
            call(divider, "setBackgroundColor", new Class<?>[] { int.class }, new Object[] { color(context, "mine_divider", 0xffdddddd) });
            add(body, divider, newLayoutParams(-1, dp(context, 1)));
        }

        private void installBackHandling() {
            if (dialog == null) return;
            int sdk = sdkInt();
            if (sdk >= 33) {
                try {
                    backDispatcher = dialog.getClass().getMethod("getOnBackInvokedDispatcher").invoke(dialog);
                    Class<?> callbackType = Class.forName("android.window.OnBackInvokedCallback");
                    backCallback = Proxy.newProxyInstance(callbackType.getClassLoader(), new Class<?>[] { callbackType },
                        (proxy, method, args) -> { if ("onBackInvoked".equals(method.getName()) && controller != null) controller.back(); return null; });
                    backDispatcher.getClass().getMethod("registerOnBackInvokedCallback", int.class, callbackType).invoke(backDispatcher, 0, backCallback);
                    return;
                } catch (Throwable ignored) { unregisterBack(); }
            }
            try {
                Class<?> keyListener = Class.forName("android.content.DialogInterface$OnKeyListener");
                Object listener = Proxy.newProxyInstance(keyListener.getClassLoader(), new Class<?>[] { keyListener },
                    (proxy, method, args) -> {
                        if ("onKey".equals(method.getName()) && args != null && args.length == 3) {
                            int key = ((Number) args[1]).intValue();
                            Object event = args[2];
                            int action = ((Number) event.getClass().getMethod("getAction").invoke(event)).intValue();
                            if (key == 4 && action == 1 && controller != null) { controller.back(); return Boolean.TRUE; }
                        }
                        return Boolean.FALSE;
                    });
                dialog.getClass().getMethod("setOnKeyListener", keyListener).invoke(dialog, listener);
            } catch (Throwable ignored) { }
        }
        private void unregisterBack() {
            if (backDispatcher != null && backCallback != null) try {
                backDispatcher.getClass().getMethod("unregisterOnBackInvokedCallback", Class.forName("android.window.OnBackInvokedCallback")).invoke(backDispatcher, backCallback);
            } catch (Throwable ignored) { }
            backDispatcher = null; backCallback = null;
        }
        private static void applyInsets(Object context, Object window, Object view) {
            if (sdkInt() >= 30) try { window.getClass().getMethod("setDecorFitsSystemWindows", boolean.class).invoke(window, false); } catch (Throwable ignored) { }
            try {
                Class<?> listenerType = Class.forName("android.view.View$OnApplyWindowInsetsListener");
                final int left = ((Number) view.getClass().getMethod("getPaddingLeft").invoke(view)).intValue();
                final int top = ((Number) view.getClass().getMethod("getPaddingTop").invoke(view)).intValue();
                final int right = ((Number) view.getClass().getMethod("getPaddingRight").invoke(view)).intValue();
                final int bottom = ((Number) view.getClass().getMethod("getPaddingBottom").invoke(view)).intValue();
                Object listener = Proxy.newProxyInstance(listenerType.getClassLoader(), new Class<?>[] { listenerType },
                    (proxy, method, args) -> {
                        if ("onApplyWindowInsets".equals(method.getName())) {
                            Object insets = args[1];
                            int l = ((Number) insets.getClass().getMethod("getSystemWindowInsetLeft").invoke(insets)).intValue();
                            int t = ((Number) insets.getClass().getMethod("getSystemWindowInsetTop").invoke(insets)).intValue();
                            int r = ((Number) insets.getClass().getMethod("getSystemWindowInsetRight").invoke(insets)).intValue();
                            int b = ((Number) insets.getClass().getMethod("getSystemWindowInsetBottom").invoke(insets)).intValue();
                            view.getClass().getMethod("setPadding", int.class, int.class, int.class, int.class).invoke(view, left + l, top + t, right + r, bottom + b);
                            return insets;
                        }
                        return null;
                    });
                view.getClass().getMethod("setOnApplyWindowInsetsListener", listenerType).invoke(view, listener);
                view.getClass().getMethod("requestApplyInsets").invoke(view);
            } catch (Throwable ignored) { }
        }
        private static Object text(Object context, String value, int size, int color) throws Exception {
            Object view = construct(Class.forName("android.widget.TextView"), Class.forName("android.content.Context"), context);
            setText(view, value);
            call(view, "setTextSize", new Class<?>[] { int.class, float.class }, new Object[] { 2, (float) size });
            call(view, "setTextColor", new Class<?>[] { int.class }, new Object[] { color });
            return view;
        }

        private static void styleTextControl(Object view, Object context, int minimumHeightDp, int gravity) throws Exception {
            call(view, "setMinHeight", new Class<?>[] { int.class }, new Object[] { dp(context, minimumHeightDp) });
            call(view, "setPadding", new Class<?>[] { int.class, int.class, int.class, int.class },
                new Object[] { dp(context, 8), dp(context, 8), dp(context, 8), dp(context, 8) });
            call(view, "setGravity", new Class<?>[] { int.class }, new Object[] { gravity });
        }
        private static void setClick(final Object view, final Runnable action) throws Exception {
            Class<?> listenerType = Class.forName("android.view.View$OnClickListener");
            Object listener = Proxy.newProxyInstance(listenerType.getClassLoader(), new Class<?>[] { listenerType },
                (proxy, method, args) -> { if ("onClick".equals(method.getName())) action.run(); return null; });
            view.getClass().getMethod("setOnClickListener", listenerType).invoke(view, listener);
        }
        private static void setText(Object view, String value) throws Exception {
            view.getClass().getMethod("setText", CharSequence.class).invoke(view, value);
        }
        private static void add(Object parent, Object child, Object params) throws Exception {
            parent.getClass().getMethod("addView", Class.forName("android.view.View"), Class.forName("android.view.ViewGroup$LayoutParams"))
                .invoke(parent, child, params);
        }
        private static Object construct(Class<?> type, Class<?> argType, Object arg) throws Exception { return type.getConstructor(argType).newInstance(arg); }
        private static Object newLayoutParams(int width, int height) throws Exception {
            return Class.forName("android.view.ViewGroup$LayoutParams").getConstructor(int.class, int.class).newInstance(width, height);
        }
        private static Object linearParams(Object context, int width, int height, float weight) throws Exception {
            return Class.forName("android.widget.LinearLayout$LayoutParams").getConstructor(int.class, int.class, float.class).newInstance(width, height, weight);
        }
        private static int dp(Object context, int value) {
            try {
                Object resources = context.getClass().getMethod("getResources").invoke(context);
                Object metrics = resources.getClass().getMethod("getDisplayMetrics").invoke(resources);
                float density = metrics.getClass().getField("density").getFloat(metrics);
                return (int) (value * density + 0.5f);
            } catch (Throwable ignored) { return value; }
        }
        private static int color(Object context, String name, int fallback) {
            try {
                String packageName = (String) context.getClass().getMethod("getPackageName").invoke(context);
                Object resources = context.getClass().getMethod("getResources").invoke(context);
                int id = ((Number) resources.getClass().getMethod("getIdentifier", String.class, String.class, String.class).invoke(resources, name, "color", packageName)).intValue();
                if (id == 0) return fallback;
                return ((Number) resources.getClass().getMethod("getColor", int.class).invoke(resources, id)).intValue();
            } catch (Throwable ignored) { return fallback; }
        }
        private static void toast(Object context, String message) {
            try {
                Class<?> toast = Class.forName("android.widget.Toast");
                Object value = toast.getMethod("makeText", Class.forName("android.content.Context"), CharSequence.class, int.class).invoke(null, context, message, 0);
                toast.getMethod("show").invoke(value);
            } catch (Throwable ignored) { }
        }
        private static int sdkInt() {
            try { return Class.forName("android.os.Build$VERSION").getField("SDK_INT").getInt(null); }
            catch (Throwable ignored) { return 0; }
        }
        private static Object call(Object receiver, String name, Class<?>[] types, Object[] args) throws Exception {
            return receiver.getClass().getMethod(name, types).invoke(receiver, args);
        }
    }

    private static final class ReflectiveAndroidCalls implements AndroidCalls {
        @Override public Object newIntent(String action) throws Exception {
            return Class.forName("android.content.Intent").getConstructor(String.class).newInstance(action);
        }
        @Override public void addCategory(Object intent, String category) throws Exception {
            intent.getClass().getMethod("addCategory", String.class).invoke(intent, category);
        }
        @Override public void setType(Object intent, String mimeType) throws Exception {
            intent.getClass().getMethod("setType", String.class).invoke(intent, mimeType);
        }
        @Override public void putStringExtra(Object intent, String key, String value) throws Exception {
            intent.getClass().getMethod("putExtra", String.class, String.class).invoke(intent, key, value);
        }
        @Override public void putBooleanExtra(Object intent, String key, boolean value) throws Exception {
            intent.getClass().getMethod("putExtra", String.class, boolean.class).invoke(intent, key, value);
        }
        @Override public void startActivityForResult(Object fragment, Object intent, int requestCode) throws Exception {
            fragment.getClass().getMethod("startActivityForResult", Class.forName("android.content.Intent"), int.class)
                .invoke(fragment, intent, requestCode);
        }
        @Override public OutputStream openTarget(Object context, Object uri) throws Exception {
            Object resolver = context.getClass().getMethod("getContentResolver").invoke(context);
            return (OutputStream) resolver.getClass().getMethod("openOutputStream", Class.forName("android.net.Uri"), String.class)
                .invoke(resolver, uri, "wt");
        }
        @Override public int deleteTarget(Object context, Object uri) throws Exception {
            Object resolver = context.getClass().getMethod("getContentResolver").invoke(context);
            return ((Number) resolver.getClass().getMethod("delete", Class.forName("android.net.Uri"), String.class, String[].class)
                .invoke(resolver, uri, null, null)).intValue();
        }
    }
}
