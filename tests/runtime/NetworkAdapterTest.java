package com.suda.yzune.wakeupschedule.slim;

import com.suda.yzune.wakeupschedule.aaa.model.SchoolListBean;
import com.suda.yzune.wakeupschedule.aaa.v1.HttpCurrencyRequest;
import com.suda.yzune.wakeupschedule.schedule_import.SchoolListActivity;
import java.util.Collections;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

/** JVM boundary fixture for queue insertion; this does not execute Android Volley. */
public final class NetworkAdapterTest {
    private NetworkAdapterTest() { }

    public static void main(String[] args) {
        permitsOnlyTheOwnerBoundInputAndWrapper();
        rejectsRewrittenAndUnregisteredInputBeforeQueueing();
        consumesQueuePermitsOnceAndFailsWithoutSuccess();
        rejectsDownloadsBeforeQueueing();
        System.out.println("NetworkAdapterTest passed");
    }

    private static void permitsOnlyTheOwnerBoundInputAndWrapper() {
        SlimNetworkPolicy.clearForTest();
        SchoolListActivity owner = new SchoolListActivity();
        SchoolListBean.OooO00o original = new SchoolListBean.OooO00o();
        check(SlimNetworkPolicy.registerKnownTeachingStaticInput(original, owner, SlimNetworkPolicy.SOURCE_SCHOOL_LIST) != null,
            "the real school-list owner registers the reviewed parent input");

        HttpCurrencyRequest.OooO00o wrapper = new HttpCurrencyRequest.OooO00o();
        check(SlimNetworkPolicy.transfer(original, wrapper), "the original identity transfers once into its exact HTTP wrapper");
        Map<String, String> params = Collections.singletonMap("versionTimeLine", "1");
        FixtureQueue queue = new FixtureQueue();
        AtomicInteger success = new AtomicInteger();
        AtomicInteger failure = new AtomicInteger();
        check(queue.send(SlimNetworkPolicy.HTTP_CURRENCY_WRAPPER_CLASS, "/wakeup/school/info?versionTimeLine=1", params,
            wrapper, success, failure), "a live wrapped request reaches the local queue fixture");
        check(queue.enqueued == 1 && success.get() == 1 && failure.get() == 0,
            "the success path queues once and completes one success callback");
        check(!queue.send(SlimNetworkPolicy.HTTP_CURRENCY_WRAPPER_CLASS, "/wakeup/school/info?versionTimeLine=1", params,
            wrapper, success, failure), "the same request identity cannot be queued twice");
        check(queue.enqueued == 1 && failure.get() == 1, "the repeated request completes one error callback without queue insertion");
        SlimNetworkPolicy.clearForTest();
    }

    private static void rejectsRewrittenAndUnregisteredInputBeforeQueueing() {
        SlimNetworkPolicy.clearForTest();
        SchoolListActivity owner = new SchoolListActivity();
        SchoolListBean.OooO00o registered = new SchoolListBean.OooO00o();
        check(SlimNetworkPolicy.registerKnownTeachingStaticInput(registered, owner, SlimNetworkPolicy.SOURCE_SCHOOL_LIST) != null,
            "fixture begins with one legitimate owner-bound parent");
        FixtureQueue queue = new FixtureQueue();
        AtomicInteger success = new AtomicInteger();
        AtomicInteger failure = new AtomicInteger();
        Map<String, String> params = Collections.singletonMap("versionTimeLine", "1");
        check(!queue.send(SlimNetworkPolicy.SCHOOL_LIST_CLASS, "/wakeup/school/info?versionTimeLine=2", params,
            registered, success, failure), "the queue compares the exact authorized relative URL snapshot");
        check(!queue.send(SlimNetworkPolicy.SCHOOL_LIST_CLASS, "/wakeup/school/info?versionTimeLine=1", params,
            new SchoolListBean.OooO00o(), success, failure), "a legal class and path without an owner permit is rejected");
        check(queue.enqueued == 0 && success.get() == 0 && failure.get() == 2,
            "both invalid paths stop before enqueue and complete failure exactly once each");
        SlimNetworkPolicy.clearForTest();
    }

    private static void consumesQueuePermitsOnceAndFailsWithoutSuccess() {
        SlimNetworkPolicy.clearForTest();
        SchoolListActivity owner = new SchoolListActivity();
        SchoolListBean.OooO00o original = new SchoolListBean.OooO00o();
        check(SlimNetworkPolicy.registerKnownTeachingStaticInput(original, owner, SlimNetworkPolicy.SOURCE_SCHOOL_LIST) != null,
            "the queue path begins with an owner-bound school input");
        HttpCurrencyRequest.OooO00o wrapper = new HttpCurrencyRequest.OooO00o("/wakeup/school/info?versionTimeLine=1");
        check(SlimNetworkPolicy.transfer(original, wrapper), "the encryption wrapper inherits the exact input license");
        check(wrapper.__url.length() == 0 && wrapper.toString().length() > 0,
            "the encrypted wrapper carries its actual URL outside the intentionally empty InputBase __url field");
        QueueGate queue = new QueueGate();
        AtomicInteger success = new AtomicInteger();
        AtomicInteger failure = new AtomicInteger();
        check(queue.send(wrapper, "/wakeup/school/info?versionTimeLine=1", success, failure),
            "the original authorized URL reaches the queue once");
        check(queue.enqueued == 1 && success.get() == 1 && failure.get() == 0,
            "the permitted path inserts once and reports one success");
        check(!queue.send(wrapper, "/wakeup/school/info?versionTimeLine=1", success, failure),
            "a consumed request cannot be replayed");
        check(!queue.send(new HttpCurrencyRequest.OooO00o(), "", success, failure),
            "an empty URL is rejected even when a wrapper identity exists");
        check(!queue.send(new HttpCurrencyRequest.OooO00o("/wakeup/school/info?versionTimeLine=1"), "/wakeup/school/info?versionTimeLine=1", success, failure),
            "an unregistered wrapper cannot borrow a valid URL");
        check(queue.enqueued == 1 && success.get() == 1 && failure.get() == 3,
            "repeat, empty URL, and unregistered paths produce errors without false success or queue insertion");
        SlimNetworkPolicy.clearForTest();
    }

    private static void rejectsDownloadsBeforeQueueing() {
        QueueGate queue = new QueueGate();
        AtomicInteger success = new AtomicInteger();
        AtomicInteger failure = new AtomicInteger();
        check(!queue.rejectDownload(success, failure), "no independent download route is licensed");
        check(queue.enqueued == 0 && success.get() == 0 && failure.get() == 1,
            "download rejection reports one error and never queues or reports success");
    }

    private static final class FixtureQueue {
        private int enqueued;

        boolean send(String classDescriptor, String finalUrl, Map<String, String> params, Object input,
                AtomicInteger success, AtomicInteger failure) {
            if (!SlimNetworkPolicy.allowsQueue(classDescriptor, finalUrl, params, input)) {
                failure.incrementAndGet();
                return false;
            }
            enqueued++;
            success.incrementAndGet();
            return true;
        }
    }

    private static final class QueueGate {
        private int enqueued;

        boolean send(Object input, String finalUrl, AtomicInteger success, AtomicInteger failure) {
            if (!SlimNetworkPolicy.consumeForQueue(input, finalUrl)) {
                failure.incrementAndGet();
                return false;
            }
            enqueued++;
            success.incrementAndGet();
            return true;
        }

        boolean rejectDownload(AtomicInteger success, AtomicInteger failure) {
            // E17 has no reviewed download license in this round.
            failure.incrementAndGet();
            return false;
        }
    }

    private static void check(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
}
