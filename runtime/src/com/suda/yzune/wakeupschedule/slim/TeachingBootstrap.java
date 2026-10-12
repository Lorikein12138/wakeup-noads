package com.suda.yzune.wakeupschedule.slim;

import java.io.File;
import java.lang.reflect.Field;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Runs the existing baseutil initialization only for an owner-bound teaching request.
 * Android, preference, native, and service checks are supplied by the Smali adapter.
 */
public final class TeachingBootstrap {
    private static final String SCHOOL_LIST_ACTIVITY = "com.suda.yzune.wakeupschedule.schedule_import.SchoolListActivity";
    private static final String LOGIN_WEB_ACTIVITY = "com.suda.yzune.wakeupschedule.schedule_import.LoginWebActivity";

    public enum Result {
        READY,
        NO_PARENT,
        OWNER_INACTIVE,
        NOT_TEACHING,
        PRIVACY_DENIED,
        OFFLINE,
        CONTEXT_UNAVAILABLE,
        SERVICE_UNAVAILABLE,
        NATIVE_LIBRARY_UNAVAILABLE,
        INVALID_VERSION_CODE,
        BOOTSTRAP_ALREADY_ATTEMPTED,
        BOOTSTRAP_BUSY,
        INITIALIZATION_FAILED,
        BASEUTIL_NOT_READY,
        VERSION_KEY_INVALID,
        INTERRUPTED
    }

    /** Adapter methods map one-to-one to existing Context/baseutil/native state checks. */
    public interface Platform {
        boolean isTeachingOwnerActive();
        boolean isTeachingRoute();
        boolean isPrivacyApproved();
        boolean isOnline();
        boolean hasLocalApplicationContext();
        boolean hasServiceOrNetConfigFallback();
        boolean hasNativeLibrary();
        int actualVersionCode();
        boolean isBaseutilReady();

        /** Must invoke E41 OooO0o()Z once; that original method also performs nativeSetToken. */
        boolean initializeOrRebindBaseutil();

        /** Checks the key produced from the actual package versionCode without exposing it to logs. */
        boolean hasVersionCodeSeededKey(int versionCode);
    }

    static boolean isUsableVersionKey(Object key) {
        if (!(key instanceof String)) return false;
        String value = (String) key;
        return value.length() > 0
            && !value.regionMatches(true, 0, "error", 0, 5)
            && !value.regionMatches(true, 0, "init_error", 0, 10)
            && !value.regionMatches(true, 0, "so_error", 0, 8);
    }

    /** Throws before RC4 construction when baseutil returned one of its failure sentinels. */
    public static void requireUsableVersionKey(Object key) {
        if (!isUsableVersionKey(key)) throw new IllegalStateException("version-seeded crypto key is unavailable");
    }

    /** Rejects the native signer failure sentinels before a business URL can be queued. */
    public static void requireUsableSignature(Object signature) {
        if (!isUsableVersionKey(signature)) throw new IllegalStateException("network signature is unavailable");
    }

    private static final Object INITIALIZATION_MONITOR = new Object();
    private static final AtomicInteger DX_THREAD_NUMBER = new AtomicInteger();
    private static final ThreadLocal<Object> READY_DX_INPUT = new ThreadLocal<Object>();
    private static final ExecutorService DX_BOOTSTRAP_EXECUTOR = Executors.newFixedThreadPool(2, new ThreadFactory() {
        @Override public Thread newThread(Runnable task) {
            Thread thread = new Thread(task, "slim-teaching-bootstrap-" + DX_THREAD_NUMBER.incrementAndGet());
            thread.setDaemon(true);
            return thread;
        }
    });
    private static boolean initializing;
    private static Thread initializingThread;
    private final long waitLimitMillis;

    public TeachingBootstrap() {
        this(10_000L);
    }

    /** Production adapter entry used by patched background EncryptNet construction paths. */
    public static Result ensureReadyForInput(Object input) {
        SlimNetworkPolicy.ParentToken parent = SlimNetworkPolicy.parentFor(input);
        Object owner = SlimNetworkPolicy.ownerFor(parent);
        if (parent == null || owner == null) return Result.NO_PARENT;
        return new TeachingBootstrap().ensureReady(parent, new ReflectivePlatform(owner, parent));
    }

    /** Called from EncryptNet's existing background input-construction coroutine. */
    public static void requireReadyForInput(Object input) {
        Result result = ensureReadyForInput(input);
        if (result != Result.READY) {
            throw new IllegalStateException("teaching bootstrap failed: " + result.name());
        }
    }

    /** The DX WebView action ignores o000ooo's Request return; defer its work without blocking the caller. */
    public static boolean isReadyDxInputOnCurrentThread(Object input) {
        return input != null && READY_DX_INPUT.get() == input;
    }

    /** Runs the existing DX Request construction only after owner-bound initialization succeeds. */
    public static void runDxRequestAfterReady(final Object context, final boolean raw, final Object input,
                                              final Object success, final Object error) {
        DX_BOOTSTRAP_EXECUTOR.execute(new Runnable() {
            @Override public void run() {
                SlimNetworkPolicy.ParentToken parent = SlimNetworkPolicy.parentFor(input);
                Object owner = SlimNetworkPolicy.ownerFor(parent);
                if (parent == null || owner == null) {
                    reportNetworkFailure(error, new IllegalStateException("teaching request has no live owner"));
                    return;
                }
                Result result = new TeachingBootstrap().ensureReady(parent, new ReflectivePlatform(owner, parent));
                if (result != Result.READY || !SlimNetworkPolicy.isParentLive(parent)) {
                    reportNetworkFailure(error, new IllegalStateException("teaching bootstrap failed: " + result.name()));
                    return;
                }
                READY_DX_INPUT.set(input);
                try {
                    ClassLoader loader = TeachingBootstrap.class.getClassLoader();
                    Class<?> contextType = Class.forName("android.content.Context", false, loader);
                    Class<?> inputType = Class.forName("Lo000OO0o.OooO0O0", false, loader);
                    Class<?> successType = Class.forName("com.baidu.homework.common.net.OooOo00$Oooo0", false, loader);
                    Class<?> errorType = Class.forName("com.baidu.homework.common.net.OooOo00$OooOo00", false, loader);
                    Method method = owner.getClass().getMethod("o000ooo", contextType, boolean.class, inputType, successType, errorType);
                    method.invoke(owner, context, Boolean.valueOf(raw), input, success, error);
                } catch (InvocationTargetException exception) {
                    reportNetworkFailure(error, exception.getCause() == null ? exception : exception.getCause());
                } catch (ReflectiveOperationException | RuntimeException | LinkageError exception) {
                    reportNetworkFailure(error, exception);
                } finally {
                    READY_DX_INPUT.remove();
                }
            }
        });
    }

    /** Reuses Volley’s original NetError conversion and delivers it on Android’s main thread. */
    public static void reportNetworkFailure(final Object errorListener, final Throwable failure) {
        if (errorListener == null || failure == null) return;
        Runnable delivery = new Runnable() {
            @Override public void run() {
                try {
                    ClassLoader loader = TeachingBootstrap.class.getClassLoader();
                    Class<?> volleyErrorType = Class.forName("com.android.volley.VolleyError", true, loader);
                    Object volleyError = volleyErrorType.getConstructor(Throwable.class).newInstance(failure);
                    errorListener.getClass().getMethod("onErrorResponse", volleyErrorType).invoke(errorListener, volleyError);
                } catch (ReflectiveOperationException | RuntimeException | LinkageError exception) {
                    throw new IllegalStateException("local network error delivery failed", exception);
                }
            }
        };
        try {
            ClassLoader loader = TeachingBootstrap.class.getClassLoader();
            Class<?> looperType = Class.forName("android.os.Looper", true, loader);
            Object mainLooper = looperType.getMethod("getMainLooper").invoke(null);
            Object currentLooper = looperType.getMethod("myLooper").invoke(null);
            if (mainLooper == currentLooper) {
                delivery.run();
                return;
            }
            Class<?> handlerType = Class.forName("android.os.Handler", true, loader);
            Object handler = handlerType.getConstructor(looperType).newInstance(mainLooper);
            Object posted = handlerType.getMethod("post", Runnable.class).invoke(handler, delivery);
            if (!Boolean.TRUE.equals(posted)) throw new IllegalStateException("main-thread error delivery was rejected");
        } catch (ReflectiveOperationException | RuntimeException | LinkageError exception) {
            throw new IllegalStateException("local network error delivery could not be scheduled", exception);
        }
    }

    TeachingBootstrap(long waitLimitMillis) {
        if (waitLimitMillis < 1L) throw new IllegalArgumentException("waitLimitMillis must be positive");
        this.waitLimitMillis = waitLimitMillis;
    }

    public Result ensureReady(SlimNetworkPolicy.ParentToken parent, Platform platform) {
        if (parent == null || platform == null) return Result.NO_PARENT;
        final int versionCode;
        try {
            if (!SlimNetworkPolicy.isParentLive(parent)) return Result.OWNER_INACTIVE;
            if (!platform.isTeachingOwnerActive()) return Result.OWNER_INACTIVE;
            if (!platform.isTeachingRoute()) return Result.NOT_TEACHING;
            if (!platform.isPrivacyApproved()) return Result.PRIVACY_DENIED;
            if (!platform.isOnline()) return Result.OFFLINE;
            if (!platform.hasLocalApplicationContext()) return Result.CONTEXT_UNAVAILABLE;
            if (!platform.hasServiceOrNetConfigFallback()) return Result.SERVICE_UNAVAILABLE;
            if (!platform.hasNativeLibrary()) return Result.NATIVE_LIBRARY_UNAVAILABLE;
            versionCode = platform.actualVersionCode();
        } catch (RuntimeException | LinkageError exception) {
            return Result.INITIALIZATION_FAILED;
        }
        if (versionCode <= 0) return Result.INVALID_VERSION_CODE;

        if (SlimNetworkPolicy.isBootstrapReady(parent)) {
            try {
                if (!platform.isBaseutilReady()) return Result.BASEUTIL_NOT_READY;
                if (!platform.hasVersionCodeSeededKey(versionCode)) return Result.VERSION_KEY_INVALID;
                return SlimNetworkPolicy.isParentLive(parent) ? Result.READY : Result.OWNER_INACTIVE;
            } catch (RuntimeException | LinkageError exception) {
                return Result.INITIALIZATION_FAILED;
            }
        }

        final SlimNetworkPolicy.BootstrapScope scope;
        try {
            scope = SlimNetworkPolicy.enterBootstrap(parent);
        } catch (LinkageError error) {
            return Result.INITIALIZATION_FAILED;
        }
        if (scope == null) return Result.BOOTSTRAP_ALREADY_ATTEMPTED;

        try (SlimNetworkPolicy.BootstrapScope ignored = scope) {
            if (!acquireInitializationSlot()) return Thread.currentThread().isInterrupted() ? Result.INTERRUPTED : Result.BOOTSTRAP_BUSY;
            try {
                // Call on cache hits too: E41 owns the nativeSetToken/version-seed path.
                boolean reportedReady = platform.initializeOrRebindBaseutil();
                boolean isReady = platform.isBaseutilReady();
                if (!reportedReady || !isReady) return Result.BASEUTIL_NOT_READY;
                if (!platform.hasVersionCodeSeededKey(versionCode)) return Result.VERSION_KEY_INVALID;
                if (!SlimNetworkPolicy.markBootstrapReady(parent)) return Result.OWNER_INACTIVE;
                return Result.READY;
            } catch (RuntimeException | LinkageError exception) {
                return Result.INITIALIZATION_FAILED;
            } finally {
                releaseInitializationSlot();
            }
        } catch (RuntimeException | LinkageError exception) {
            return Result.INITIALIZATION_FAILED;
        }
    }

    private boolean acquireInitializationSlot() {
        long deadline = System.currentTimeMillis() + waitLimitMillis;
        synchronized (INITIALIZATION_MONITOR) {
            while (initializing) {
                if (initializingThread == Thread.currentThread()) return false;
                long remaining = deadline - System.currentTimeMillis();
                if (remaining <= 0L) return false;
                try {
                    INITIALIZATION_MONITOR.wait(remaining);
                } catch (InterruptedException exception) {
                    Thread.currentThread().interrupt();
                    return false;
                }
            }
            initializing = true;
            initializingThread = Thread.currentThread();
            return true;
        }
    }

    private void releaseInitializationSlot() {
        synchronized (INITIALIZATION_MONITOR) {
            if (initializingThread == Thread.currentThread()) {
                initializing = false;
                initializingThread = null;
                INITIALIZATION_MONITOR.notifyAll();
            }
        }
    }

    /** Reflection keeps the runtime helper compilable with Java 8 and no Android SDK dependency. */
    private static final class ReflectivePlatform implements Platform {
        private final Object owner;
        private final SlimNetworkPolicy.ParentToken parent;
        private final String source;

        private ReflectivePlatform(Object owner, SlimNetworkPolicy.ParentToken parent) {
            this.owner = owner;
            this.parent = parent;
            this.source = SlimNetworkPolicy.sourceFor(parent);
        }

        @Override public boolean isTeachingOwnerActive() {
            try {
                Object activity = teachingActivity();
                return activity != null && !booleanMethod(activity, "isFinishing") && !booleanMethod(activity, "isDestroyed");
            } catch (ReflectiveOperationException | RuntimeException exception) {
                return false;
            }
        }

        @Override public boolean isTeachingRoute() {
            if (SlimNetworkPolicy.SOURCE_SCHOOL_LIST.equals(source)) return SCHOOL_LIST_ACTIVITY.equals(owner.getClass().getName());
            if (SlimNetworkPolicy.SOURCE_V2.equals(source)) {
                return "com.suda.yzune.wakeupschedule.schedule_import.v2.ParserFragment".equals(owner.getClass().getName());
            }
            if (SlimNetworkPolicy.SOURCE_DX.equals(source)) {
                return "com.suda.yzune.wakeupschedule.schedule_import.DXParserLoginFragment".equals(owner.getClass().getName());
            }
            if (SlimNetworkPolicy.SOURCE_WEBVIEW.equals(source)) {
                return "com.suda.yzune.wakeupschedule.schedule_import.WebViewLoginFragment".equals(owner.getClass().getName());
            }
            return false;
        }

        @Override public boolean isPrivacyApproved() {
            try {
                Object result = invokeStatic("com.zybang.privacy.OooO0O0", "OooO0o");
                return Boolean.TRUE.equals(result);
            } catch (ReflectiveOperationException | RuntimeException exception) {
                return false;
            }
        }

        @Override public boolean isOnline() {
            try {
                Object context = applicationContext();
                Object manager = context.getClass().getMethod("getSystemService", String.class).invoke(context, "connectivity");
                if (manager == null) return false;
                Object info = manager.getClass().getMethod("getActiveNetworkInfo").invoke(manager);
                return info != null && booleanMethod(info, "isConnected");
            } catch (ReflectiveOperationException | RuntimeException exception) {
                return false;
            }
        }

        @Override public boolean hasLocalApplicationContext() {
            try {
                return applicationContext() != null;
            } catch (ReflectiveOperationException | RuntimeException exception) {
                return false;
            }
        }

        @Override public boolean hasServiceOrNetConfigFallback() {
            try {
                return invokeStatic("com.zybang.service.BaseUtilService", "OooO0O0") != null;
            } catch (ReflectiveOperationException | RuntimeException exception) {
                return false;
            }
        }

        @Override public boolean hasNativeLibrary() {
            try {
                Object application = applicationContext();
                Object info = application.getClass().getMethod("getApplicationInfo").invoke(application);
                Field nativeLibraryDir = info.getClass().getField("nativeLibraryDir");
                Object directory = nativeLibraryDir.get(info);
                return directory instanceof String && new File((String) directory, "libbaseutil.so").isFile();
            } catch (ReflectiveOperationException | RuntimeException exception) {
                return false;
            }
        }

        @Override public int actualVersionCode() {
            try {
                Object value = invokeStatic("o000O0Oo.OooO", "OooOO0");
                return value instanceof Number ? ((Number) value).intValue() : 0;
            } catch (ReflectiveOperationException | RuntimeException exception) {
                return 0;
            }
        }

        @Override public boolean isBaseutilReady() {
            try {
                return Boolean.TRUE.equals(invokeStatic("com.zuoyebang.baseutil.OooO00o", "OooO0oO"));
            } catch (ReflectiveOperationException | RuntimeException exception) {
                return false;
            }
        }

        @Override public boolean initializeOrRebindBaseutil() {
            try {
                return Boolean.TRUE.equals(invokeStatic("com.zuoyebang.baseutil.OooO00o", "OooO0o"));
            } catch (ReflectiveOperationException | RuntimeException exception) {
                throw new IllegalStateException("baseutil initialization failed", exception);
            }
        }

        @Override public boolean hasVersionCodeSeededKey(int versionCode) {
            try {
                Object key = classFor("com.zuoyebang.baseutil.OooO00o")
                    .getMethod("OooO0O0", String.class).invoke(null, String.valueOf(versionCode));
                return isUsableVersionKey(key);
            } catch (ReflectiveOperationException | RuntimeException exception) {
                return false;
            }
        }

        private Object teachingActivity() throws ReflectiveOperationException {
            if (SlimNetworkPolicy.SOURCE_SCHOOL_LIST.equals(source)) {
                return SCHOOL_LIST_ACTIVITY.equals(owner.getClass().getName()) ? owner : null;
            }
            if (!booleanMethod(owner, "isAdded")) return null;
            Object activity = owner.getClass().getMethod("getActivity").invoke(owner);
            return activity != null && LOGIN_WEB_ACTIVITY.equals(activity.getClass().getName()) ? activity : null;
        }

        private Object applicationContext() throws ReflectiveOperationException {
            Object activity = teachingActivity();
            if (activity == null) return null;
            return activity.getClass().getMethod("getApplicationContext").invoke(activity);
        }

        private static boolean booleanMethod(Object receiver, String name) throws ReflectiveOperationException {
            Object value = receiver.getClass().getMethod(name).invoke(receiver);
            return Boolean.TRUE.equals(value);
        }

        private static Object invokeStatic(String className, String methodName, Class<?>... parameterTypes) throws ReflectiveOperationException {
            Method method = classFor(className).getMethod(methodName, parameterTypes);
            return method.invoke(null);
        }

        private static Class<?> classFor(String className) throws ClassNotFoundException {
            return Class.forName(className, true, TeachingBootstrap.class.getClassLoader());
        }
    }
}
