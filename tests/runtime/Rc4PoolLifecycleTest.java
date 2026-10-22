package com.suda.yzune.wakeupschedule.slim;

import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

public final class Rc4PoolLifecycleTest {
    public static void main(String[] args) throws Exception {
        testFourInstancesPublishOnlyAfterCompleteConstruction();
        testInvalidAndFailedKeysLeaveNoPartialPool();
        testBorrowWaitIsBounded();
        testOldGenerationCannotReturnToNewPool();
        testDuplicateFactoryInstanceIsRejected();
        testEmptyEncryptedPayloadIsRejected();
        System.out.println("Rc4PoolLifecycleTest passed");
    }

    private static void testFourInstancesPublishOnlyAfterCompleteConstruction() {
        final Object owner = new Object();
        final BlockingQueue<Object> pool = new ArrayBlockingQueue<Object>(4);
        final AtomicInteger creates = new AtomicInteger();
        Rc4PoolLifecycle.rebuildForTest(owner, pool, "550", new Rc4PoolLifecycle.InstanceFactory() {
            @Override public Object create(String key) {
                check("550".equals(key), "factory receives the key derived from versionCode 550");
                check(pool.isEmpty(), "the target pool stays empty until all instances have been created");
                creates.incrementAndGet();
                return new FakeRc4();
            }
        });
        check(creates.get() == 4, "exactly four RC4 instances are created");
        check(pool.size() == 4, "the complete four-instance generation is published");
    }

    private static void testInvalidAndFailedKeysLeaveNoPartialPool() {
        for (String key : new String[] { null, "", "error: unavailable", "init_error", "so_error" }) {
            Object owner = new Object();
            BlockingQueue<Object> pool = new ArrayBlockingQueue<Object>(4);
            pool.add(new FakeRc4());
            try {
                Rc4PoolLifecycle.rebuildForTest(owner, pool, key, new CountingFactory());
                throw new AssertionError("invalid key must fail before constructing RC4 instances");
            } catch (IllegalStateException expected) {
                check(pool.isEmpty(), "invalid key clears the old or partial pool");
            }
        }

        Object owner = new Object();
        BlockingQueue<Object> pool = new ArrayBlockingQueue<Object>(4);
        AtomicInteger calls = new AtomicInteger();
        try {
            Rc4PoolLifecycle.rebuildForTest(owner, pool, "valid-key", new Rc4PoolLifecycle.InstanceFactory() {
                @Override public Object create(String key) throws Exception {
                    if (calls.incrementAndGet() == 3) throw new Exception("simulated RC4 construction failure");
                    return new FakeRc4();
                }
            });
            throw new AssertionError("partial RC4 construction must fail the rebuild");
        } catch (IllegalStateException expected) {
            check(calls.get() == 3, "construction stops on the first failure");
            check(pool.isEmpty(), "no partial generation remains after a constructor failure");
        }
    }

    private static void testBorrowWaitIsBounded() {
        long started = System.nanoTime();
        try {
            Rc4PoolLifecycle.take(new ArrayBlockingQueue<Object>(1), 60L);
            throw new AssertionError("empty pool must time out");
        } catch (IllegalStateException expected) {
            long elapsed = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started);
            check(elapsed >= 40L && elapsed < 1_000L, "empty pool wait is bounded near the requested timeout");
        }
    }

    private static void testOldGenerationCannotReturnToNewPool() {
        Object owner = new Object();
        BlockingQueue<Object> pool = new ArrayBlockingQueue<Object>(4);
        Rc4PoolLifecycle.rebuildForTest(owner, pool, "550", new CountingFactory("550"));
        Object oldLease = Rc4PoolLifecycle.take(pool, 100L);
        Rc4PoolLifecycle.requireCurrent(owner, oldLease);
        Rc4PoolLifecycle.invalidate(owner, pool);
        check(pool.isEmpty(), "invalidation removes queued objects from the old generation");
        try {
            Rc4PoolLifecycle.requireCurrent(owner, oldLease);
            throw new AssertionError("an old lease cannot continue after generation invalidation");
        } catch (IllegalStateException expected) {
            check(expected.getMessage().contains("expired"), "expired lease is rejected before it can decrypt or encrypt");
        }
        Rc4PoolLifecycle.rebuildForTest(owner, pool, "654", new CountingFactory("654"));
        check(!Rc4PoolLifecycle.returnIfCurrent(owner, pool, oldLease), "a borrowed old-generation object is discarded");
        check(pool.size() == 4, "discarding the old lease does not disturb the new four-instance pool");

        Object currentLease = Rc4PoolLifecycle.take(pool, 100L);
        check(Rc4PoolLifecycle.returnIfCurrent(owner, pool, currentLease), "a current-generation instance can be returned");
        check(pool.size() == 4, "current-generation return restores the pool size");
    }

    private static void testDuplicateFactoryInstanceIsRejected() {
        Object owner = new Object();
        BlockingQueue<Object> pool = new ArrayBlockingQueue<Object>(4);
        final Object duplicate = new FakeRc4();
        try {
            Rc4PoolLifecycle.rebuildForTest(owner, pool, "valid-key", new Rc4PoolLifecycle.InstanceFactory() {
                @Override public Object create(String key) { return duplicate; }
            });
            throw new AssertionError("a factory must return four distinct instances");
        } catch (IllegalStateException expected) {
            check(pool.isEmpty(), "duplicate RC4 instance is never published");
        }
    }

    private static void testEmptyEncryptedPayloadIsRejected() {
        Rc4PoolLifecycle.requireNonEmptyEncryptedData(new FakeRequest("ciphertext"));
        try {
            Rc4PoolLifecycle.requireNonEmptyEncryptedData(new FakeRequest(""));
            throw new AssertionError("empty encrypted data must fail before queueing");
        } catch (IllegalStateException expected) {
            check(expected.getMessage().contains("empty"), "empty ciphertext failure is locally identifiable");
        }
        try {
            Rc4PoolLifecycle.requireNonEmptyEncryptedData(new Object());
            throw new AssertionError("an uninspectable request cannot bypass empty-data validation");
        } catch (IllegalStateException expected) {
            check(true, "uninspectable wrapper is rejected");
        }
    }

    private static final class CountingFactory implements Rc4PoolLifecycle.InstanceFactory {
        private final AtomicInteger calls = new AtomicInteger();
        private final String expectedKey;
        CountingFactory() { this(null); }
        CountingFactory(String expectedKey) { this.expectedKey = expectedKey; }
        @Override public Object create(String key) {
            if (expectedKey != null) check(expectedKey.equals(key), "factory receives the exact caller-supplied version key");
            calls.incrementAndGet();
            return new FakeRc4();
        }
    }

    private static final class FakeRc4 { }
    public static final class FakeRequest {
        public final String data;
        FakeRequest(String data) { this.data = data; }
    }

    private static void check(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
}
