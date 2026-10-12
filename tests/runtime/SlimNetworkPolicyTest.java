package com.suda.yzune.wakeupschedule.slim;

import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicInteger;
import com.suda.yzune.wakeupschedule.aaa.model.SchoolListBean;
import com.suda.yzune.wakeupschedule.aaa.model.ScriptEnpluginBean;
import com.suda.yzune.wakeupschedule.schedule_import.LoginWebActivity;
import com.suda.yzune.wakeupschedule.schedule_import.DXParserLoginFragment;
import com.suda.yzune.wakeupschedule.schedule_import.v2.ParserFragment;
import o0OOOoO0.OooO0O0;

public final class SlimNetworkPolicyTest {
    private static final String SCHOOL = SlimNetworkPolicy.SCHOOL_LIST_CLASS;
    private static final String PLUGIN = SlimNetworkPolicy.SCRIPT_PLUGIN_CLASS;

    public static void main(String[] args) throws Exception {
        testStaticRoutes();
        testDynamicUrlBoundary();
        testIdentityTransferAndSingleUse();
        testLifecycleRevocationAndInvalidContext();
        testBoundWebViewRegistration();
        testProductionV2BridgeAdapterChecksRealOwnerAndView();
        testProductionDxBridgeAdapterChecksRealOwnerAndView();
        testEqualObjectsDoNotSharePermission();
        testConcurrentOwnersStayIsolated();
        testStaticMatchRequiresParentIdentity();
        testKnownStaticInputsRequireRouteOwner();
        testProductionStaticAdapterChecksRouteOwner();
        testBootstrapChildAndTransportAreScoped();
        testReflectedAntispamInputSnapshot();
        testBootstrapOwnerRevocationAndRetry();
        System.out.println("SlimNetworkPolicyTest passed");
    }

    private static void testStaticRoutes() {
        check(SlimNetworkPolicy.allowsStatic(SCHOOL, "/wakeup/school/info", Collections.<String, String>emptyMap()), "school info relative path allowed");
        check(SlimNetworkPolicy.allowsStatic(SCHOOL, "https://api.wakeup.fun/wakeup/school/info", Collections.<String, String>emptyMap()), "school info API URL allowed");
        check(!SlimNetworkPolicy.allowsStatic(SCHOOL, "https://api.wakeup.fun/wakeup/user/info", Collections.<String, String>emptyMap()), "school class cannot call user API");
        check(!SlimNetworkPolicy.allowsStatic("Lother/Class;", "/wakeup/school/info", Collections.<String, String>emptyMap()), "wrong request class rejected");
        check(!SlimNetworkPolicy.allowsStatic(SCHOOL, "/wakeup/school/../user/info", Collections.<String, String>emptyMap()), "path traversal rejected");
        String[][] pairs = { {"index", "node-course-parser"}, {"wakeup_schedule_inject_script", "wakeup_schedule"}, {"index", "table-image-export"} };
        for (String[] pair : pairs) {
            Map<String, String> parameters = new HashMap<String, String>();
            parameters.put("type", pair[0]);
            parameters.put("name", pair[1]);
            check(SlimNetworkPolicy.allowsStatic(PLUGIN, "/wakeup/script/enplugin", parameters), "approved script pair allowed");
        }
        Map<String, String> tracking = new HashMap<String, String>();
        tracking.put("type", "tracking");
        tracking.put("name", "wakeup-tracking-inject-script");
        check(!SlimNetworkPolicy.allowsStatic(PLUGIN, "/wakeup/script/enplugin", tracking), "tracking plugin rejected");
        check(!SlimNetworkPolicy.allowsStatic(PLUGIN, "/wakeup/script/enplugin", Collections.<String, String>emptyMap()), "missing plugin parameters rejected");
        check(!SlimNetworkPolicy.allowsStatic(PLUGIN, "/wakeup/script/other", Collections.<String, String>emptyMap()), "other script path rejected");
    }

    private static void testDynamicUrlBoundary() {
        Object request = new Object();
        Object owner = new Object();
        Object webView = new Object();
        check(register(request, owner, webView, "https://api.wakeup.fun/wakeup/script/parse?step=1", SlimNetworkPolicy.SOURCE_V2), "official parser bridge URL allowed");
        SlimNetworkPolicy.clearForTest();
        String[] rejected = {
            "https://api.wakeup.fun.evil.invalid/wakeup/script/parse",
            "https://api.wakeup.fun@evil.invalid/wakeup/script/parse",
            "https://api.wakeup.fun:444/wakeup/script/parse",
            "https://api.wakeup.fun/wakeup/script/../user/info",
            "https://api.wakeup.fun/wakeup/user/info",
            "https://api.wakeup.fun/wakeup/share_schedule/getv2",
            "ftp://api.wakeup.fun/wakeup/script/parse",
            "https://api.wakeup.fun/%2f/wakeup/script/parse"
        };
        for (String url : rejected) {
            check(!register(new Object(), new Object(), webView, url, SlimNetworkPolicy.SOURCE_V2), "unsafe URL rejected: " + url);
        }
    }

    private static void testIdentityTransferAndSingleUse() {
        Object raw = new Object();
        Object wrapper = new Object();
        Object owner = new Object();
        Object webView = new Object();
        check(register(raw, owner, webView, "https://api.wakeup.fun/wakeup/script/parse", SlimNetworkPolicy.SOURCE_DX), "DX request registered");
        check(SlimNetworkPolicy.transfer(raw, wrapper), "raw permission transfers to wrapper");
        check(!SlimNetworkPolicy.consume(raw), "raw permission was moved");
        check(SlimNetworkPolicy.consume(wrapper), "wrapper permission consumed at queue");
        check(!SlimNetworkPolicy.consume(wrapper), "permission is single use");
        check(!SlimNetworkPolicy.transfer(raw, new Object()), "repeated transfer rejected");
        check(!SlimNetworkPolicy.transfer(new Object(), new Object()), "unregistered wrapper rejected");

        Object emptyUrlRaw = new Object();
        check(register(emptyUrlRaw, new Object(), new Object(), "https://api.wakeup.fun/wakeup/script/parse", SlimNetworkPolicy.SOURCE_V2),
            "valid owner registration precedes the empty-URL rejection check");
        check(!SlimNetworkPolicy.consumeForQueue(emptyUrlRaw, ""), "an empty final request URL is never an allow case");
        check(!SlimNetworkPolicy.consume(emptyUrlRaw), "the failed empty-URL attempt cannot be replayed");
        SlimNetworkPolicy.clearForTest();
    }

    private static void testLifecycleRevocationAndInvalidContext() {
        Object request = new Object();
        Object owner = new Object();
        Object webView = new Object();
        check(!SlimNetworkPolicy.registerDynamic(request, owner, webView, new Object(), "https://api.wakeup.fun/wakeup/script/parse", SlimNetworkPolicy.SOURCE_V2, true, true, false), "unbound WebView rejected");
        check(!SlimNetworkPolicy.registerDynamic(new Object(), owner, webView, webView, "https://api.wakeup.fun/wakeup/script/parse", SlimNetworkPolicy.SOURCE_V2, false, true, false), "detached Fragment rejected");
        check(!SlimNetworkPolicy.registerDynamic(new Object(), owner, webView, webView, "https://api.wakeup.fun/wakeup/script/parse", SlimNetworkPolicy.SOURCE_V2, true, false, false), "wrong Activity rejected");
        check(!SlimNetworkPolicy.registerDynamic(new Object(), owner, webView, webView, "https://api.wakeup.fun/wakeup/script/parse", SlimNetworkPolicy.SOURCE_V2, true, true, true), "destroyed Activity rejected");
        check(register(request, owner, webView, "https://api.wakeup.fun/wakeup/script/parse", SlimNetworkPolicy.SOURCE_V2), "valid request registered");
        check(SlimNetworkPolicy.revokeOwner(owner) == 1, "owner cleanup removes its unconsumed request");
        check(!SlimNetworkPolicy.consume(request), "revoked request cannot be consumed");
        check(SlimNetworkPolicy.pendingCountForTest() == 0, "cleanup is deterministic");
        SlimNetworkPolicy.clearForTest();
    }

    private static void testBoundWebViewRegistration() {
        Object owner = new Object();
        Object webView = new Object();
        Object staleWebView = new Object();
        Object raw = new Object();
        Object wrapper = new Object();
        check(SlimNetworkPolicy.bindCurrentWebView(owner, webView), "current parser WebView is bound to its owner");
        check(SlimNetworkPolicy.registerBoundDynamic(raw, owner, webView,
            "https://api.wakeup.fun/wakeup/script/parse?step=1", SlimNetworkPolicy.SOURCE_V2, true, true, false),
            "raw request from the currently bound WebView is registered");
        check(!SlimNetworkPolicy.registerBoundDynamic(new Object(), owner, staleWebView,
            "https://api.wakeup.fun/wakeup/script/parse?step=2", SlimNetworkPolicy.SOURCE_V2, true, true, false),
            "stale WebView cannot register a request");
        check(!SlimNetworkPolicy.registerBoundDynamic(new Object(), new EqualObject(), webView,
            "https://api.wakeup.fun/wakeup/script/parse?step=3", SlimNetworkPolicy.SOURCE_V2, true, true, false),
            "unrelated equal-shaped owner cannot borrow a current WebView binding");
        check(SlimNetworkPolicy.transfer(raw, wrapper), "bound raw request transfers to its exact encrypted wrapper");
        check(SlimNetworkPolicy.consumeForQueue(wrapper, "https://api.wakeup.fun/wakeup/script/parse?step=1"),
            "transferred request consumes its exact URL snapshot");

        Object staleRequest = new Object();
        check(SlimNetworkPolicy.registerBoundDynamic(staleRequest, owner, webView,
            "https://api.wakeup.fun/wakeup/script/parse?step=4", SlimNetworkPolicy.SOURCE_V2, true, true, false),
            "same view remains current until lifecycle replacement");
        Object replacement = new Object();
        check(SlimNetworkPolicy.bindCurrentWebView(owner, replacement), "replacement view supersedes the old view");
        check(!SlimNetworkPolicy.registerBoundDynamic(new Object(), owner, webView,
            "https://api.wakeup.fun/wakeup/script/parse?step=5", SlimNetworkPolicy.SOURCE_V2, true, true, false),
            "replaced WebView cannot register another request");
        check(SlimNetworkPolicy.revokeOwner(owner) == 1, "owner destruction revokes remaining requests");
        check(!SlimNetworkPolicy.registerBoundDynamic(new Object(), owner, replacement,
            "https://api.wakeup.fun/wakeup/script/parse?step=6", SlimNetworkPolicy.SOURCE_V2, true, true, false),
            "destroyed owner loses the view binding");
        SlimNetworkPolicy.clearForTest();
    }

    private static void testProductionV2BridgeAdapterChecksRealOwnerAndView() {
        SlimNetworkPolicy.clearForTest();
        LoginWebActivity activity = new LoginWebActivity();
        ParserFragment owner = new ParserFragment();
        Object currentView = new Object();
        owner.activity = activity;
        owner.oOooo0o = currentView;
        check(SlimNetworkPolicy.bindCurrentWebView(owner, currentView), "v2 view creation records the current WebView before bridge actions");

        OooO0O0 input = new OooO0O0("https://api.wakeup.fun/wakeup/script/parse?step=1");
        check(SlimNetworkPolicy.registerV2BridgeInput(input, owner, activity, currentView, input.toString()),
            "production v2 adapter accepts the exact attached LoginWebActivity and current WebView");
        check(SlimNetworkPolicy.ownerFor(SlimNetworkPolicy.parentFor(input)) == owner,
            "registered v2 parent retains the concrete Fragment owner identity");
        check(!SlimNetworkPolicy.registerV2BridgeInput(input, owner, activity, currentView, input.toString()),
            "same raw input cannot be registered twice");
        check(SlimNetworkPolicy.revokeOwner(owner) == 1, "view teardown revokes the production adapter permit");

        OooO0O0 stale = new OooO0O0("https://api.wakeup.fun/wakeup/script/parse?step=2");
        check(SlimNetworkPolicy.registerV2BridgeInput(stale, owner, activity, new Object(), stale.toString()) == false,
            "a WebView other than the Fragment's current field is rejected");
        activity.destroyed = true;
        check(!SlimNetworkPolicy.registerV2BridgeInput(stale, owner, activity, currentView, stale.toString()),
            "destroyed LoginWebActivity is rejected");
        activity.destroyed = false;
        owner.added = false;
        check(!SlimNetworkPolicy.registerV2BridgeInput(stale, owner, activity, currentView, stale.toString()),
            "detached Fragment is rejected");
        owner.added = true;
        activity.finishing = true;
        check(!SlimNetworkPolicy.registerV2BridgeInput(stale, owner, activity, currentView, stale.toString()),
            "finishing LoginWebActivity is rejected");
        SlimNetworkPolicy.clearForTest();
    }

    private static void testProductionDxBridgeAdapterChecksRealOwnerAndView() {
        SlimNetworkPolicy.clearForTest();
        LoginWebActivity activity = new LoginWebActivity();
        DXParserLoginFragment owner = new DXParserLoginFragment();
        Object currentView = new Object();
        owner.activity = activity;
        owner.oOooo0o = currentView;
        check(SlimNetworkPolicy.bindCurrentWebView(owner, currentView), "DX view creation records the current WebView before iframe actions");
        OooO0O0 input = new OooO0O0("https://api.wakeup.fun/wakeup/script/parse?step=dx");
        check(SlimNetworkPolicy.registerDxBridgeInput(input, owner, activity, currentView, input.toString()),
            "production DX adapter accepts the current iframe bridge owner and view");
        check(SlimNetworkPolicy.parentFor(input) != null, "DX request receives an owner-bound parent identity");
        check(SlimNetworkPolicy.revokeOwner(owner) == 1, "DX view teardown revokes its request permit");
        check(!SlimNetworkPolicy.registerDxBridgeInput(new OooO0O0("https://api.wakeup.fun/wakeup/script/parse"),
            owner, activity, currentView, "https://api.wakeup.fun/wakeup/script/parse"),
            "DX registration fails after the owner is destroyed");
        SlimNetworkPolicy.clearForTest();
    }

    private static void testEqualObjectsDoNotSharePermission() {
        EqualObject one = new EqualObject();
        EqualObject two = new EqualObject();
        Object owner = new Object();
        Object webView = new Object();
        check(register(one, owner, webView, "https://api.wakeup.fun/wakeup/script/parse", SlimNetworkPolicy.SOURCE_V2), "first equal request registered");
        check(!SlimNetworkPolicy.consume(two), "equals-equal other request has no permission");
        check(SlimNetworkPolicy.consume(one), "identity owner can consume permission");
        SlimNetworkPolicy.clearForTest();
    }

    private static void testConcurrentOwnersStayIsolated() throws Exception {
        final int threads = 12;
        final CountDownLatch ready = new CountDownLatch(threads);
        final CountDownLatch start = new CountDownLatch(1);
        final AtomicInteger failures = new AtomicInteger();
        Thread[] workers = new Thread[threads];
        for (int i = 0; i < threads; i++) {
            workers[i] = new Thread(new Runnable() {
                @Override public void run() {
                    Object request = new Object();
                    Object owner = new Object();
                    Object view = new Object();
                    ready.countDown();
                    try { start.await(); } catch (InterruptedException exception) { Thread.currentThread().interrupt(); failures.incrementAndGet(); return; }
                    if (!register(request, owner, view, "https://api.wakeup.fun/wakeup/script/parse", SlimNetworkPolicy.SOURCE_DX)) failures.incrementAndGet();
                    if (!SlimNetworkPolicy.transfer(request, new Wrapper(request, owner, view))) failures.incrementAndGet();
                    if (SlimNetworkPolicy.revokeOwner(owner) != 1) failures.incrementAndGet();
                }
            });
            workers[i].start();
        }
        ready.await();
        start.countDown();
        for (Thread worker : workers) worker.join();
        check(failures.get() == 0, "concurrent requests remain owner isolated");
        check(SlimNetworkPolicy.pendingCountForTest() == 0, "concurrent cleanup leaves no stale permission");
        SlimNetworkPolicy.clearForTest();
    }

    private static void testStaticMatchRequiresParentIdentity() {
        Map<String, String> empty = Collections.emptyMap();
        String url = "https://api.wakeup.fun/wakeup/school/info";
        SchoolListBean.OooO00o request = new SchoolListBean.OooO00o();
        check(SlimNetworkPolicy.allowsStatic(SCHOOL, url, empty), "static route is a qualification only");
        check(!SlimNetworkPolicy.allowsQueue(SCHOOL, url, empty, request), "static match without a teaching owner cannot send");

        Object owner = new Object();
        SlimNetworkPolicy.ParentToken parent = SlimNetworkPolicy.registerKnownStaticInput(
            request, owner, SlimNetworkPolicy.SOURCE_SCHOOL_LIST, true);
        check(parent != null, "live SchoolListActivity route issues opaque parent");
        check(!SlimNetworkPolicy.allowsQueue("Lother/Request;", url, empty, request), "wrong request class cannot spend a school-list permit");
        check(!SlimNetworkPolicy.allowsQueue(SCHOOL, url, empty, request), "failed class check revokes rather than retaining its permit");

        SchoolListBean.OooO00o validRequest = new SchoolListBean.OooO00o();
        parent = SlimNetworkPolicy.registerKnownStaticInput(validRequest, owner, SlimNetworkPolicy.SOURCE_SCHOOL_LIST, true);
        check(parent != null, "a valid request receives a new owner-bound parent after failed class check");
        check(SlimNetworkPolicy.allowsQueue(SCHOOL, validRequest.toString(), empty, validRequest), "registered parent permits its exact request once");
        check(!SlimNetworkPolicy.allowsQueue(SCHOOL, validRequest.toString(), empty, validRequest), "static parent cannot replay");

        SchoolListBean.OooO00o rewritten = new SchoolListBean.OooO00o();
        SlimNetworkPolicy.ParentToken rewrittenParent = SlimNetworkPolicy.registerKnownStaticInput(
            rewritten, owner, SlimNetworkPolicy.SOURCE_SCHOOL_LIST, true);
        check(rewrittenParent != null, "second independent request receives its own parent");
        check(!SlimNetworkPolicy.allowsQueue(SCHOOL, "https://api.wakeup.fun/wakeup/user/info", empty, rewritten), "URL rewrite fails the queue guard");
        check(SlimNetworkPolicy.enterBootstrap(rewrittenParent) == null, "rewritten request cannot start bootstrap");
        SlimNetworkPolicy.clearForTest();
    }

    private static void testKnownStaticInputsRequireRouteOwner() {
        Object schoolActivity = new Object();
        SchoolListBean.OooO00o schoolRequest = new SchoolListBean.OooO00o();
        SlimNetworkPolicy.ParentToken schoolParent = SlimNetworkPolicy.registerKnownStaticInput(
            schoolRequest, schoolActivity, SlimNetworkPolicy.SOURCE_SCHOOL_LIST, true);
        check(schoolParent != null, "exact SchoolListBean request registers from its active route");
        Object schoolWrapper = new Object();
        check(SlimNetworkPolicy.transfer(schoolRequest, schoolWrapper), "school-list parent transfers to its encrypted wrapper");
        check(SlimNetworkPolicy.allowsQueue(SlimNetworkPolicy.HTTP_CURRENCY_WRAPPER_CLASS,
            "https://api.wakeup.fun/wakeup/school/info?versionTimeLine=1",
            Collections.<String, String>emptyMap(), schoolWrapper), "relative school path matches its resolved official API URL");

        Object parser = new Object();
        ScriptEnpluginBean.OooO00o plugin = new ScriptEnpluginBean.OooO00o("index", "node-course-parser");
        SlimNetworkPolicy.ParentToken pluginParent = SlimNetworkPolicy.registerKnownStaticInput(
            plugin, parser, SlimNetworkPolicy.SOURCE_V2, true);
        check(pluginParent != null, "exact parser plugin pair registers from an active parser");
        Map<String, String> params = new HashMap<String, String>();
        params.put("type", "index");
        params.put("name", "node-course-parser");
        check(SlimNetworkPolicy.allowsQueue(PLUGIN, plugin.toString(), params, plugin), "exact parser plugin reaches the queue gate");

        ScriptEnpluginBean.OooO00o webViewPlugin = new ScriptEnpluginBean.OooO00o("index", "table-image-export");
        check(SlimNetworkPolicy.registerKnownStaticInput(webViewPlugin, parser, SlimNetworkPolicy.SOURCE_WEBVIEW, true) != null,
            "legacy WebView table-image parser endpoint has an owner-bound permit");
        Object webViewWrapper = new Object();
        check(SlimNetworkPolicy.transfer(webViewPlugin, webViewWrapper), "legacy plugin permit transfers once");
        params.put("name", "table-image-export");
        check(SlimNetworkPolicy.allowsQueue(SlimNetworkPolicy.HTTP_CURRENCY_WRAPPER_CLASS,
            webViewPlugin.toString(), params, webViewWrapper), "legacy plugin wrapper is checked against the registered URL");

        ScriptEnpluginBean.OooO00o tracking = new ScriptEnpluginBean.OooO00o("tracking", "wakeup-tracking-inject-script");
        check(SlimNetworkPolicy.registerKnownStaticInput(tracking, parser, SlimNetworkPolicy.SOURCE_V2, true) == null,
            "tracking plugin pair never receives a parent");
        check(SlimNetworkPolicy.registerKnownStaticInput(new Object(), parser, SlimNetworkPolicy.SOURCE_V2, true) == null,
            "unknown input class cannot use a static parent helper");
        check(SlimNetworkPolicy.registerKnownStaticInput(new ScriptEnpluginBean.OooO00o("index", "table-image-export"),
            parser, SlimNetworkPolicy.SOURCE_WEBVIEW, false) == null,
            "inactive legacy owner cannot register a plugin request");
        SlimNetworkPolicy.clearForTest();
    }

    private static void testProductionStaticAdapterChecksRouteOwner() {
        SlimNetworkPolicy.clearForTest();
        LoginWebActivity activity = new LoginWebActivity();
        ParserFragment parser = new ParserFragment();
        parser.activity = activity;
        parser.oOooo0o = new Object();
        ScriptEnpluginBean.OooO00o plugin = new ScriptEnpluginBean.OooO00o("index", "node-course-parser");
        SlimNetworkPolicy.ParentToken parent = SlimNetworkPolicy.registerKnownTeachingStaticInput(
            plugin, parser, SlimNetworkPolicy.SOURCE_V2);
        check(parent != null && SlimNetworkPolicy.parentFor(plugin) == parent,
            "production static adapter accepts only the active v2 parser owner with a live WebView");
        check(SlimNetworkPolicy.registerKnownTeachingStaticInput(
            new ScriptEnpluginBean.OooO00o("index", "node-course-parser"), parser, SlimNetworkPolicy.SOURCE_DX) == null,
            "v2 Fragment cannot claim the DX route source");
        check(SlimNetworkPolicy.registerKnownTeachingStaticInput(
            new ScriptEnpluginBean.OooO00o("index", "node-course-parser"), new Object(), SlimNetworkPolicy.SOURCE_V2) == null,
            "a static path match without the concrete teaching owner is insufficient");
        Object oldView = parser.oOooo0o;
        check(SlimNetworkPolicy.revokeOwner(parser) == 1, "static plugin owner teardown removes its permit");
        check(SlimNetworkPolicy.registerKnownTeachingStaticInput(
            new ScriptEnpluginBean.OooO00o("index", "node-course-parser"), parser, SlimNetworkPolicy.SOURCE_V2) == null,
            "the destroyed view cannot re-register itself before recreation");
        parser.oOooo0o = new Object();
        check(SlimNetworkPolicy.registerKnownTeachingStaticInput(
            new ScriptEnpluginBean.OooO00o("index", "node-course-parser"), parser, SlimNetworkPolicy.SOURCE_V2) != null,
            "a recreated Fragment view can register its new WebView identity");
        check(parser.oOooo0o != oldView, "recreation uses a fresh WebView object");

        ParserFragment detached = new ParserFragment();
        detached.activity = activity;
        detached.added = false;
        detached.oOooo0o = new Object();
        check(SlimNetworkPolicy.registerKnownTeachingStaticInput(
            new ScriptEnpluginBean.OooO00o("index", "node-course-parser"), detached, SlimNetworkPolicy.SOURCE_V2) == null,
            "detached Fragment cannot register a static script permit");
        SlimNetworkPolicy.clearForTest();
    }

    private static void testBootstrapChildAndTransportAreScoped() {
        SlimNetworkPolicy.clearForTest();
        String responseClass = "Lcom/baidu/homework/common/net/model/v1/PlutoAntispam;";
        check(!SlimNetworkPolicy.registerBootstrapChild(new Object(), SlimNetworkPolicy.ANTISPAM_URL, "secret", "antispam", 1, responseClass),
            "an exact static antispam URL cannot create a child permit without a live teaching parent scope");

        Object request = new Object();
        Object owner = new Object();
        Object view = new Object();
        String parserUrl = "https://api.wakeup.fun/wakeup/script/parse";
        check(register(request, owner, view, parserUrl, SlimNetworkPolicy.SOURCE_V2), "parser request creates parent identity");
        SlimNetworkPolicy.ParentToken parent = SlimNetworkPolicy.parentFor(request);
        check(parent != null, "parent token can be explicitly propagated to worker");
        SlimNetworkPolicy.BootstrapScope scope = SlimNetworkPolicy.enterBootstrap(parent);
        check(scope != null, "worker enters a short bootstrap scope");
        Object antispamInput = new Object();
        check(!SlimNetworkPolicy.bindBootstrapTransport(antispamInput, new Object(), SlimNetworkPolicy.ANTISPAM_URL), "transport cannot be minted before exact child consumption");
        check(!SlimNetworkPolicy.registerBootstrapChild(antispamInput, "https://pluto.zuoyebang.com/pluto/app/antispam", "secret", "antispam", 1, responseClass), "non-default host is rejected");
        check(!SlimNetworkPolicy.registerBootstrapChild(antispamInput, "https://api.wakeup.fun.evil/pluto/app/antispam", "secret", "antispam", 1, responseClass), "suffix lookalike host is rejected rather than broadly allowing the antispam domain");
        check(!SlimNetworkPolicy.registerBootstrapChild(antispamInput, "https://evil.api.wakeup.fun/pluto/app/antispam", "secret", "antispam", 1, responseClass), "unlisted subdomain is rejected");
        check(!SlimNetworkPolicy.registerBootstrapChild(antispamInput, "https://api.wakeup.fun:444/pluto/app/antispam", "secret", "antispam", 1, responseClass), "non-default TLS port is rejected");
        check(!SlimNetworkPolicy.registerBootstrapChild(antispamInput, "https://api.wakeup.fun/pluto/app/antispam/child", "secret", "antispam", 1, responseClass), "antispam path prefix is not treated as a broad route grant");
        check(!SlimNetworkPolicy.registerBootstrapChild(antispamInput, "https://user@api.wakeup.fun/pluto/app/antispam", "secret", "antispam", 1, responseClass), "userinfo cannot disguise the exact antispam host");
        check(!SlimNetworkPolicy.registerBootstrapChild(antispamInput, SlimNetworkPolicy.ANTISPAM_URL, "", "antispam", 1, responseClass), "empty signA is rejected");
        check(!SlimNetworkPolicy.registerBootstrapChild(antispamInput, SlimNetworkPolicy.ANTISPAM_URL, "secret", "userinfra", 1, responseClass), "wrong pid is rejected");
        check(!SlimNetworkPolicy.registerBootstrapChild(antispamInput, SlimNetworkPolicy.ANTISPAM_URL, "secret", "antispam", 1, "Ljava/lang/Object;"), "wrong response class is rejected");
        check(SlimNetworkPolicy.registerBootstrapChild(antispamInput, SlimNetworkPolicy.ANTISPAM_URL, "secret", "antispam", 1, responseClass), "exact bootstrap child is registered");
        check(!SlimNetworkPolicy.registerBootstrapChild(new Object(), SlimNetworkPolicy.ANTISPAM_URL, "secret", "antispam", 1, responseClass), "one scope cannot register a second child");
        check(!SlimNetworkPolicy.consumeBootstrapChild(antispamInput, "https://api.wakeup.fun/pluto/app/antispam?rewrite=1", "secret", "antispam", 1, responseClass), "final URL rewrite rejects child and consumes its single permit");

        Object validInput = new Object();
        SlimNetworkPolicy.BootstrapScope secondScope = enterFreshScope(request, owner, view);
        check(SlimNetworkPolicy.registerBootstrapChild(validInput, SlimNetworkPolicy.ANTISPAM_URL, "secret", "antispam", 1, responseClass), "fresh parent scope can retry after failure");
        check(SlimNetworkPolicy.consumeBootstrapChild(validInput, SlimNetworkPolicy.ANTISPAM_URL, "secret", "antispam", 1, responseClass), "exact child is consumed before construction/send");
        Object volleyRequest = new Object();
        check(!SlimNetworkPolicy.bindBootstrapTransport(antispamInput, volleyRequest, SlimNetworkPolicy.ANTISPAM_URL), "transport input must be the consumed child identity");
        check(SlimNetworkPolicy.bindBootstrapTransport(validInput, volleyRequest, SlimNetworkPolicy.ANTISPAM_URL), "exact synchronous Request receives local transport proof");
        check(SlimNetworkPolicy.hasBootstrapTransport(volleyRequest), "transport proof is tied to Request identity");
        check(SlimNetworkPolicy.claimBootstrapTransport(volleyRequest, SlimNetworkPolicy.ANTISPAM_URL), "E53 claims proof once before execute");
        check(!SlimNetworkPolicy.claimBootstrapTransport(volleyRequest, SlimNetworkPolicy.ANTISPAM_URL), "transport proof is not replayable");
        secondScope.close();
        check(!SlimNetworkPolicy.hasBootstrapTransport(volleyRequest), "finally removes the proof");
        scope.close();
        SlimNetworkPolicy.clearForTest();
    }

    private static SlimNetworkPolicy.BootstrapScope enterFreshScope(Object oldRequest, Object owner, Object view) {
        Object request = new Object();
        check(register(request, owner, view, "https://api.wakeup.fun/wakeup/script/parse?retry=1", SlimNetworkPolicy.SOURCE_V2), "retry request receives new parent identity");
        SlimNetworkPolicy.ParentToken parent = SlimNetworkPolicy.parentFor(request);
        check(parent != null && parent != SlimNetworkPolicy.parentFor(oldRequest), "retry parent is distinct from the prior request");
        SlimNetworkPolicy.BootstrapScope scope = SlimNetworkPolicy.enterBootstrap(parent);
        check(scope != null, "retry request enters its own scope");
        return scope;
    }

    private static void testBootstrapOwnerRevocationAndRetry() {
        Object request = new Object();
        Object owner = new Object();
        Object view = new Object();
        check(register(request, owner, view, "https://api.wakeup.fun/wakeup/script/parse", SlimNetworkPolicy.SOURCE_DX), "DX parent request registers");
        SlimNetworkPolicy.ParentToken parent = SlimNetworkPolicy.parentFor(request);
        SlimNetworkPolicy.BootstrapScope scope = SlimNetworkPolicy.enterBootstrap(parent);
        check(scope != null, "DX parent enters bootstrap");
        check(SlimNetworkPolicy.revokeOwner(owner) == 1, "owner destruction revokes the request");
        check(!SlimNetworkPolicy.registerBootstrapChild(new Object(), SlimNetworkPolicy.ANTISPAM_URL, "secret", "antispam", 1,
            "Lcom/baidu/homework/common/net/model/v1/PlutoAntispam;"), "destroyed owner cannot register a late child");
        scope.close();
        check(SlimNetworkPolicy.enterBootstrap(parent) == null, "one parent permits at most one init attempt");
        SlimNetworkPolicy.clearForTest();
    }

    private static void testReflectedAntispamInputSnapshot() {
        Object parentInput = new Object();
        Object owner = new Object();
        Object view = new Object();
        check(register(parentInput, owner, view, "https://api.wakeup.fun/wakeup/script/parse", SlimNetworkPolicy.SOURCE_V2), "reflection fixture parent is live");
        SlimNetworkPolicy.BootstrapScope scope = SlimNetworkPolicy.enterBootstrap(SlimNetworkPolicy.parentFor(parentInput));
        check(scope != null && SlimNetworkPolicy.isBootstrapActive(), "reflection fixture runs only within owner-bound scope");

        com.baidu.homework.common.net.model.v1.PlutoAntispam$OooO00o child =
            new com.baidu.homework.common.net.model.v1.PlutoAntispam$OooO00o("opaque");
        check(SlimNetworkPolicy.registerBootstrapChild(child), "exact E42 input snapshot registers");
        check(!SlimNetworkPolicy.registerBootstrapChild(new com.baidu.homework.common.net.model.v1.PlutoAntispam$OooO00o("second")), "scope issues one input identity only");
        check(SlimNetworkPolicy.consumeBootstrapChild(child, child.toString()), "E43 consumes the unchanged input snapshot");
        check(SlimNetworkPolicy.isConsumedBootstrapChild(child), "consumed child identity can bind only its synchronous Request");

        Object request = new Object();
        check(!SlimNetworkPolicy.bindBootstrapTransport(new Object(), request, child.toString()), "unrelated input cannot bind transport");
        check(SlimNetworkPolicy.bindBootstrapTransport(child, request, child.toString()), "request binds to the consumed child and full URL snapshot");
        check(!SlimNetworkPolicy.claimBootstrapTransport(request, "https://api.wakeup.fun/pluto/app/antispam?data=changed"), "changed final URL fails closed");
        scope.close();
        SlimNetworkPolicy.clearForTest();

        Object invalidParent = new Object();
        Object invalidOwner = new Object();
        Object invalidView = new Object();
        check(register(invalidParent, invalidOwner, invalidView, "https://api.wakeup.fun/wakeup/script/parse", SlimNetworkPolicy.SOURCE_DX), "second parent is live");
        SlimNetworkPolicy.BootstrapScope invalidScope = SlimNetworkPolicy.enterBootstrap(SlimNetworkPolicy.parentFor(invalidParent));
        com.baidu.homework.common.net.model.v1.PlutoAntispam$OooO00o invalid =
            new com.baidu.homework.common.net.model.v1.PlutoAntispam$OooO00o("opaque");
        invalid.finalUrl = "https://pluto.zuoyebang.com/pluto/app/antispam?data=opaque";
        check(!SlimNetworkPolicy.registerBootstrapChild(invalid), "nondefault Pluto host override is rejected");
        invalid.finalUrl = SlimNetworkPolicy.ANTISPAM_URL + "?data=opaque";
        invalid.__pid = "userinfra";
        check(!SlimNetworkPolicy.registerBootstrapChild(invalid), "wrong pid is rejected by actual input snapshot");
        invalid.__pid = "antispam";
        invalid.__method = 0;
        check(!SlimNetworkPolicy.registerBootstrapChild(invalid), "wrong method is rejected by actual input snapshot");
        invalid.__method = 1;
        invalid.__aClass = String.class;
        check(!SlimNetworkPolicy.registerBootstrapChild(invalid), "wrong response class is rejected by actual input snapshot");
        invalidScope.close();
        SlimNetworkPolicy.clearForTest();
    }

    private static boolean register(Object request, Object owner, Object view, String url, String source) {
        return SlimNetworkPolicy.registerDynamic(request, owner, view, view, url, source, true, true, false);
    }

    private static void check(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }

    private static final class EqualObject {
        @Override public int hashCode() { return 7; }
        @Override public boolean equals(Object other) { return other instanceof EqualObject; }
    }

    private static final class Wrapper {
        @SuppressWarnings("unused") private final Object request;
        @SuppressWarnings("unused") private final Object owner;
        @SuppressWarnings("unused") private final Object webView;
        private Wrapper(Object request, Object owner, Object webView) { this.request = request; this.owner = owner; this.webView = webView; }
    }
}
