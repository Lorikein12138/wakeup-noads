package com.suda.yzune.wakeupschedule.slim;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

public final class TeachingBootstrapTest {
    private static final List<Object> KEEP_ALIVE = new ArrayList<Object>();
    private static final String RESPONSE_CLASS = "Lcom/baidu/homework/common/net/model/v1/PlutoAntispam;";

    public static void main(String[] args) throws Exception {
        testFirstInitializationAndCachedNativeSetToken();
        testFailureCleanupAndRetry();
        testPreconditionsDoNotInitialize();
        testContextServiceFallbackAndKeyChecks();
        testActualVersionCodeIsPassedToKeyLookup();
        testVersionSeededKeyRejectsErrorSentinels();
        testSignatureFailureSentinels();
        testReadyParentDoesNotRepeatBootstrap();
        testProductionInputAdapterRejectsUnownedRequests();
        testConcurrentInitializationIsBounded();
        testIndependentAdaptersShareInitializationLock();
        System.out.println("TeachingBootstrapTest passed");
    }

    private static void testFirstInitializationAndCachedNativeSetToken() {
        SlimNetworkPolicy.clearForTest();
        FakePlatform first = new FakePlatform();
        first.ready = false;
        first.keyValid = true;
        check(new TeachingBootstrap().ensureReady(parent(), first) == TeachingBootstrap.Result.READY, "first no-token initialization succeeds");
        check(first.initializeCalls.get() == 1, "initialization adapter invoked exactly once");
        check(first.nativeSetTokenCalls.get() == 1, "original E41 path performs nativeSetToken on first initialization");

        SlimNetworkPolicy.clearForTest();
        FakePlatform cached = new FakePlatform();
        cached.ready = true;
        cached.keyValid = true;
        check(new TeachingBootstrap().ensureReady(parent(), cached) == TeachingBootstrap.Result.READY, "valid cache still succeeds");
        check(cached.initializeCalls.get() == 1, "cached path still invokes E41 OooO0o");
        check(cached.nativeSetTokenCalls.get() == 1, "cached path still runs original nativeSetToken logic");
        SlimNetworkPolicy.clearForTest();
    }

    private static void testFailureCleanupAndRetry() {
        SlimNetworkPolicy.clearForTest();
        FakePlatform failed = new FakePlatform();
        failed.initializeResult = false;
        check(new TeachingBootstrap().ensureReady(parent(), failed) == TeachingBootstrap.Result.BASEUTIL_NOT_READY, "native initialization failure is reported");
        check(failed.initializeCalls.get() == 1, "failed attempt is not retried in the same parent scope");
        check(!SlimNetworkPolicy.registerBootstrapChild(new Object(), SlimNetworkPolicy.ANTISPAM_URL, "sign", "antispam", 1, RESPONSE_CLASS), "failure finally closes bootstrap child scope");

        SlimNetworkPolicy.clearForTest();
        FakePlatform thrown = new FakePlatform();
        thrown.throwDuringInitialize = true;
        check(new TeachingBootstrap().ensureReady(parent(), thrown) == TeachingBootstrap.Result.INITIALIZATION_FAILED, "native exception becomes a failed result");
        check(thrown.initializeCalls.get() == 1, "exception path attempts initialization once");

        SlimNetworkPolicy.clearForTest();
        FakePlatform retry = new FakePlatform();
        retry.initializeResult = false;
        check(new TeachingBootstrap().ensureReady(parent(), retry) == TeachingBootstrap.Result.BASEUTIL_NOT_READY, "first user request can fail");
        retry.initializeResult = true;
        retry.ready = true;
        check(new TeachingBootstrap().ensureReady(parent(), retry) == TeachingBootstrap.Result.READY, "next owner request retries after failure");
        check(retry.initializeCalls.get() == 2, "retry uses a new parent and makes one new attempt");
        SlimNetworkPolicy.clearForTest();
    }

    private static void testPreconditionsDoNotInitialize() {
        FakePlatform platform = new FakePlatform(); platform.teachingRoute = false; assertNoInit(platform, TeachingBootstrap.Result.NOT_TEACHING);
        platform = new FakePlatform(); platform.privacy = false; assertNoInit(platform, TeachingBootstrap.Result.PRIVACY_DENIED);
        platform = new FakePlatform(); platform.online = false; assertNoInit(platform, TeachingBootstrap.Result.OFFLINE);
        platform = new FakePlatform(); platform.context = false; assertNoInit(platform, TeachingBootstrap.Result.CONTEXT_UNAVAILABLE);
        platform = new FakePlatform(); platform.serviceOrFallback = false; assertNoInit(platform, TeachingBootstrap.Result.SERVICE_UNAVAILABLE);
        platform = new FakePlatform(); platform.nativeLibrary = false; assertNoInit(platform, TeachingBootstrap.Result.NATIVE_LIBRARY_UNAVAILABLE);
        platform = new FakePlatform(); platform.versionCode = 0; assertNoInit(platform, TeachingBootstrap.Result.INVALID_VERSION_CODE);
        SlimNetworkPolicy.clearForTest();
        FakePlatform brokenCheck = new FakePlatform();
        brokenCheck.throwDuringPrecondition = true;
        check(new TeachingBootstrap().ensureReady(parent(), brokenCheck) == TeachingBootstrap.Result.INITIALIZATION_FAILED,
            "precondition adapter failure becomes a normal failure result");
        check(brokenCheck.initializeCalls.get() == 0, "failed precondition never calls native baseutil initialization");
        SlimNetworkPolicy.clearForTest();

        SlimNetworkPolicy.clearForTest();
        FakePlatform inactive = new FakePlatform();
        inactive.ownerActive = false;
        check(new TeachingBootstrap().ensureReady(parent(), inactive) == TeachingBootstrap.Result.OWNER_INACTIVE, "destroyed teaching owner is rejected");
        check(inactive.initializeCalls.get() == 0, "inactive owner never initializes");
        SlimNetworkPolicy.clearForTest();
    }

    private static void testContextServiceFallbackAndKeyChecks() {
        SlimNetworkPolicy.clearForTest();
        FakePlatform fallback = new FakePlatform();
        fallback.serviceOrFallback = false;
        fallback.netConfigFallback = true;
        fallback.keyValid = true;
        check(new TeachingBootstrap().ensureReady(parent(), fallback) == TeachingBootstrap.Result.READY, "local netConfig service fallback remains usable");
        check(fallback.initializeCalls.get() == 1, "fallback path initializes within the teaching scope");

        SlimNetworkPolicy.clearForTest();
        FakePlatform invalidKey = new FakePlatform();
        invalidKey.ready = true;
        invalidKey.keyValid = false;
        check(new TeachingBootstrap().ensureReady(parent(), invalidKey) == TeachingBootstrap.Result.VERSION_KEY_INVALID, "missing or error version-seeded key rejects bootstrap");
        check(invalidKey.initializeCalls.get() == 1, "invalid-key check still followed the original readiness/native path");
        SlimNetworkPolicy.clearForTest();
    }

    private static void testActualVersionCodeIsPassedToKeyLookup() {
        SlimNetworkPolicy.clearForTest();
        FakePlatform baseline = new FakePlatform();
        baseline.versionCode = 550;
        check(new TeachingBootstrap().ensureReady(parent(), baseline) == TeachingBootstrap.Result.READY,
            "the 6.6.0 baseline version key is accepted");
        check(baseline.lastRequestedVersionCode == 550, "bootstrap derives the key lookup from baseline versionCode 550");

        SlimNetworkPolicy.clearForTest();
        FakePlatform explicit = new FakePlatform();
        explicit.versionCode = 654;
        check(new TeachingBootstrap().ensureReady(parent(), explicit) == TeachingBootstrap.Result.READY,
            "an explicitly supplied non-baseline version remains supported");
        check(explicit.lastRequestedVersionCode == 654, "key lookup receives the explicit actual versionCode");
        SlimNetworkPolicy.clearForTest();
    }

    private static void testVersionSeededKeyRejectsErrorSentinels() {
        check(!TeachingBootstrap.isUsableVersionKey(null), "missing version-seeded key is rejected");
        check(!TeachingBootstrap.isUsableVersionKey(""), "empty version-seeded key is rejected");
        check(!TeachingBootstrap.isUsableVersionKey("error: native unavailable"), "error-prefixed key is rejected");
        check(!TeachingBootstrap.isUsableVersionKey("init_error"), "init_error sentinel is rejected");
        check(!TeachingBootstrap.isUsableVersionKey("so_error"), "so_error sentinel is rejected");
        check(!TeachingBootstrap.isUsableVersionKey("ERROR"), "error sentinel comparison is case insensitive");
        check(TeachingBootstrap.isUsableVersionKey("valid-version-key"), "nonempty non-error key is accepted without exposing it");
    }

    private static void testSignatureFailureSentinels() {
        for (String sentinel : new String[] { null, "", "error", "error: native unavailable", "init_error", "so_error" }) {
            try {
                TeachingBootstrap.requireUsableSignature(sentinel);
                throw new AssertionError("signature sentinel must fail: " + sentinel);
            } catch (IllegalStateException expected) {
                check(expected.getMessage().contains("signature"), "signature rejection is distinguishable without logging its value");
            }
        }
        TeachingBootstrap.requireUsableSignature("valid-signature");
    }

    private static void testReadyParentDoesNotRepeatBootstrap() {
        SlimNetworkPolicy.clearForTest();
        FakePlatform platform = new FakePlatform();
        platform.ready = true;
        platform.keyValid = true;
        SlimNetworkPolicy.ParentToken parent = parent();
        TeachingBootstrap bootstrap = new TeachingBootstrap();
        check(bootstrap.ensureReady(parent, platform) == TeachingBootstrap.Result.READY, "initial request marks its parent ready");
        check(bootstrap.ensureReady(parent, platform) == TeachingBootstrap.Result.READY, "signature preflight can reuse successful owner-bound readiness");
        check(platform.initializeCalls.get() == 1, "a second path on the same parent does not reinitialize or consume another bootstrap scope");
        SlimNetworkPolicy.clearForTest();
    }

    private static void testProductionInputAdapterRejectsUnownedRequests() {
        SlimNetworkPolicy.clearForTest();
        Object unowned = new Object();
        check(TeachingBootstrap.ensureReadyForInput(unowned) == TeachingBootstrap.Result.NO_PARENT,
            "production adapter rejects an input with no registered teaching owner");
        try {
            TeachingBootstrap.requireReadyForInput(unowned);
            throw new AssertionError("unowned input must not reach crypto construction");
        } catch (IllegalStateException expected) {
            check(expected.getMessage().contains("NO_PARENT"), "failure is identifiable without exposing request data");
        }
        SlimNetworkPolicy.clearForTest();
    }

    private static void testConcurrentInitializationIsBounded() throws Exception {
        SlimNetworkPolicy.clearForTest();
        final TeachingBootstrap bootstrap = new TeachingBootstrap(100L);
        final FakePlatform first = new FakePlatform();
        first.blockInitialize = true;
        final SlimNetworkPolicy.ParentToken firstParent = parent();
        final AtomicReference<TeachingBootstrap.Result> firstResult = new AtomicReference<TeachingBootstrap.Result>();
        Thread worker = new Thread(new Runnable() {
            @Override public void run() { firstResult.set(bootstrap.ensureReady(firstParent, first)); }
        });
        worker.start();
        check(first.initializeEntered.await(1, TimeUnit.SECONDS), "first initializer starts within a bound");
        FakePlatform second = new FakePlatform();
        long started = System.nanoTime();
        TeachingBootstrap.Result secondResult = bootstrap.ensureReady(parent(), second);
        long elapsedMillis = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started);
        check(secondResult == TeachingBootstrap.Result.BOOTSTRAP_BUSY, "concurrent initialization timeout is reported");
        check(elapsedMillis < 1000L, "concurrent wait has a bounded timeout");
        check(second.initializeCalls.get() == 0, "timed-out second request does not initialize");
        first.releaseInitialize.countDown();
        worker.join(1000L);
        check(!worker.isAlive(), "first request exits after release");
        check(firstResult.get() == TeachingBootstrap.Result.READY, "first initialization completes normally");
        SlimNetworkPolicy.clearForTest();
    }

    private static void testIndependentAdaptersShareInitializationLock() throws Exception {
        SlimNetworkPolicy.clearForTest();
        final FakePlatform first = new FakePlatform();
        first.blockInitialize = true;
        final AtomicReference<TeachingBootstrap.Result> firstResult = new AtomicReference<TeachingBootstrap.Result>();
        Thread worker = new Thread(new Runnable() {
            @Override public void run() {
                firstResult.set(new TeachingBootstrap().ensureReady(parent(), first));
            }
        });
        worker.start();
        check(first.initializeEntered.await(1, TimeUnit.SECONDS), "first independent adapter enters native initialization");

        FakePlatform second = new FakePlatform();
        long started = System.nanoTime();
        TeachingBootstrap.Result secondResult = new TeachingBootstrap(80L).ensureReady(parent(), second);
        long elapsedMillis = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started);
        check(secondResult == TeachingBootstrap.Result.BOOTSTRAP_BUSY,
            "independently created production adapters share the initialization lock");
        check(elapsedMillis < 1000L, "independent adapter wait remains bounded");
        check(second.initializeCalls.get() == 0, "second adapter does not race the first native initialization");

        first.releaseInitialize.countDown();
        worker.join(1000L);
        check(!worker.isAlive(), "independent adapter first request exits after release");
        check(firstResult.get() == TeachingBootstrap.Result.READY, "independent adapter first request succeeds");
        SlimNetworkPolicy.clearForTest();
    }

    private static void assertNoInit(FakePlatform platform, TeachingBootstrap.Result expected) {
        SlimNetworkPolicy.clearForTest();
        check(new TeachingBootstrap().ensureReady(parent(), platform) == expected, "precondition result is " + expected);
        check(platform.initializeCalls.get() == 0, expected + " does not invoke baseutil");
        SlimNetworkPolicy.clearForTest();
    }

    private static SlimNetworkPolicy.ParentToken parent() {
        Object request = new Object();
        Object owner = new Object();
        Object view = new Object();
        KEEP_ALIVE.add(request);
        KEEP_ALIVE.add(owner);
        KEEP_ALIVE.add(view);
        boolean registered = SlimNetworkPolicy.registerDynamic(request, owner, view, view,
            "https://api.wakeup.fun/wakeup/script/parse", SlimNetworkPolicy.SOURCE_V2, true, true, false);
        check(registered, "fixture registers an active parser owner");
        return SlimNetworkPolicy.parentFor(request);
    }

    private static void check(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }

    private static final class FakePlatform implements TeachingBootstrap.Platform {
        final AtomicInteger initializeCalls = new AtomicInteger();
        final AtomicInteger nativeSetTokenCalls = new AtomicInteger();
        final CountDownLatch initializeEntered = new CountDownLatch(1);
        final CountDownLatch releaseInitialize = new CountDownLatch(1);
        volatile boolean ownerActive = true;
        volatile boolean teachingRoute = true;
        volatile boolean privacy = true;
        volatile boolean online = true;
        volatile boolean context = true;
        volatile boolean serviceOrFallback = true;
        volatile boolean netConfigFallback;
        volatile boolean nativeLibrary = true;
        volatile int versionCode = 550;
        volatile int lastRequestedVersionCode = -1;
        volatile boolean ready;
        volatile boolean keyValid = true;
        volatile boolean initializeResult = true;
        volatile boolean throwDuringInitialize;
        volatile boolean throwDuringPrecondition;
        volatile boolean blockInitialize;

        @Override public boolean isTeachingOwnerActive() { return ownerActive; }
        @Override public boolean isTeachingRoute() { return teachingRoute; }
        @Override public boolean isPrivacyApproved() {
            if (throwDuringPrecondition) throw new IllegalStateException("simulated privacy-state read failure");
            return privacy;
        }
        @Override public boolean isOnline() { return online; }
        @Override public boolean hasLocalApplicationContext() { return context; }
        @Override public boolean hasServiceOrNetConfigFallback() { return serviceOrFallback || netConfigFallback; }
        @Override public boolean hasNativeLibrary() { return nativeLibrary; }
        @Override public int actualVersionCode() { return versionCode; }
        @Override public boolean isBaseutilReady() { return ready; }

        @Override public boolean initializeOrRebindBaseutil() {
            initializeCalls.incrementAndGet();
            initializeEntered.countDown();
            if (blockInitialize) {
                try {
                    if (!releaseInitialize.await(2, TimeUnit.SECONDS)) return false;
                } catch (InterruptedException exception) {
                    Thread.currentThread().interrupt();
                    return false;
                }
            }
            if (throwDuringInitialize) throw new UnsatisfiedLinkError("simulated native library failure");
            if (!initializeResult) return false;
            nativeSetTokenCalls.incrementAndGet();
            ready = true;
            return true;
        }

        @Override public boolean hasVersionCodeSeededKey(int requestedVersionCode) {
            lastRequestedVersionCode = requestedVersionCode;
            return requestedVersionCode == versionCode && keyValid;
        }
    }
}
