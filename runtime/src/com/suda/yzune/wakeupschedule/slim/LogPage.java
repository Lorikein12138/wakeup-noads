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

/** Native-page, local-only log browser. Public methods are the Smali bridge ABI. */
public final class LogPage {
    static final int EXPORT_REQUEST_CODE = 0x6c67;
    static final int RESULT_OK = -1;
    static final String ENTRY_TAG = "wakeup_noads_logs_entry";
    static final String PREVIEW_TRUNCATED = "预览已截断，导出可保存完整日志";
    static final String EMPTY_HINT = "应用崩溃或异常退出时会自动记录";
    private static final Object LOCK = new Object();
    private static final String LOG_EXTRA = "wakeup_noads_log_page";
    private static final String SETTINGS_ACTIVITY = "com.suda.yzune.wakeupschedule.settings.SettingsActivity";
    private static final int FLAG_ACTIVITY_SINGLE_TOP = 0x20000000;
    private static final Map<Object, Controller> CONTROLLERS = new WeakHashMap<Object, Controller>();
    private static final Map<Object, Boolean> FINISHED_ACTIVITIES = new WeakHashMap<Object, Boolean>();
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
    private static volatile PageLaunchCalls pageLaunchCalls = new ReflectivePageLaunchCalls();
    private static volatile AndroidUiCalls androidUiCalls = new ReflectiveAndroidUiCalls();
    private static volatile AndroidCalls androidCalls = new ReflectiveAndroidCalls();

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
        try {
            Object activity = fragment.getClass().getMethod("getActivity").invoke(fragment);
            if (activity == null) return;
            PageLaunchCalls calls = pageLaunchCalls;
            Object intent = calls.newExplicitIntent(activity, calls.settingsActivityClass());
            calls.putBooleanExtra(intent, LOG_EXTRA, true);
            calls.addFlags(intent, FLAG_ACTIVITY_SINGLE_TOP);
            calls.startActivity(fragment, intent);
        } catch (Throwable failure) {
            toastFromFragment(fragment, "日志页暂不可用");
        }
    }

    public static void onActivityResult(Object fragment, int requestCode, int resultCode, Object intent) {
        if (requestCode != EXPORT_REQUEST_CODE) return;
        if (!isLogActivity(fragment)) return;
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

    public static boolean isLogActivity(Object activity) {
        if (activity == null) return false;
        try {
            PageLaunchCalls calls = pageLaunchCalls;
            if (!calls.isSettingsActivity(activity)) return false;
            Object intent = calls.activityIntent(activity);
            return calls.booleanExtraIsTrue(intent, LOG_EXTRA);
        } catch (Throwable ignored) { return false; }
    }

    public static void prepareActivity(Object activity) {
        if (!isLogActivity(activity)) return;
        try { activity.getClass().getMethod("setTitle", CharSequence.class).invoke(activity, "本地日志"); }
        catch (Throwable ignored) { }
    }

    public static void attachActivity(Object activity) {
        if (!isLogActivity(activity)) return;
        Controller controller;
        synchronized (LOCK) {
            controller = CONTROLLERS.get(activity);
            if (controller == null || controller.closed) {
                try {
                    LogStore store = LogStore.forContext(activity);
                    FINISHED_ACTIVITIES.remove(activity);
                    AndroidHost host = new AndroidHost(activity, activity, androidCalls, androidUiCalls);
                    controller = new Controller(activity, store, host);
                    host.controller = controller;
                    CONTROLLERS.put(activity, controller);
                    cleanupOrphanSnapshots((File) activity.getClass().getMethod("getCacheDir").invoke(activity));
                } catch (Throwable failure) {
                    safeToastAndFinish(activity);
                    return;
                }
            }
        }
        controller.present();
    }

    public static boolean onBackPressed(Object activity) {
        if (!isLogActivity(activity)) return false;
        Controller controller;
        synchronized (LOCK) { controller = CONTROLLERS.get(activity); }
        if (controller != null) controller.back();
        else safeFinish(activity);
        return true;
    }

    public static void onDestroy(Object activity) {
        if (!isLogActivity(activity)) return;
        Controller controller;
        synchronized (LOCK) { controller = CONTROLLERS.remove(activity); }
        if (controller != null) controller.detach();
    }

    public static void applyPageInsets(Object activity, Object view, Object insets) {
        if (!isLogActivity(activity)) return;
        Controller controller;
        synchronized (LOCK) { controller = CONTROLLERS.get(activity); }
        if (controller != null && controller.host instanceof AndroidHost) {
            ((AndroidHost) controller.host).applyPageInsets(view, insets);
        }
    }

    static void setPageLaunchCallsForTest(PageLaunchCalls calls) {
        pageLaunchCalls = calls == null ? new ReflectivePageLaunchCalls() : calls;
    }

    static void setAndroidUiCallsForTest(AndroidUiCalls calls) {
        androidUiCalls = calls == null ? new ReflectiveAndroidUiCalls() : calls;
    }

    static void setAndroidCallsForTest(AndroidCalls calls) {
        androidCalls = calls == null ? new ReflectiveAndroidCalls() : calls;
    }

    private static void safeToastAndFinish(Object activity) {
        try { androidUiCalls.toast(activity, "日志页暂不可用"); } catch (Throwable ignored) { }
        safeFinish(activity);
    }

    private static void safeFinish(Object activity) {
        finishActivityOnce(activity, androidUiCalls);
    }

    private static void finishActivityOnce(Object activity, AndroidUiCalls ui) {
        if (activity == null) return;
        synchronized (LOCK) {
            if (FINISHED_ACTIVITIES.containsKey(activity)) return;
            FINISHED_ACTIVITIES.put(activity, Boolean.TRUE);
        }
        try { ui.finish(activity); }
        catch (Throwable ignored) {
            try { activity.getClass().getMethod("finish").invoke(activity); } catch (Throwable ignoredAgain) { }
        }
    }

    interface ControllerHost {
        void executeIo(Runnable task);
        default void executeCancellation(Runnable task) { CANCELLATION.execute(task); }
        void postMain(Runnable task);
        void open();
        void dismiss();
        default void detach() { dismiss(); }
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
                            message = loaded.truncated ? PREVIEW_TRUNCATED : "";
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
                Object activity = owner.get();
                if (activity != null) LogPage.close(activity);
                else close();
            }
        }

        void copySelected() { copy(selected); }

        void copy(final LogStore.Entry frozen) {
            if (closed || frozen == null || !result.entries.contains(frozen)) return;
            if (isBusy()) { host.toast("已有导出正在处理"); return; }
            final long ticket = generation;
            host.executeIo(new Runnable() {
                @Override public void run() {
                    final LogStore.CopyText copied;
                    try { copied = store.copyText(frozen); }
                    catch (final Throwable failure) {
                        host.postMain(new Runnable() { @Override public void run() { if (isCurrent(ticket)) host.toast("复制失败：日志不可读取"); } });
                        return;
                    }
                    host.postMain(new Runnable() {
                        @Override public void run() {
                            if (!isCurrent(ticket)) return;
                            try {
                                host.copy(copied.text);
                                host.toast(copied.truncated ? "已复制部分内容，完整日志请导出" : "已复制");
                            } catch (Throwable failure) { host.toast("复制失败"); }
                        }
                    });
                }
            });
        }

        void exportSelected(File cacheDirectory) { export(selected, cacheDirectory); }

        void export(final LogStore.Entry frozen, final File cacheDirectory) {
            if (closed || frozen == null || !result.entries.contains(frozen)) return;
            if (isBusy()) { host.toast("已有导出正在处理"); return; }
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

        void close() { close(true); }

        void detach() { close(false); }

        private void close(boolean finishPage) {
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
            if (finishPage) host.dismiss();
            else host.detach();
            presented = false;
        }

        private boolean isCurrent(long ticket) {
            return !closed && generation == ticket;
        }
        private void renderIfOpen() { if (!closed && presented) render(); }
        private boolean isBusy() { return session != null && !session.finalized; }
        private boolean isCurrentSessionResult(Pending value) {
            return !closed && session == value && value.token > 0 && generation == value.generation;
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
                    boolean current = generation == value.generation && session == null;
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

    interface PageLaunchCalls {
        Class<?> settingsActivityClass() throws Exception;
        Object newExplicitIntent(Object context, Class<?> targetClass) throws Exception;
        void putBooleanExtra(Object intent, String key, boolean value) throws Exception;
        void addFlags(Object intent, int flags) throws Exception;
        void startActivity(Object fragment, Object intent) throws Exception;
        boolean isSettingsActivity(Object activity) throws Exception;
        Object activityIntent(Object activity) throws Exception;
        boolean booleanExtraIsTrue(Object intent, String key) throws Exception;
    }

    private static final class ReflectivePageLaunchCalls implements PageLaunchCalls {
        @Override public Class<?> settingsActivityClass() throws Exception { return Class.forName(SETTINGS_ACTIVITY); }
        @Override public Object newExplicitIntent(Object context, Class<?> targetClass) throws Exception {
            return Class.forName("android.content.Intent")
                .getConstructor(Class.forName("android.content.Context"), Class.class).newInstance(context, targetClass);
        }
        @Override public void putBooleanExtra(Object intent, String key, boolean value) throws Exception {
            intent.getClass().getMethod("putExtra", String.class, boolean.class).invoke(intent, key, value);
        }
        @Override public void addFlags(Object intent, int flags) throws Exception {
            intent.getClass().getMethod("addFlags", int.class).invoke(intent, flags);
        }
        @Override public void startActivity(Object fragment, Object intent) throws Exception {
            fragment.getClass().getMethod("startActivity", Class.forName("android.content.Intent")).invoke(fragment, intent);
        }
        @Override public boolean isSettingsActivity(Object activity) throws Exception { return settingsActivityClass().isInstance(activity); }
        @Override public Object activityIntent(Object activity) throws Exception {
            return activity.getClass().getMethod("getIntent").invoke(activity);
        }
        @Override public boolean booleanExtraIsTrue(Object intent, String key) throws Exception {
            if (intent == null) return false;
            Object extras = intent.getClass().getMethod("getExtras").invoke(intent);
            if (extras == null) return false;
            Object value = extras.getClass().getMethod("get", String.class).invoke(extras, key);
            return value instanceof Boolean && ((Boolean) value).booleanValue();
        }
    }

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

    static final class ThemeColors {
        final Object background;
        final Object surface;
        final Object onSurface;
        final Object secondary;
        final Object divider;
        final Object primary;
        final Object onPrimary;
        final Object tonal;
        final Object onTonal;
        final int backgroundColor;
        final int surfaceColor;
        final int dividerColor;
        ThemeColors(Object background, Object surface, Object onSurface, Object secondary, Object divider,
                    Object primary, Object onPrimary, Object tonal, Object onTonal,
                    int backgroundColor, int surfaceColor, int dividerColor) {
            this.background = background; this.surface = surface; this.onSurface = onSurface;
            this.secondary = secondary; this.divider = divider; this.primary = primary; this.onPrimary = onPrimary;
            this.tonal = tonal; this.onTonal = onTonal; this.backgroundColor = backgroundColor;
            this.surfaceColor = surfaceColor; this.dividerColor = dividerColor;
        }
        /** Level colors stay recognisable (red / amber / green) and switch to lighter tones on dark backgrounds. */
        int levelColor(int level) {
            boolean dark = luminance(backgroundColor) < 0.5;
            if (level == LogStore.LEVEL_ERROR) return dark ? 0xfff28b82 : 0xffc5221f;
            if (level == LogStore.LEVEL_WARNING) return dark ? 0xfffdd663 : 0xffb06000;
            return dark ? 0xff81c995 : 0xff137333;
        }
        private static double luminance(int color) {
            return (0.299 * ((color >> 16) & 0xff) + 0.587 * ((color >> 8) & 0xff) + 0.114 * (color & 0xff)) / 255.0;
        }
    }

    static final class PageInsets {
        final int left;
        final int top;
        final int right;
        final int systemBottom;
        final int imeBottom;
        PageInsets(int left, int top, int right, int systemBottom, int imeBottom) {
            this.left = left; this.top = top; this.right = right;
            this.systemBottom = systemBottom; this.imeBottom = imeBottom;
        }
    }

    static final class NativePage {
        final Object activity;
        final Object coordinator;
        final Object appBar;
        final Object toolbar;
        final Object recycler;
        final Object root;
        final Object body;
        final Object layoutParams;
        final Object behavior;
        final Object refreshButton;
        NativePage(Object activity, Object coordinator, Object appBar, Object toolbar, Object recycler,
                   Object root, Object body, Object layoutParams, Object behavior, Object refreshButton) {
            this.activity = activity; this.coordinator = coordinator; this.appBar = appBar; this.toolbar = toolbar;
            this.recycler = recycler; this.root = root; this.body = body; this.layoutParams = layoutParams; this.behavior = behavior;
            this.refreshButton = refreshButton;
        }
    }

    interface AndroidUiCalls {
        Object invoke(Object receiver, String method, String[] parameterTypes, Object[] arguments) throws Exception;
        Object construct(String className, String[] parameterTypes, Object[] arguments) throws Exception;
        boolean isInstance(Object value, String className) throws Exception;
        Object staticField(String className, String name) throws Exception;
        Object clickListener(Runnable callback) throws Exception;
        float density(Object context) throws Exception;
        int sdkInt();
        Object registerBack(Object activity, Runnable callback) throws Exception;
        void unregisterBack(Object activity, Object registration) throws Exception;
        PageInsets readInsets(Object insets) throws Exception;
        int[] padding(Object view) throws Exception;
        void setPadding(Object view, int left, int top, int right, int bottom) throws Exception;
        boolean isAttached(Object view) throws Exception;
        void requestApplyInsets(Object view) throws Exception;
        void finish(Object activity) throws Exception;
        void toast(Object activity, String message) throws Exception;
    }

    static final class AndroidHost implements ControllerHost {
        private final WeakReference<Object> owner;
        private final WeakReference<Object> activity;
        private final AndroidCalls calls;
        private final AndroidUiCalls ui;
        private Controller controller;
        private NativePage page;
        private ThemeColors colors;
        private Object backRegistration;
        private int[] rootBasePadding;
        private int[] bodyBasePadding;
        private boolean detached;
        private boolean failed;
        private boolean finished;
        private File cacheDirectory;

        AndroidHost(Object owner, Object activity) { this(owner, activity, new ReflectiveAndroidCalls(), androidUiCalls); }
        AndroidHost(Object owner, Object activity, AndroidCalls calls) { this(owner, activity, calls, androidUiCalls); }
        AndroidHost(Object owner, Object activity, AndroidCalls calls, AndroidUiCalls ui) {
            this.owner = new WeakReference<Object>(owner);
            this.activity = new WeakReference<Object>(activity);
            this.calls = calls;
            this.ui = ui;
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
            if (context == null || page != null || detached || failed) return;
            try {
                colors = resolveThemeColors(context, ui);
                page = NativePageUi.openPage(context, colors, new Runnable() {
                    @Override public void run() { if (controller != null) controller.back(); }
                }, new Runnable() {
                    @Override public void run() { if (controller != null) controller.refresh(); }
                }, ui);
                if (page == null || page.root == null || page.body == null) throw new IOException("日志页不可用");
                rootBasePadding = ui.padding(page.root);
                bodyBasePadding = ui.padding(page.body);
                if (ui.sdkInt() >= 33) backRegistration = ui.registerBack(context, new Runnable() {
                    @Override public void run() { if (controller != null) controller.back(); }
                });
                ui.requestApplyInsets(page.root);
            } catch (Throwable failure) { failPage(); }
        }
        @Override public void dismiss() {
            releasePage();
            Object context = activity.get();
            if (!finished && context != null) {
                finished = true;
                finishActivityOnce(context, ui);
            }
        }
        static void toast(Object context, String message) { try { androidUiCalls.toast(context, message); } catch (Throwable ignored) { } }
        @Override public void detach() {
            detached = true;
            releasePage();
        }
        private void releasePage() {
            Object context = activity.get();
            if (context != null && backRegistration != null) {
                Object registration = backRegistration;
                backRegistration = null;
                try { ui.unregisterBack(context, registration); } catch (Throwable ignored) { }
            } else backRegistration = null;
            if (page != null) {
                NativePage previous = page;
                page = null;
                try { NativePageUi.detachPage(previous, ui); } catch (Throwable ignored) { }
            }
            rootBasePadding = null;
            bodyBasePadding = null;
            colors = null;
        }
        private void failPage() {
            if (failed) return;
            failed = true;
            releasePage();
            Object context = activity.get();
            if (context == null) return;
            try { ui.toast(context, "日志页暂不可用"); } catch (Throwable ignored) { }
            if (!finished) {
                finished = true;
                finishActivityOnce(context, ui);
            }
        }
        @Override public void render(final PageState state) {
            if (page == null || colors == null || detached || failed) return;
            try {
                NativePageUi.renderPage(page, state, colors, controller, cacheDirectory, ui);
            } catch (Throwable failure) { failPage(); }
        }
        @Override public void toast(String message) {
            Object context = activity.get();
            if (context != null) try { ui.toast(context, message); } catch (Throwable ignored) { }
        }
        void applyPageInsets(Object callbackView, Object insets) {
            if (page == null || detached || failed || insets == null) return;
            try {
                if (!ui.isAttached(page.root) || rootBasePadding == null || bodyBasePadding == null) return;
                PageInsets value = ui.readInsets(insets);
                if (value == null) return;
                pagePadding(page.root, value.left, rootBasePadding[1], value.right, value.imeBottom);
                int contentBottom = bodyBasePadding[3] + (value.imeBottom == 0 ? value.systemBottom : 0);
                pagePadding(page.body, bodyBasePadding[0], bodyBasePadding[1], bodyBasePadding[2], contentBottom);
            } catch (Throwable ignored) { }
        }
        private void pagePadding(Object view, int left, int top, int right, int bottom) throws Exception {
            ui.setPadding(view, left, top, right, bottom);
        }
        @Override public void copy(String text) throws Exception {
            Object context = activity.get();
            if (context == null) throw new IOException("宿主已关闭");
            Object manager = context.getClass().getMethod("getSystemService", String.class).invoke(context, "clipboard");
            Class<?> clipData = Class.forName("android.content.ClipData");
            Object clip = clipData.getMethod("newPlainText", CharSequence.class, CharSequence.class).invoke(null, "wakeup-noads-log", text);
            manager.getClass().getMethod("setPrimaryClip", clipData).invoke(manager, clip);
        }
        @Override public void launchDocument(String title, int requestCode) throws Exception {
            Object activityOwner = owner.get();
            Object context = activity.get();
            if (activityOwner == null || context == null || activityOwner != context) throw new IOException("宿主已关闭");
            launchDocumentRequest(calls, activityOwner, title, requestCode);
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
        private static Object launchDocumentRequest(AndroidCalls calls, Object activity, String title, int requestCode) throws Exception {
            Object intent = calls.newIntent("android.intent.action.CREATE_DOCUMENT");
            calls.addCategory(intent, "android.intent.category.OPENABLE");
            calls.setType(intent, "text/plain");
            calls.putStringExtra(intent, "android.intent.extra.TITLE", title);
            calls.putBooleanExtra(intent, "android.intent.extra.LOCAL_ONLY", true);
            calls.startActivityForResult(activity, intent, requestCode);
            return intent;
        }
    }

    private static ThemeColors resolveThemeColors(Object context, AndroidUiCalls ui) throws Exception {
        String packageName = String.valueOf(ui.invoke(context, "getPackageName", new String[0], new Object[0]));
        Object background = resolveThemeColorStateList(context, "android", "colorBackground", ui);
        Object surface = resolveThemeColorStateList(context, packageName, "colorSurface", ui);
        Object onSurface = resolveThemeColorStateList(context, packageName, "colorOnSurface", ui);
        Object secondary = resolveThemeColorStateList(context, packageName, "colorOnSurfaceVariant", ui);
        Object divider = resolveThemeColorStateList(context, packageName, "colorOutlineVariant", ui);
        Object primary = resolveThemeColorStateList(context, packageName, "colorPrimary", ui);
        Object onPrimary = resolveThemeColorStateList(context, packageName, "colorOnPrimary", ui);
        Object tonal = resolveThemeColorStateList(context, packageName, "colorSecondaryContainer", ui);
        Object onTonal = resolveThemeColorStateList(context, packageName, "colorOnSecondaryContainer", ui);
        return new ThemeColors(background, surface, onSurface, secondary, divider, primary, onPrimary, tonal, onTonal,
            ((Number) ui.invoke(background, "getDefaultColor", new String[0], new Object[0])).intValue(),
            ((Number) ui.invoke(surface, "getDefaultColor", new String[0], new Object[0])).intValue(),
            ((Number) ui.invoke(divider, "getDefaultColor", new String[0], new Object[0])).intValue());
    }

    private static Object resolveThemeColorStateList(Object context, String resourcePackage, String attribute,
                                                      AndroidUiCalls ui) throws Exception {
        Object resources = ui.invoke(context, "getResources", new String[0], new Object[0]);
        int id = ((Number) ui.invoke(resources, "getIdentifier", new String[] {
            "java.lang.String", "java.lang.String", "java.lang.String"
        }, new Object[] { attribute, "attr", resourcePackage })).intValue();
        if (id == 0) throw new IOException("主题属性不可用");
        Object theme = ui.invoke(context, "getTheme", new String[0], new Object[0]);
        Object typed = ui.invoke(theme, "obtainStyledAttributes", new String[] { "[I" },
            new Object[] { new int[] { id } });
        try {
            Object value = ui.invoke(typed, "getColorStateList", new String[] { "int" }, new Object[] { 0 });
            if (value == null) throw new IOException("主题颜色不可用");
            return value;
        } finally { ui.invoke(typed, "recycle", new String[0], new Object[0]); }
    }

    private static final class NativePageUi {
        private static final String VIEW = "android.view.View";
        private static final String VIEW_GROUP = "android.view.ViewGroup";
        private static final String VIEW_PARAMS = "android.view.ViewGroup$LayoutParams";
        private static final String CONTEXT = "android.content.Context";
        private static final String COLOR_STATE_LIST = "android.content.res.ColorStateList";
        private static final String APP_BAR = "com.google.android.material.appbar.AppBarLayout";
        private static final String TOOLBAR = "com.google.android.material.appbar.MaterialToolbar";
        private static final String RECYCLER = "androidx.recyclerview.widget.RecyclerView";
        private static final String DRAWABLE = "android.graphics.drawable.Drawable";
        private static final int GRAVITY_CENTER = 17;
        private static final int GRAVITY_CENTER_VERTICAL = 16;
        private static final int GRAVITY_END_VERTICAL = 0x800015;

        static NativePage openPage(Object activity, ThemeColors colors, Runnable toolbarBack, Runnable refresh,
                                   AndroidUiCalls ui) throws Exception {
            Object coordinator = invoke(ui, activity, "o00O0O");
            Object recycler = invoke(ui, activity, "o0OoOo0");
            if (coordinator == null || recycler == null || !ui.isInstance(recycler, RECYCLER)
                || invoke(ui, recycler, "getParent") != coordinator) throw new IOException("原生页面容器不可用");

            Object appBar = null;
            int childCount = ((Number) invoke(ui, coordinator, "getChildCount")).intValue();
            for (int index = 0; index < childCount; index++) {
                Object child = invoke(ui, coordinator, "getChildAt", new String[] { "int" }, new Object[] { index });
                if (ui.isInstance(child, APP_BAR)) {
                    if (appBar != null) throw new IOException("原生页面容器不可用");
                    appBar = child;
                }
            }
            Object toolbar = appBar == null ? null : findDescendant(appBar, TOOLBAR, ui);
            if (appBar == null || toolbar == null || invoke(ui, appBar, "getParent") != coordinator
                || invoke(ui, toolbar, "getParent") == null) throw new IOException("原生页面容器不可用");

            Object params = invoke(ui, recycler, "getLayoutParams");
            String coordinatorParams = "androidx.coordinatorlayout.widget.CoordinatorLayout$LayoutParams";
            String coordinatorBehavior = "androidx.coordinatorlayout.widget.CoordinatorLayout$Behavior";
            if (params == null || !ui.isInstance(params, coordinatorParams)) throw new IOException("原生页面布局不可用");
            Object behavior = invoke(ui, params, "getBehavior");
            if (behavior != null) invoke(ui, params, "setBehavior", new String[] { coordinatorBehavior }, new Object[] { behavior });

            Object scroll = construct(ui, "androidx.core.widget.NestedScrollView", CONTEXT, activity);
            invoke(ui, scroll, "setFillViewport", new String[] { "boolean" }, new Object[] { Boolean.TRUE });
            invoke(ui, scroll, "setClipToPadding", new String[] { "boolean" }, new Object[] { Boolean.TRUE });
            invoke(ui, scroll, "setBackgroundColor", new String[] { "int" }, new Object[] { colors.backgroundColor });
            Object body = construct(ui, "android.widget.LinearLayout", CONTEXT, activity);
            invoke(ui, body, "setOrientation", new String[] { "int" }, new Object[] { 1 });
            invoke(ui, body, "setPadding", new String[] { "int", "int", "int", "int" },
                new Object[] { dp(activity, 16, ui), dp(activity, 8, ui), dp(activity, 16, ui), dp(activity, 12, ui) });
            invoke(ui, body, "setClipToPadding", new String[] { "boolean" }, new Object[] { Boolean.TRUE });
            add(ui, scroll, body, newLayoutParams(ui, -1, -2));

            Object recyclerParent = invoke(ui, recycler, "getParent");
            invoke(ui, recyclerParent, "removeView", new String[] { VIEW }, new Object[] { recycler });
            invoke(ui, scroll, "setLayoutParams", new String[] { VIEW_PARAMS }, new Object[] { params });
            invoke(ui, coordinator, "addView", new String[] { VIEW, VIEW_PARAMS }, new Object[] { scroll, params });
            invoke(ui, toolbar, "setTitle", new String[] { "java.lang.CharSequence" }, new Object[] { "本地日志" });
            setNavigationClick(ui, toolbar, toolbarBack);
            Object refreshButton = iconButton(activity, "ic_outline_refresh_24", "刷新", colors.onSurface,
                "selectableItemBackgroundBorderless", ui);
            setClick(ui, refreshButton, refresh);
            int iconSize = dp(activity, 48, ui);
            Object toolbarParams = ui.construct("androidx.appcompat.widget.Toolbar$LayoutParams",
                new String[] { "int", "int", "int" }, new Object[] { iconSize, iconSize, GRAVITY_END_VERTICAL });
            add(ui, toolbar, refreshButton, toolbarParams);
            return new NativePage(activity, coordinator, appBar, toolbar, recycler, scroll, body, params, behavior, refreshButton);
        }

        static void renderPage(NativePage page, PageState state, ThemeColors colors, Controller controller,
                               File cacheDirectory, AndroidUiCalls ui) throws Exception {
            invoke(ui, page.body, "removeAllViews");
            boolean detail = state.detail && state.selected != null;
            invoke(ui, page.toolbar, "setTitle", new String[] { "java.lang.CharSequence" },
                new Object[] { detail ? "日志详情" : "本地日志" });
            invoke(ui, page.refreshButton, "setVisibility", new String[] { "int" }, new Object[] { detail ? 8 : 0 });
            if (detail) renderDetail(page, state, colors, controller, cacheDirectory, ui);
            else renderList(page, state, colors, controller, cacheDirectory, ui);
        }

        private static void renderList(NativePage page, PageState state, ThemeColors colors, final Controller controller,
                                       final File cacheDirectory, AndroidUiCalls ui) throws Exception {
            Object context = page.activity;
            LogStore.Result result = state.result;
            if (result.hasErrors()) addWarning(page, result.stateText(), colors, ui);
            if (state.exportPending && !state.message.isEmpty()) addLabel(page, state.message, 14, colors.secondary, ui);
            if (!result.entries.isEmpty()) {
                Object group = card(context, colors, ui);
                Object rows = linear(context, 1, ui);
                add(ui, group, rows, newLayoutParams(ui, -1, -2));
                boolean first = true;
                for (final LogStore.Entry entry : result.entries) {
                    if (!first) addDivider(context, rows, colors.dividerColor, 16, ui);
                    first = false;
                    add(ui, rows, entryRow(context, entry, colors, controller, cacheDirectory, ui), newLayoutParams(ui, -1, -2));
                }
                add(ui, page.body, group, cardParams(context, ui));
            } else if (result.readableSources > 0 || !result.hasErrors()) {
                addEmptyState(page, colors, ui);
            }
            String packageName = String.valueOf(invoke(ui, context, "getPackageName"));
            Object footer = text(context, "保存位置：Android/data/" + packageName + "/files/" + CrashLog.LOG_DIRECTORY + "/",
                12, colors.secondary, ui);
            padding(ui, footer, dp(context, 8, ui), dp(context, 12, ui), dp(context, 8, ui), dp(context, 8, ui));
            add(ui, page.body, footer, newLayoutParams(ui, -1, -2));
        }

        private static Object entryRow(Object context, final LogStore.Entry entry, ThemeColors colors, final Controller controller,
                                       final File cacheDirectory, AndroidUiCalls ui) throws Exception {
            LogStore.Summary summary = entry.summary();
            Object row = linear(context, 0, ui);
            invoke(ui, row, "setGravity", new String[] { "int" }, new Object[] { GRAVITY_CENTER_VERTICAL });
            invoke(ui, row, "setMinimumHeight", new String[] { "int" }, new Object[] { dp(context, 64, ui) });
            padding(ui, row, dp(context, 16, ui), dp(context, 10, ui), dp(context, 4, ui), dp(context, 10, ui));
            setRipple(context, row, "selectableItemBackground", ui);
            setClick(ui, row, new Runnable() { @Override public void run() { if (controller != null) controller.select(entry); } });

            Object texts = linear(context, 1, ui);
            Object headline = linear(context, 0, ui);
            invoke(ui, headline, "setGravity", new String[] { "int" }, new Object[] { GRAVITY_CENTER_VERTICAL });
            add(ui, headline, levelTag(context, summary.level, colors, ui), linearParams(ui, -2, -2, 0));
            Object title = text(context, summary.title, 16, colors.onSurface, ui);
            add(ui, headline, title, marginParams(context, -2, 8, 0, ui));
            add(ui, texts, headline, newLayoutParams(ui, -1, -2));
            String subtitle = shortTime(entry.modifiedMillis) + " · " + entry.sourceLabel
                + (summary.recordCount() > 1 ? " · 共 " + summary.recordCount() + " 条记录" : "");
            Object subtitleView = text(context, subtitle, 13, colors.secondary, ui);
            add(ui, texts, subtitleView, marginParams(context, -1, 0, 4, ui));
            add(ui, row, texts, linearParams(ui, 0, -2, 1));

            int iconSize = dp(context, 48, ui);
            Object copyButton = iconButton(context, "ic_twotone_file_copy_24", "复制", colors.secondary,
                "selectableItemBackgroundBorderless", ui);
            setClick(ui, copyButton, new Runnable() { @Override public void run() { if (controller != null) controller.copy(entry); } });
            Object exportButton = iconButton(context, "ic_outline_save_alt_24", "导出", colors.secondary,
                "selectableItemBackgroundBorderless", ui);
            setClick(ui, exportButton, new Runnable() {
                @Override public void run() { if (controller != null) controller.export(entry, cacheDirectory); }
            });
            add(ui, row, copyButton, linearParams(ui, iconSize, iconSize, 0));
            add(ui, row, exportButton, linearParams(ui, iconSize, iconSize, 0));
            return row;
        }

        private static void addWarning(NativePage page, String value, ThemeColors colors, AndroidUiCalls ui) throws Exception {
            Object context = page.activity;
            int color = colors.levelColor(LogStore.LEVEL_WARNING);
            Object line = linear(context, 0, ui);
            invoke(ui, line, "setGravity", new String[] { "int" }, new Object[] { GRAVITY_CENTER_VERTICAL });
            padding(ui, line, dp(context, 8, ui), dp(context, 8, ui), dp(context, 8, ui), dp(context, 8, ui));
            Object icon = image(context, "mtrl_ic_error", ui);
            invoke(ui, icon, "setColorFilter", new String[] { "int" }, new Object[] { color });
            int iconSize = dp(context, 20, ui);
            add(ui, line, icon, linearParams(ui, iconSize, iconSize, 0));
            Object label = construct(ui, "android.widget.TextView", CONTEXT, context);
            setText(ui, label, value);
            invoke(ui, label, "setTextSize", new String[] { "int", "float" }, new Object[] { 2, 14.0f });
            invoke(ui, label, "setTextColor", new String[] { "int" }, new Object[] { color });
            Object labelParams = linearParams(ui, 0, -2, 1);
            margins(ui, labelParams, dp(context, 8, ui), 0, 0, 0);
            add(ui, line, label, labelParams);
            add(ui, page.body, line, newLayoutParams(ui, -1, -2));
        }

        private static void addEmptyState(NativePage page, ThemeColors colors, AndroidUiCalls ui) throws Exception {
            Object context = page.activity;
            Object box = linear(context, 1, ui);
            invoke(ui, box, "setGravity", new String[] { "int" }, new Object[] { GRAVITY_CENTER });
            padding(ui, box, 0, dp(context, 48, ui), 0, dp(context, 48, ui));
            Object icon = image(context, "ic_outline_sticky_note_2_24", ui);
            invoke(ui, icon, "setImageTintList", new String[] { COLOR_STATE_LIST }, new Object[] { colors.secondary });
            int iconSize = dp(context, 48, ui);
            add(ui, box, icon, linearParams(ui, iconSize, iconSize, 0));
            Object title = text(context, "暂无日志", 16, colors.onSurface, ui);
            add(ui, box, title, marginParams(context, -2, 0, 12, ui));
            Object hint = text(context, EMPTY_HINT, 14, colors.secondary, ui);
            invoke(ui, hint, "setGravity", new String[] { "int" }, new Object[] { GRAVITY_CENTER });
            add(ui, box, hint, marginParams(context, -2, 0, 4, ui));
            add(ui, page.body, box, linearParams(ui, -1, 0, 1));
        }

        private static void renderDetail(NativePage page, PageState state, ThemeColors colors, final Controller controller,
                                         final File cacheDirectory, AndroidUiCalls ui) throws Exception {
            Object context = page.activity;
            final LogStore.Entry entry = state.selected;
            LogStore.Summary summary = entry.summary();

            Object info = card(context, colors, ui);
            Object rows = linear(context, 1, ui);
            padding(ui, rows, dp(context, 16, ui), dp(context, 6, ui), dp(context, 16, ui), dp(context, 6, ui));
            Object type = linear(context, 0, ui);
            invoke(ui, type, "setGravity", new String[] { "int" }, new Object[] { GRAVITY_CENTER_VERTICAL });
            add(ui, type, levelTag(context, summary.level, colors, ui), linearParams(ui, -2, -2, 0));
            add(ui, type, text(context, summary.title, 14, colors.onSurface, ui), marginParams(context, -2, 8, 0, ui));
            addInfoRow(context, rows, "类型", type, colors, ui);
            if (summary.recordCount() > 1) {
                StringBuilder records = new StringBuilder();
                for (int index = summary.records.size() - 1; index >= 0; index--) {
                    LogStore.Record record = summary.records.get(index);
                    if (records.length() > 0) records.append('\n');
                    records.append(record.time).append("  ").append(record.title);
                }
                addInfoRow(context, rows, "记录", text(context, records.toString(), 14, colors.onSurface, ui), colors, ui);
            }
            addInfoRow(context, rows, "时间", text(context, fullTime(entry.modifiedMillis), 14, colors.onSurface, ui), colors, ui);
            addInfoRow(context, rows, "来源", text(context, entry.sourceLabel, 14, colors.onSurface, ui), colors, ui);
            addInfoRow(context, rows, "文件", text(context, entry.fileName, 14, colors.onSurface, ui), colors, ui);
            add(ui, info, rows, newLayoutParams(ui, -1, -2));
            add(ui, page.body, info, cardParams(context, ui));

            Object actions = linear(context, 0, ui);
            padding(ui, actions, dp(context, 8, ui), dp(context, 8, ui), dp(context, 8, ui), dp(context, 4, ui));
            Object copyButton = button(context, "复制", colors.onTonal, colors.tonal, ui);
            Object exportButton = button(context, "导出", colors.onPrimary, colors.primary, ui);
            setClick(ui, copyButton, new Runnable() { @Override public void run() { if (controller != null) controller.copy(entry); } });
            setClick(ui, exportButton, new Runnable() {
                @Override public void run() { if (controller != null) controller.export(entry, cacheDirectory); }
            });
            Object copyParams = linearParams(ui, 0, -2, 1);
            margins(ui, copyParams, 0, 0, dp(context, 6, ui), 0);
            Object exportParams = linearParams(ui, 0, -2, 1);
            margins(ui, exportParams, dp(context, 6, ui), 0, 0, 0);
            add(ui, actions, copyButton, copyParams);
            add(ui, actions, exportButton, exportParams);
            add(ui, page.body, actions, newLayoutParams(ui, -1, -2));

            Object section = text(context, "内容预览", 14, colors.secondary, ui);
            padding(ui, section, dp(context, 8, ui), dp(context, 12, ui), dp(context, 8, ui), dp(context, 4, ui));
            add(ui, page.body, section, newLayoutParams(ui, -1, -2));
            boolean hasPreview = !state.preview.isEmpty();
            Object previewCard = card(context, colors, ui);
            Object preview = text(context, hasPreview ? state.preview : state.message, hasPreview ? 12 : 14,
                hasPreview ? colors.onSurface : colors.secondary, ui);
            if (hasPreview) {
                invoke(ui, preview, "setTextIsSelectable", new String[] { "boolean" }, new Object[] { Boolean.TRUE });
                Object typeface = ui.staticField("android.graphics.Typeface", "MONOSPACE");
                invoke(ui, preview, "setTypeface", new String[] { "android.graphics.Typeface" }, new Object[] { typeface });
            }
            padding(ui, preview, dp(context, 12, ui), dp(context, 12, ui), dp(context, 12, ui), dp(context, 12, ui));
            add(ui, previewCard, preview, newLayoutParams(ui, -1, -2));
            add(ui, page.body, previewCard, cardParams(context, ui));
            if (hasPreview && !state.message.isEmpty()) addLabel(page, state.message, 13, colors.secondary, ui);
        }

        private static void addInfoRow(Object context, Object rows, String name, Object value, ThemeColors colors,
                                       AndroidUiCalls ui) throws Exception {
            Object row = linear(context, 0, ui);
            padding(ui, row, 0, dp(context, 10, ui), 0, dp(context, 10, ui));
            Object key = text(context, name, 14, colors.secondary, ui);
            add(ui, row, key, linearParams(ui, dp(context, 56, ui), -2, 0));
            add(ui, row, value, linearParams(ui, 0, -2, 1));
            add(ui, rows, row, newLayoutParams(ui, -1, -2));
        }

        static void detachPage(NativePage page, AndroidUiCalls ui) throws Exception {
            setNavigationClick(ui, page.toolbar, null);
            if (page.refreshButton != null && invoke(ui, page.refreshButton, "getParent") == page.toolbar) {
                invoke(ui, page.toolbar, "removeView", new String[] { VIEW }, new Object[] { page.refreshButton });
            }
            Object parent = invoke(ui, page.root, "getParent");
            if (parent == page.coordinator) invoke(ui, parent, "removeView", new String[] { VIEW }, new Object[] { page.root });
        }

        private static Object findDescendant(Object root, String className, AndroidUiCalls ui) throws Exception {
            if (ui.isInstance(root, className)) return root;
            int count = ((Number) invoke(ui, root, "getChildCount")).intValue();
            Object found = null;
            for (int index = 0; index < count; index++) {
                Object child = invoke(ui, root, "getChildAt", new String[] { "int" }, new Object[] { index });
                Object candidate = findDescendant(child, className, ui);
                if (candidate != null) {
                    if (found != null) throw new IOException("原生页面容器不可用");
                    found = candidate;
                }
            }
            return found;
        }
        private static Object cardParams(Object context, AndroidUiCalls ui) throws Exception {
            Object params = linearParams(ui, -1, -2, 0);
            margins(ui, params, 0, dp(context, 4, ui), 0, dp(context, 8, ui));
            return params;
        }
        private static Object marginParams(Object context, int width, int startDp, int topDp, AndroidUiCalls ui) throws Exception {
            Object params = linearParams(ui, width, -2, 0);
            margins(ui, params, dp(context, startDp, ui), dp(context, topDp, ui), 0, 0);
            return params;
        }
        private static void margins(AndroidUiCalls ui, Object params, int left, int top, int right, int bottom) throws Exception {
            invoke(ui, params, "setMargins", new String[] { "int", "int", "int", "int" }, new Object[] { left, top, right, bottom });
        }
        private static void padding(AndroidUiCalls ui, Object view, int left, int top, int right, int bottom) throws Exception {
            invoke(ui, view, "setPadding", new String[] { "int", "int", "int", "int" }, new Object[] { left, top, right, bottom });
        }
        private static void addLabel(NativePage page, String value, int size, Object color, AndroidUiCalls ui) throws Exception {
            Object label = text(page.activity, value, size, color, ui);
            padding(ui, label, dp(page.activity, 8, ui), dp(page.activity, 8, ui), dp(page.activity, 8, ui), dp(page.activity, 8, ui));
            add(ui, page.body, label, newLayoutParams(ui, -1, -2));
        }
        private static void addDivider(Object context, Object parent, int color, int insetDp, AndroidUiCalls ui) throws Exception {
            Object divider = construct(ui, VIEW, CONTEXT, context);
            invoke(ui, divider, "setBackgroundColor", new String[] { "int" }, new Object[] { color });
            Object params = linearParams(ui, -1, Math.max(1, dp(context, 1, ui) / 2), 0);
            margins(ui, params, dp(context, insetDp, ui), 0, 0, 0);
            add(ui, parent, divider, params);
        }
        private static Object linear(Object context, int orientation, AndroidUiCalls ui) throws Exception {
            Object layout = construct(ui, "android.widget.LinearLayout", CONTEXT, context);
            invoke(ui, layout, "setOrientation", new String[] { "int" }, new Object[] { orientation });
            return layout;
        }
        private static Object card(Object context, ThemeColors colors, AndroidUiCalls ui) throws Exception {
            Object card = construct(ui, "com.google.android.material.card.MaterialCardView", CONTEXT, context);
            invoke(ui, card, "setCardBackgroundColor", new String[] { COLOR_STATE_LIST }, new Object[] { colors.surface });
            invoke(ui, card, "setRadius", new String[] { "float" }, new Object[] { (float) dp(context, 16, ui) });
            invoke(ui, card, "setCardElevation", new String[] { "float" }, new Object[] { 0.0f });
            invoke(ui, card, "setStrokeWidth", new String[] { "int" }, new Object[] { 0 });
            return card;
        }
        private static Object levelTag(Object context, int level, ThemeColors colors, AndroidUiCalls ui) throws Exception {
            int color = colors.levelColor(level);
            Object tag = construct(ui, "android.widget.TextView", CONTEXT, context);
            setText(ui, tag, LogStore.Summary.levelText(level));
            invoke(ui, tag, "setTextSize", new String[] { "int", "float" }, new Object[] { 2, 12.0f });
            invoke(ui, tag, "setTextColor", new String[] { "int" }, new Object[] { color });
            padding(ui, tag, dp(context, 6, ui), dp(context, 1, ui), dp(context, 6, ui), dp(context, 1, ui));
            Object shape = ui.construct("android.graphics.drawable.GradientDrawable", new String[0], new Object[0]);
            invoke(ui, shape, "setCornerRadius", new String[] { "float" }, new Object[] { (float) dp(context, 6, ui) });
            invoke(ui, shape, "setColor", new String[] { "int" }, new Object[] { (color & 0x00ffffff) | 0x29000000 });
            invoke(ui, tag, "setBackground", new String[] { DRAWABLE }, new Object[] { shape });
            return tag;
        }
        private static Object image(Object context, String drawable, AndroidUiCalls ui) throws Exception {
            Object view = construct(ui, "android.widget.ImageView", CONTEXT, context);
            invoke(ui, view, "setImageResource", new String[] { "int" }, new Object[] { resourceId(context, drawable, "drawable", ui) });
            return view;
        }
        private static Object iconButton(Object context, String drawable, String description, Object tint, String ripple,
                                         AndroidUiCalls ui) throws Exception {
            Object button = construct(ui, "android.widget.ImageButton", CONTEXT, context);
            invoke(ui, button, "setImageResource", new String[] { "int" }, new Object[] { resourceId(context, drawable, "drawable", ui) });
            invoke(ui, button, "setImageTintList", new String[] { COLOR_STATE_LIST }, new Object[] { tint });
            invoke(ui, button, "setContentDescription", new String[] { "java.lang.CharSequence" }, new Object[] { description });
            padding(ui, button, dp(context, 12, ui), dp(context, 12, ui), dp(context, 12, ui), dp(context, 12, ui));
            setRipple(context, button, ripple, ui);
            return button;
        }
        private static void setRipple(Object context, Object view, String attribute, AndroidUiCalls ui) throws Exception {
            Object drawable = null;
            String packageName = String.valueOf(invoke(ui, context, "getPackageName"));
            int id = resourceId(context, packageName, attribute, "attr", ui);
            if (id != 0) {
                Object theme = invoke(ui, context, "getTheme");
                Object typed = invoke(ui, theme, "obtainStyledAttributes", new String[] { "[I" }, new Object[] { new int[] { id } });
                try { drawable = invoke(ui, typed, "getDrawable", new String[] { "int" }, new Object[] { 0 }); }
                finally { invoke(ui, typed, "recycle"); }
            }
            if (drawable != null) invoke(ui, view, "setBackground", new String[] { DRAWABLE }, new Object[] { drawable });
            else invoke(ui, view, "setBackgroundColor", new String[] { "int" }, new Object[] { 0 });
        }
        private static int resourceId(Object context, String name, String type, AndroidUiCalls ui) throws Exception {
            int id = resourceId(context, String.valueOf(invoke(ui, context, "getPackageName")), name, type, ui);
            if (id == 0) throw new IOException("页面资源不可用");
            return id;
        }
        private static int resourceId(Object context, String resourcePackage, String name, String type, AndroidUiCalls ui) throws Exception {
            Object resources = invoke(ui, context, "getResources");
            return ((Number) invoke(ui, resources, "getIdentifier", new String[] {
                "java.lang.String", "java.lang.String", "java.lang.String"
            }, new Object[] { name, type, resourcePackage })).intValue();
        }
        private static Object button(Object context, String value, Object textColor, Object background, AndroidUiCalls ui) throws Exception {
            Object button = construct(ui, "com.google.android.material.button.MaterialButton", CONTEXT, context);
            setText(ui, button, value);
            invoke(ui, button, "setTextSize", new String[] { "int", "float" }, new Object[] { 2, 16.0f });
            invoke(ui, button, "setMinimumHeight", new String[] { "int" }, new Object[] { dp(context, 48, ui) });
            invoke(ui, button, "setTextColor", new String[] { COLOR_STATE_LIST }, new Object[] { textColor });
            invoke(ui, button, "setBackgroundTintList", new String[] { COLOR_STATE_LIST }, new Object[] { background });
            invoke(ui, button, "setAllCaps", new String[] { "boolean" }, new Object[] { Boolean.FALSE });
            return button;
        }
        private static Object text(Object context, String value, int size, Object color, AndroidUiCalls ui) throws Exception {
            Object view = construct(ui, "android.widget.TextView", CONTEXT, context);
            setText(ui, view, value);
            invoke(ui, view, "setTextSize", new String[] { "int", "float" }, new Object[] { 2, (float) size });
            invoke(ui, view, "setTextColor", new String[] { COLOR_STATE_LIST }, new Object[] { color });
            return view;
        }
        private static String shortTime(long millis) {
            return new java.text.SimpleDateFormat("MM-dd HH:mm", java.util.Locale.US).format(new java.util.Date(millis));
        }
        private static String fullTime(long millis) {
            return new java.text.SimpleDateFormat("yyyy-MM-dd HH:mm:ss", java.util.Locale.US).format(new java.util.Date(millis));
        }
        private static void setClick(AndroidUiCalls ui, Object view, Runnable action) throws Exception {
            invoke(ui, view, "setOnClickListener", new String[] { "android.view.View$OnClickListener" },
                new Object[] { ui.clickListener(action) });
        }
        private static void setNavigationClick(AndroidUiCalls ui, Object toolbar, Runnable action) throws Exception {
            invoke(ui, toolbar, "setNavigationOnClickListener", new String[] { "android.view.View$OnClickListener" },
                new Object[] { ui.clickListener(action) });
        }
        private static void setText(AndroidUiCalls ui, Object view, String value) throws Exception {
            invoke(ui, view, "setText", new String[] { "java.lang.CharSequence" }, new Object[] { value });
        }
        private static void add(AndroidUiCalls ui, Object parent, Object child, Object params) throws Exception {
            invoke(ui, parent, "addView", new String[] { VIEW, VIEW_PARAMS }, new Object[] { child, params });
        }
        private static Object construct(AndroidUiCalls ui, String className, String parameterType, Object argument) throws Exception {
            return ui.construct(className, new String[] { parameterType }, new Object[] { argument });
        }
        private static Object newLayoutParams(AndroidUiCalls ui, int width, int height) throws Exception {
            return ui.construct(VIEW_PARAMS, new String[] { "int", "int" }, new Object[] { width, height });
        }
        private static Object linearParams(AndroidUiCalls ui, int width, int height, float weight) throws Exception {
            return ui.construct("android.widget.LinearLayout$LayoutParams", new String[] { "int", "int", "float" },
                new Object[] { width, height, weight });
        }
        private static int dp(Object context, int value, AndroidUiCalls ui) throws Exception {
            return (int) (value * ui.density(context) + 0.5f);
        }
        private static Object invoke(AndroidUiCalls ui, Object receiver, String method) throws Exception {
            return ui.invoke(receiver, method, new String[0], new Object[0]);
        }
        private static Object invoke(AndroidUiCalls ui, Object receiver, String method, String[] types, Object[] args) throws Exception {
            return ui.invoke(receiver, method, types, args);
        }
    }

    private static final class ReflectiveAndroidUiCalls implements AndroidUiCalls {
        @Override public Object invoke(Object receiver, String method, String[] parameterTypes, Object[] arguments) throws Exception {
            Class<?>[] types = new Class<?>[parameterTypes.length];
            for (int index = 0; index < parameterTypes.length; index++) types[index] = classForName(parameterTypes[index]);
            return receiver.getClass().getMethod(method, types).invoke(receiver, arguments);
        }
        @Override public Object construct(String className, String[] parameterTypes, Object[] arguments) throws Exception {
            Class<?>[] types = new Class<?>[parameterTypes.length];
            for (int index = 0; index < parameterTypes.length; index++) types[index] = classForName(parameterTypes[index]);
            return Class.forName(className).getConstructor(types).newInstance(arguments);
        }
        @Override public boolean isInstance(Object value, String className) throws Exception {
            return value != null && Class.forName(className).isInstance(value);
        }
        @Override public Object staticField(String className, String name) throws Exception {
            return Class.forName(className).getField(name).get(null);
        }
        @Override public Object clickListener(final Runnable callback) throws Exception {
            if (callback == null) return null;
            Class<?> listenerType = Class.forName("android.view.View$OnClickListener");
            return Proxy.newProxyInstance(listenerType.getClassLoader(), new Class<?>[] { listenerType },
                (proxy, method, args) -> {
                    if ("onClick".equals(method.getName())) callback.run();
                    if ("hashCode".equals(method.getName())) return System.identityHashCode(proxy);
                    if ("equals".equals(method.getName())) return proxy == args[0];
                    if ("toString".equals(method.getName())) return "LogPageClickListener";
                    return null;
                });
        }
        @Override public float density(Object context) throws Exception {
            Object resources = invoke(context, "getResources", new String[0], new Object[0]);
            Object metrics = invoke(resources, "getDisplayMetrics", new String[0], new Object[0]);
            return metrics.getClass().getField("density").getFloat(metrics);
        }
        private static Class<?> classForName(String name) throws ClassNotFoundException {
            if ("int".equals(name)) return int.class;
            if ("boolean".equals(name)) return boolean.class;
            if ("float".equals(name)) return float.class;
            if ("[I".equals(name)) return int[].class;
            return Class.forName(name);
        }
        @Override public int sdkInt() {
            try { return Class.forName("android.os.Build$VERSION").getField("SDK_INT").getInt(null); }
            catch (Throwable ignored) { return 0; }
        }
        @Override public Object registerBack(Object activity, Runnable callback) throws Exception {
            if (sdkInt() < 33) return null;
            Object dispatcher = activity.getClass().getMethod("getOnBackInvokedDispatcher").invoke(activity);
            Class<?> callbackType = Class.forName("android.window.OnBackInvokedCallback");
            Object proxy = Proxy.newProxyInstance(callbackType.getClassLoader(), new Class<?>[] { callbackType },
                (proxyObject, method, args) -> {
                    if ("onBackInvoked".equals(method.getName())) callback.run();
                    if ("hashCode".equals(method.getName())) return System.identityHashCode(proxyObject);
                    if ("equals".equals(method.getName())) return proxyObject == args[0];
                    if ("toString".equals(method.getName())) return "LogPageBackCallback";
                    return null;
                });
            dispatcher.getClass().getMethod("registerOnBackInvokedCallback", int.class, callbackType).invoke(dispatcher, 0, proxy);
            return new BackRegistration(dispatcher, proxy, callbackType);
        }
        @Override public void unregisterBack(Object activity, Object registration) throws Exception {
            if (!(registration instanceof BackRegistration)) return;
            BackRegistration value = (BackRegistration) registration;
            value.dispatcher.getClass().getMethod("unregisterOnBackInvokedCallback", value.callbackType)
                .invoke(value.dispatcher, value.callback);
        }
        @Override public PageInsets readInsets(Object insets) throws Exception {
            Class<?> type = Class.forName("androidx.core.view.WindowInsetsCompat$Type");
            int barsType = ((Number) type.getMethod("systemBars").invoke(null)).intValue();
            int imeType = ((Number) type.getMethod("ime").invoke(null)).intValue();
            Object bars = insets.getClass().getMethod("getInsets", int.class).invoke(insets, barsType);
            Object ime = insets.getClass().getMethod("getInsets", int.class).invoke(insets, imeType);
            int left = ((Number) bars.getClass().getField("left").get(bars)).intValue();
            int top = ((Number) bars.getClass().getField("top").get(bars)).intValue();
            int right = ((Number) bars.getClass().getField("right").get(bars)).intValue();
            int systemBottom = ((Number) bars.getClass().getField("bottom").get(bars)).intValue();
            int imeBottom = ((Number) ime.getClass().getField("bottom").get(ime)).intValue();
            return new PageInsets(left, top, right, systemBottom, imeBottom);
        }
        @Override public int[] padding(Object view) throws Exception {
            return new int[] {
                ((Number) view.getClass().getMethod("getPaddingLeft").invoke(view)).intValue(),
                ((Number) view.getClass().getMethod("getPaddingTop").invoke(view)).intValue(),
                ((Number) view.getClass().getMethod("getPaddingRight").invoke(view)).intValue(),
                ((Number) view.getClass().getMethod("getPaddingBottom").invoke(view)).intValue()
            };
        }
        @Override public void setPadding(Object view, int left, int top, int right, int bottom) throws Exception {
            invoke(view, "setPadding", new String[] { "int", "int", "int", "int" },
                new Object[] { left, top, right, bottom });
        }
        @Override public boolean isAttached(Object view) throws Exception {
            return Boolean.TRUE.equals(view.getClass().getMethod("isAttachedToWindow").invoke(view));
        }
        @Override public void requestApplyInsets(Object view) throws Exception { invoke(view, "requestApplyInsets", new String[0], new Object[0]); }
        @Override public void finish(Object activity) throws Exception { activity.getClass().getMethod("finish").invoke(activity); }
        @Override public void toast(Object activity, String message) { toastNative(activity, message); }
        private static void toastNative(Object context, String message) {
            try {
                Class<?> toast = Class.forName("android.widget.Toast");
                Object value = toast.getMethod("makeText", Class.forName("android.content.Context"), CharSequence.class, int.class)
                    .invoke(null, context, message, 0);
                toast.getMethod("show").invoke(value);
            } catch (Throwable ignored) { }
        }
    }

    private static final class BackRegistration {
        final Object dispatcher;
        final Object callback;
        final Class<?> callbackType;
        BackRegistration(Object dispatcher, Object callback, Class<?> callbackType) {
            this.dispatcher = dispatcher; this.callback = callback; this.callbackType = callbackType;
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
