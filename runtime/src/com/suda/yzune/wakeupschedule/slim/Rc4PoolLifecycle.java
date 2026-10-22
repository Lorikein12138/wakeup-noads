package com.suda.yzune.wakeupschedule.slim;

import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.InvocationTargetException;
import java.util.ArrayList;
import java.util.IdentityHashMap;
import java.util.Map;
import java.util.WeakHashMap;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.TimeUnit;

/** Bounded, generation-aware lifecycle for the existing four-object RC4 pool. */
public final class Rc4PoolLifecycle {
    private static final int POOL_SIZE = 4;
    private static final long BORROW_TIMEOUT_MILLIS = 1_000L;
    private static final String RC4_CLASS = "o0000oo.o0ooOOo";
    private static final Map<Object, Long> OWNER_GENERATIONS = new WeakHashMap<Object, Long>();
    private static final Map<Object, Long> INSTANCE_GENERATIONS = new WeakHashMap<Object, Long>();

    private Rc4PoolLifecycle() { }

    /** Rebuilds from the exact key already obtained from baseutil. */
    public static void rebuild(Object owner, BlockingQueue<Object> pool, Object key) {
        rebuild(owner, pool, key, new InstanceFactory() {
            @Override public Object create(String value) throws Exception {
                ClassLoader loader = ownerLoader();
                Class<?> type = Class.forName(RC4_CLASS, true, loader);
                Constructor<?> constructor = type.getDeclaredConstructor(String.class);
                if (!constructor.isAccessible()) constructor.setAccessible(true);
                try {
                    return constructor.newInstance(value);
                } catch (InvocationTargetException exception) {
                    Throwable cause = exception.getCause();
                    if (cause instanceof Exception) throw (Exception) cause;
                    if (cause instanceof LinkageError) throw (LinkageError) cause;
                    throw new IllegalStateException("RC4 constructor failed", cause);
                }
            }

            private ClassLoader ownerLoader() {
                return owner.getClass().getClassLoader();
            }
        });
    }

    /** Called when the source key is invalidated; outstanding old leases cannot re-enter later pools. */
    public static void invalidate(Object owner, BlockingQueue<?> pool) {
        if (owner == null || pool == null) return;
        synchronized (owner) {
            advanceGeneration(owner);
            pool.clear();
        }
    }

    /** Replaces BlockingQueue.take with a bounded wait that becomes a normal crypto failure. */
    public static Object take(BlockingQueue<?> pool) {
        return take(pool, BORROW_TIMEOUT_MILLIS);
    }

    static Object take(BlockingQueue<?> pool, long timeoutMillis) {
        if (pool == null || timeoutMillis < 1L) throw new IllegalArgumentException("invalid RC4 pool wait");
        try {
            Object instance = pool.poll(timeoutMillis, TimeUnit.MILLISECONDS);
            if (instance == null) throw new IllegalStateException("RC4 pool borrow timed out");
            return instance;
        } catch (InterruptedException exception) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("RC4 pool borrow was interrupted", exception);
        }
    }

    /** Returns an instance only when it belongs to the manager's current generation. */
    public static boolean returnIfCurrent(Object owner, BlockingQueue<Object> pool, Object instance) {
        if (owner == null || pool == null || instance == null) return false;
        synchronized (owner) {
            Long current = ownerGeneration(owner);
            Long created = instanceGeneration(instance);
            if (current == null || created == null || !current.equals(created)) return false;
            return pool.offer(instance);
        }
    }

    /** Fails a request that retained a cipher while the baseutil key/pool generation changed. */
    public static void requireCurrent(Object owner, Object instance) {
        if (owner == null || instance == null) throw new IllegalStateException("RC4 lease is unavailable");
        synchronized (owner) {
            Long current = ownerGeneration(owner);
            Long created = instanceGeneration(instance);
            if (current == null || created == null || !current.equals(created)) {
                throw new IllegalStateException("RC4 lease belongs to an expired key generation");
            }
        }
    }

    /** Rejects a wrapper before queueing when RC4 produced no encrypted request body. */
    public static void requireNonEmptyEncryptedData(Object request) {
        if (request == null) throw new IllegalStateException("encrypted request is unavailable");
        try {
            Field data = request.getClass().getField("data");
            Object value = data.get(request);
            if (!(value instanceof String) || ((String) value).length() == 0) {
                throw new IllegalStateException("encrypted request body is empty");
            }
        } catch (ReflectiveOperationException | RuntimeException exception) {
            if (exception instanceof IllegalStateException) throw (IllegalStateException) exception;
            throw new IllegalStateException("encrypted request body could not be verified", exception);
        }
    }

    interface InstanceFactory {
        Object create(String key) throws Exception;
    }

    static void rebuildForTest(Object owner, BlockingQueue<Object> pool, Object key, InstanceFactory factory) {
        rebuild(owner, pool, key, factory);
    }

    private static void rebuild(Object owner, BlockingQueue<Object> pool, Object key, InstanceFactory factory) {
        if (owner == null || pool == null || factory == null) throw new IllegalArgumentException("missing RC4 pool adapter");
        synchronized (owner) {
            long generation = advanceGeneration(owner);
            pool.clear();
            ArrayList<Object> staged = new ArrayList<Object>(POOL_SIZE);
            IdentityHashMap<Object, Boolean> identities = new IdentityHashMap<Object, Boolean>();
            try {
                TeachingBootstrap.requireUsableVersionKey(key);
                String usableKey = (String) key;
                for (int index = 0; index < POOL_SIZE; index++) {
                    Object instance = factory.create(usableKey);
                    if (instance == null || identities.put(instance, Boolean.TRUE) != null) {
                        throw new IllegalStateException("RC4 factory did not create four distinct instances");
                    }
                    staged.add(instance);
                }
                for (Object instance : staged) associate(instance, generation);
                pool.addAll(staged);
                if (pool.size() != POOL_SIZE) throw new IllegalStateException("RC4 pool publication was incomplete");
            } catch (RuntimeException failure) {
                pool.clear();
                forgetInstances(staged);
                advanceGeneration(owner);
                throw failure;
            } catch (Exception | LinkageError failure) {
                pool.clear();
                forgetInstances(staged);
                advanceGeneration(owner);
                throw new IllegalStateException("RC4 pool initialization failed", failure);
            }
        }
    }

    private static long advanceGeneration(Object owner) {
        synchronized (Rc4PoolLifecycle.class) {
            Long previous = OWNER_GENERATIONS.get(owner);
            long next = previous == null ? 1L : previous.longValue() + 1L;
            OWNER_GENERATIONS.put(owner, Long.valueOf(next));
            return next;
        }
    }

    private static Long ownerGeneration(Object owner) {
        synchronized (Rc4PoolLifecycle.class) { return OWNER_GENERATIONS.get(owner); }
    }

    private static Long instanceGeneration(Object instance) {
        synchronized (Rc4PoolLifecycle.class) { return INSTANCE_GENERATIONS.get(instance); }
    }

    private static void associate(Object instance, long generation) {
        synchronized (Rc4PoolLifecycle.class) { INSTANCE_GENERATIONS.put(instance, Long.valueOf(generation)); }
    }

    private static void forgetInstances(ArrayList<Object> instances) {
        synchronized (Rc4PoolLifecycle.class) {
            for (Object instance : instances) INSTANCE_GENERATIONS.remove(instance);
        }
    }
}
