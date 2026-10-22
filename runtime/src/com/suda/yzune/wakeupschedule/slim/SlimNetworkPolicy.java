package com.suda.yzune.wakeupschedule.slim;

import java.lang.ref.ReferenceQueue;
import java.lang.ref.WeakReference;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.net.URI;
import java.net.URISyntaxException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

/** Narrow request permissions for the existing school and parser bridges. */
public final class SlimNetworkPolicy {
    public static final String SCHOOL_LIST_CLASS = "Lcom/suda/yzune/wakeupschedule/aaa/model/SchoolListBean$OooO00o;";
    public static final String SCRIPT_PLUGIN_CLASS = "Lcom/suda/yzune/wakeupschedule/aaa/model/ScriptEnpluginBean$OooO00o;";
    public static final String RAW_BRIDGE_CLASS = "Lo0Oo0o00/o00Ooo;";
    public static final String HTTP_CURRENCY_WRAPPER_CLASS = "Lcom/suda/yzune/wakeupschedule/aaa/v1/HttpCurrencyRequest$OooO00o;";
    public static final String DX_HTTP_WRAPPER_CLASS = "Lcom/suda/yzune/wakeupschedule/aaa/v1/HybridHttpCurrencyRequest$OooO00o;";
    public static final String API_HOST = "api.wakeup.fun";
    public static final String SOURCE_V2 = "v2-parser-config-webview";
    public static final String SOURCE_DX = "dx-parser-on-action";
    public static final String SOURCE_SCHOOL_LIST = "school-list-teaching-route";
    public static final String SOURCE_WEBVIEW = "legacy-parser-webview";
    public static final String ANTISPAM_URL = "https://api.wakeup.fun/pluto/app/antispam";

    private static final ReferenceQueue<Object> COLLECTED = new ReferenceQueue<Object>();
    private static final Map<IdentityWeakReference, License> DYNAMIC = new HashMap<IdentityWeakReference, License>();
    private static final Map<IdentityWeakReference, WeakReference<Object>> CURRENT_WEBVIEWS = new HashMap<IdentityWeakReference, WeakReference<Object>>();
    private static final Map<IdentityWeakReference, Boolean> REVOKED_OWNERS = new HashMap<IdentityWeakReference, Boolean>();
    private static final Map<IdentityWeakReference, WeakReference<Object>> REVOKED_WEBVIEWS = new HashMap<IdentityWeakReference, WeakReference<Object>>();
    private static final Map<IdentityWeakReference, ChildLicense> BOOTSTRAP_CHILDREN = new HashMap<IdentityWeakReference, ChildLicense>();
    private static final Map<IdentityWeakReference, TransportProof> BOOTSTRAP_TRANSPORTS = new HashMap<IdentityWeakReference, TransportProof>();
    private static final ThreadLocal<BootstrapScope> CURRENT_BOOTSTRAP = new ThreadLocal<BootstrapScope>();
    private static final String[] FORBIDDEN_PATH_MARKERS = {
        "/share_schedule", "/share_schedulev2", "/share_schedule/getv2", "/user/", "/mine/",
        "/calendar", "/cloud", "/sync", "/auto_update", "/update/", "/banner", "/ad/",
        "/conf", "/skin", "/log", "/collect", "/holiday", "/ocr", "/feedback", "/push/",
        "/hybrid/", "/pay/", "/vip/", "/account/", "/session/", "/aiparse/submit", "/feedback/"
    };

    private SlimNetworkPolicy() { }

    /** Static request classes get only their reviewed endpoint and method parameters. */
    public static boolean allowsStatic(String classDescriptor, String url, Map<String, String> parameters) {
        ParsedUrl parsed = parse(url, true);
        if (parsed == null) return false;
        if (SCHOOL_LIST_CLASS.equals(classDescriptor)) {
            return "/wakeup/school/info".equals(parsed.path);
        }
        if (SCRIPT_PLUGIN_CLASS.equals(classDescriptor)) {
            if (!"/wakeup/script/enplugin".equals(parsed.path)) return false;
            String type = parameters == null ? null : parameters.get("type");
            String name = parameters == null ? null : parameters.get("name");
            return ("index".equals(type) && "node-course-parser".equals(name))
                || ("wakeup_schedule_inject_script".equals(type) && "wakeup_schedule".equals(name))
                || ("index".equals(type) && "table-image-export".equals(name));
        }
        return false;
    }

    /**
     * Register a single JS-bridge request after the Smali caller verifies its Android lifecycle.
     * The booleans are facts supplied by that caller, not a process-wide allow switch.
     */
    public static synchronized boolean registerDynamic(
        Object input,
        Object owner,
        Object webView,
        Object currentWebView,
        String url,
        String source,
        boolean fragmentAdded,
        boolean activeLoginWebActivity,
        boolean activityDestroyed
    ) {
        purgeCollected();
        if (input == null || owner == null || webView == null || webView != currentWebView) return false;
        if (!fragmentAdded || !activeLoginWebActivity || activityDestroyed) return false;
        if (!SOURCE_V2.equals(source) && !SOURCE_DX.equals(source)) return false;
        ParsedUrl parsed = parse(url, false);
        if (parsed == null || !API_HOST.equals(parsed.host) || isForbiddenParserPath(parsed)) return false;
        IdentityWeakReference key = new IdentityWeakReference(input, COLLECTED);
        if (DYNAMIC.containsKey(key)) return false;
        IdentityWeakReference ownerReference = new IdentityWeakReference(owner, COLLECTED);
        IdentityWeakReference webViewReference = new IdentityWeakReference(webView, COLLECTED);
        ParentToken parent = new ParentToken(key, ownerReference, webViewReference, source, url);
        DYNAMIC.put(key, new License(ownerReference, webViewReference, source, url, parent));
        return true;
    }

    /** Register a qualified static request only when a patched teaching entry supplies its live owner. */
    private static synchronized ParentToken registerStaticParent(
        Object input,
        Object owner,
        String classDescriptor,
        String url,
        Map<String, String> parameters,
        String source,
        boolean ownerActive
    ) {
        purgeCollected();
        if (input == null || owner == null || !ownerActive || !allowsStatic(classDescriptor, url, parameters)) return null;
        if (!SOURCE_SCHOOL_LIST.equals(source) && !SOURCE_V2.equals(source) && !SOURCE_DX.equals(source)
            && !SOURCE_WEBVIEW.equals(source)) return null;
        if (SCHOOL_LIST_CLASS.equals(classDescriptor) != SOURCE_SCHOOL_LIST.equals(source)) return null;
        if (SCRIPT_PLUGIN_CLASS.equals(classDescriptor) && SOURCE_SCHOOL_LIST.equals(source)) return null;
        if (SOURCE_WEBVIEW.equals(source) && !SCRIPT_PLUGIN_CLASS.equals(classDescriptor)) return null;
        IdentityWeakReference key = new IdentityWeakReference(input, COLLECTED);
        if (DYNAMIC.containsKey(key)) return null;
        IdentityWeakReference ownerReference = new IdentityWeakReference(owner, COLLECTED);
        ParentToken parent = new ParentToken(key, ownerReference, null, source, url);
        DYNAMIC.put(key, new License(ownerReference, null, source, url, parent));
        return parent;
    }

    /** Register an E18 request only at a reviewed Smali call site that supplies its live owner. */
    public static synchronized ParentToken registerKnownStaticInput(Object input, Object owner, String source, boolean ownerActive) {
        purgeCollected();
        if (input == null || owner == null || !ownerActive) return null;
        String descriptor = "L" + input.getClass().getName().replace('.', '/') + ";";
        if (!SCHOOL_LIST_CLASS.equals(descriptor) && !SCRIPT_PLUGIN_CLASS.equals(descriptor)) return null;
        if (SCHOOL_LIST_CLASS.equals(descriptor) && !SOURCE_SCHOOL_LIST.equals(source)) return null;
        if (SCRIPT_PLUGIN_CLASS.equals(descriptor)
            && !(SOURCE_V2.equals(source) || SOURCE_DX.equals(source) || SOURCE_WEBVIEW.equals(source))) return null;
        try {
            Object rawParameters = input.getClass().getMethod("getParams").invoke(input);
            if (!(rawParameters instanceof Map<?, ?>)) return null;
            Map<String, String> parameters = new HashMap<String, String>();
            for (Map.Entry<?, ?> entry : ((Map<?, ?>) rawParameters).entrySet()) {
                if (entry.getKey() instanceof String) {
                    Object value = entry.getValue();
                    parameters.put((String) entry.getKey(), value == null ? null : String.valueOf(value));
                }
            }
            return registerStaticParent(input, owner, descriptor, input.toString(), parameters, source, true);
        } catch (ReflectiveOperationException | RuntimeException exception) {
            return null;
        }
    }

    /** Record the exact WebView passed to the currently installed parser action. */
    public static synchronized boolean bindCurrentWebView(Object owner, Object webView) {
        purgeCollected();
        if (owner == null || webView == null) return false;
        REVOKED_OWNERS.remove(new IdentityWeakReference(owner, null));
        REVOKED_WEBVIEWS.remove(new IdentityWeakReference(owner, null));
        CURRENT_WEBVIEWS.put(new IdentityWeakReference(owner, COLLECTED), new WeakReference<Object>(webView));
        return true;
    }

    /** Register a raw bridge input only when it came from the owner's currently bound WebView. */
    public static synchronized boolean registerBoundDynamic(
        Object input,
        Object owner,
        Object webView,
        String url,
        String source,
        boolean fragmentAdded,
        boolean activeLoginWebActivity,
        boolean activityDestroyed
    ) {
        purgeCollected();
        if (owner == null || webView == null) return false;
        WeakReference<Object> currentReference = CURRENT_WEBVIEWS.get(new IdentityWeakReference(owner, null));
        Object currentWebView = currentReference == null ? null : currentReference.get();
        if (currentWebView == null || currentWebView != webView) return false;
        return registerDynamic(input, owner, webView, currentWebView, url, source,
            fragmentAdded, activeLoginWebActivity, activityDestroyed);
    }

    /** Production v2 bridge adapter: independently verifies Fragment, Activity, WebView, and raw input identity. */
    public static synchronized boolean registerV2BridgeInput(
        Object input,
        Object owner,
        Object activity,
        Object webView,
        String url
    ) {
        purgeCollected();
        if (input == null || owner == null || activity == null || webView == null || url == null) return false;
        if (!RAW_BRIDGE_CLASS.equals(descriptorOf(input))) return false;
        if (!"com.suda.yzune.wakeupschedule.schedule_import.v2.ParserFragment".equals(owner.getClass().getName())) return false;
        if (!isActiveParser(owner, activity)) return false;
        try {
            Field currentView = owner.getClass().getField("o00OOoo");
            if (currentView.get(owner) != webView || !url.equals(input.toString())) return false;
            WeakReference<Object> boundView = CURRENT_WEBVIEWS.get(new IdentityWeakReference(owner, null));
            if (boundView == null || boundView.get() != webView || REVOKED_OWNERS.containsKey(new IdentityWeakReference(owner, null))) return false;
            return registerBoundDynamic(input, owner, webView, url, SOURCE_V2, true, true, false);
        } catch (ReflectiveOperationException | RuntimeException exception) {
            return false;
        }
    }

    /** Production DX bridge adapter preserves the existing iframe callback gate, then checks the real route owner. */
    public static synchronized boolean registerDxBridgeInput(
        Object input,
        Object owner,
        Object activity,
        Object webView,
        String url
    ) {
        purgeCollected();
        if (input == null || owner == null || activity == null || webView == null || url == null) return false;
        if (!RAW_BRIDGE_CLASS.equals(descriptorOf(input))) return false;
        if (!"com.suda.yzune.wakeupschedule.schedule_import.DXParserLoginFragment".equals(owner.getClass().getName())) return false;
        if (!isActiveParser(owner, activity)) return false;
        try {
            Field currentView = owner.getClass().getField("o00OOoo");
            if (currentView.get(owner) != webView || !url.equals(input.toString())) return false;
            WeakReference<Object> boundView = CURRENT_WEBVIEWS.get(new IdentityWeakReference(owner, null));
            if (boundView == null || boundView.get() != webView || REVOKED_OWNERS.containsKey(new IdentityWeakReference(owner, null))) return false;
            return registerBoundDynamic(input, owner, webView, url, SOURCE_DX, true, true, false);
        } catch (ReflectiveOperationException | RuntimeException exception) {
            return false;
        }
    }

    /** The DX WebAction validates its iframe callback before entry; this overload snapshots the owner's current view. */
    public static synchronized boolean registerDxBridgeInput(
        Object input,
        Object owner,
        Object activity,
        String url
    ) {
        purgeCollected();
        if (input == null || owner == null || activity == null || url == null
            || !RAW_BRIDGE_CLASS.equals(descriptorOf(input))) return false;
        if (!"com.suda.yzune.wakeupschedule.schedule_import.DXParserLoginFragment".equals(owner.getClass().getName())
            || !isActiveParser(owner, activity) || !url.equals(input.toString())) return false;
        try {
            Field currentView = owner.getClass().getField("o00OOoo");
            Object webView = currentView.get(owner);
            WeakReference<Object> boundView = CURRENT_WEBVIEWS.get(new IdentityWeakReference(owner, null));
            if (webView == null || boundView == null || boundView.get() != webView
                || REVOKED_OWNERS.containsKey(new IdentityWeakReference(owner, null))) return false;
            return registerBoundDynamic(input, owner, webView, url, SOURCE_DX, true, true, false);
        } catch (ReflectiveOperationException | RuntimeException exception) {
            return false;
        }
    }

    /** Production adapter for the reviewed E18 static requests; the source must match the concrete route owner. */
    public static synchronized ParentToken registerKnownTeachingStaticInput(Object input, Object owner, String source) {
        purgeCollected();
        if (input == null || owner == null || source == null) return null;
        String descriptor = descriptorOf(input);
        if (SCHOOL_LIST_CLASS.equals(descriptor)) {
            if (!SOURCE_SCHOOL_LIST.equals(source)
                || !"com.suda.yzune.wakeupschedule.schedule_import.SchoolListActivity".equals(owner.getClass().getName())
                || !isActiveActivity(owner)) return null;
            return registerKnownStaticInput(input, owner, source, true);
        }
        if (!SCRIPT_PLUGIN_CLASS.equals(descriptor)) return null;
        String requiredOwner;
        if (SOURCE_V2.equals(source)) {
            requiredOwner = "com.suda.yzune.wakeupschedule.schedule_import.v2.ParserFragment";
        } else if (SOURCE_DX.equals(source)) {
            requiredOwner = "com.suda.yzune.wakeupschedule.schedule_import.DXParserLoginFragment";
        } else if (SOURCE_WEBVIEW.equals(source)) {
            requiredOwner = "com.suda.yzune.wakeupschedule.schedule_import.WebViewLoginFragment";
        } else {
            return null;
        }
        if (!requiredOwner.equals(owner.getClass().getName())) return null;
        Object activity;
        Object webView;
        try {
            activity = owner.getClass().getMethod("getActivity").invoke(owner);
            Field currentView = owner.getClass().getField("o00OOoo");
            webView = currentView.get(owner);
            if (webView == null || !isActiveParser(owner, activity)) return null;
        } catch (ReflectiveOperationException | RuntimeException exception) {
            return null;
        }
        IdentityWeakReference ownerKey = new IdentityWeakReference(owner, null);
        if (REVOKED_OWNERS.containsKey(ownerKey)) {
            WeakReference<Object> revokedView = REVOKED_WEBVIEWS.get(ownerKey);
            if (revokedView == null || revokedView.get() == webView) return null;
            REVOKED_OWNERS.remove(ownerKey);
            REVOKED_WEBVIEWS.remove(ownerKey);
        }
        WeakReference<Object> boundView = CURRENT_WEBVIEWS.get(ownerKey);
        if (boundView == null || boundView.get() != webView) bindCurrentWebView(owner, webView);
        return registerKnownStaticInput(input, owner, source, true);
    }

    private static String descriptorOf(Object input) {
        return input == null ? null : "L" + input.getClass().getName().replace('.', '/') + ";";
    }

    private static Object reflectedCurrentWebView(Object owner) {
        if (owner == null) return null;
        try {
            return owner.getClass().getField("o00OOoo").get(owner);
        } catch (ReflectiveOperationException | RuntimeException exception) {
            return null;
        }
    }

    private static boolean isActiveParser(Object owner, Object activity) {
        try {
            if (!Boolean.TRUE.equals(owner.getClass().getMethod("isAdded").invoke(owner))) return false;
            Object attachedActivity = owner.getClass().getMethod("getActivity").invoke(owner);
            if (attachedActivity != activity || !"com.suda.yzune.wakeupschedule.schedule_import.LoginWebActivity".equals(activity.getClass().getName())) return false;
            return !Boolean.TRUE.equals(activity.getClass().getMethod("isFinishing").invoke(activity))
                && !Boolean.TRUE.equals(activity.getClass().getMethod("isDestroyed").invoke(activity));
        } catch (ReflectiveOperationException | RuntimeException exception) {
            return false;
        }
    }

    private static boolean isActiveActivity(Object activity) {
        if (activity == null || !"com.suda.yzune.wakeupschedule.schedule_import.SchoolListActivity".equals(activity.getClass().getName())) return false;
        try {
            return !Boolean.TRUE.equals(activity.getClass().getMethod("isFinishing").invoke(activity))
                && !Boolean.TRUE.equals(activity.getClass().getMethod("isDestroyed").invoke(activity));
        } catch (ReflectiveOperationException | RuntimeException exception) {
            return false;
        }
    }

    /** Obtain the opaque parent created for a dynamic bridge request before explicit coroutine dispatch. */
    public static synchronized ParentToken parentFor(Object input) {
        purgeCollected();
        if (input == null) return null;
        License license = DYNAMIC.get(new IdentityWeakReference(input, null));
        return license == null || !license.isLive() ? null : license.parent;
    }

    public static synchronized boolean isParentLive(ParentToken parent) {
        purgeCollected();
        return parent != null && parent.isLive();
    }

    /** A successful bootstrap is remembered only for this live owner-bound parent identity. */
    public static synchronized boolean isBootstrapReady(ParentToken parent) {
        purgeCollected();
        return parent != null && parent.isLive() && parent.bootstrapReady;
    }

    /** Records readiness after the original baseutil/native/version-key checks all succeeded. */
    public static synchronized boolean markBootstrapReady(ParentToken parent) {
        purgeCollected();
        if (parent == null || !parent.isLive() || !parent.initAttempted) return false;
        parent.bootstrapReady = true;
        return true;
    }

    static synchronized Object ownerFor(ParentToken parent) {
        purgeCollected();
        return parent == null || !parent.isLive() ? null : parent.owner.get();
    }

    static synchronized String sourceFor(ParentToken parent) {
        purgeCollected();
        return parent == null || !parent.isLive() ? null : parent.source;
    }

    /** Preflight for synchronous business calls; the final Request URL is checked at consumption time. */
    public static synchronized boolean hasRequestLicense(Object input) {
        purgeCollected();
        if (input == null) return false;
        License license = DYNAMIC.get(new IdentityWeakReference(input, null));
        return license != null && license.isLive();
    }

    /** Enter a short-lived bootstrap scope on the worker that performs the original native initialization. */
    public static synchronized BootstrapScope enterBootstrap(ParentToken parent) {
        purgeCollected();
        if (parent == null || !parent.isLive() || parent.initAttempted) return null;
        parent.initAttempted = true;
        BootstrapScope scope = new BootstrapScope(parent, CURRENT_BOOTSTRAP.get());
        CURRENT_BOOTSTRAP.set(scope);
        return scope;
    }

    /** Consume the sole bootstrap child immediately before E43 constructs and sends its synchronous request. */
    public static synchronized boolean consumeBootstrapChild(
        Object input,
        String finalUrl,
        String signA,
        String pid,
        int method,
        String responseClass
    ) {
        purgeCollected();
        BootstrapScope scope = CURRENT_BOOTSTRAP.get();
        if (scope == null || !scope.isLive() || input == null) return false;
        ChildLicense child = BOOTSTRAP_CHILDREN.remove(new IdentityWeakReference(input, null));
        if (child == null || child.scope != scope || !child.matches(finalUrl, signA, pid, method, responseClass)) return false;
        scope.consumedChildInput = new WeakReference<Object>(input);
        scope.consumedChildUrl = child.url;
        return true;
    }

    /** E42 entry: read and validate the exact input snapshot without Android dependencies. */
    public static synchronized boolean registerBootstrapChild(Object input) {
        BootstrapScope scope = CURRENT_BOOTSTRAP.get();
        if (scope == null || !scope.isLive()) return false;
        ChildSnapshot snapshot = antispamSnapshot(input);
        return snapshot != null && registerBootstrapChild(input, snapshot.url, snapshot.signA, snapshot.pid, snapshot.method, snapshot.responseClass);
    }

    /** E43 entry: distinguish a bootstrap child from ordinary synchronous business input. */
    public static synchronized boolean isBootstrapActive() {
        BootstrapScope scope = CURRENT_BOOTSTRAP.get();
        return scope != null && scope.isLive();
    }

    public static synchronized boolean consumeBootstrapChild(Object input, String finalUrl) {
        BootstrapScope scope = CURRENT_BOOTSTRAP.get();
        if (scope == null || !scope.isLive() || input == null) return false;
        ChildSnapshot snapshot = antispamSnapshot(input);
        if (snapshot == null || !snapshot.url.equals(finalUrl)) {
            BOOTSTRAP_CHILDREN.remove(new IdentityWeakReference(input, null));
            return false;
        }
        return consumeBootstrapChild(input, finalUrl, snapshot.signA, snapshot.pid, snapshot.method, snapshot.responseClass);
    }

    public static synchronized boolean isConsumedBootstrapChild(Object input) {
        BootstrapScope scope = CURRENT_BOOTSTRAP.get();
        return scope != null && scope.isLive() && input != null && scope.consumedChildInput != null
            && scope.consumedChildInput.get() == input;
    }

    /** Called after the exact Volley Request is constructed; proof is local to this object and sync call. */
    public static synchronized boolean bindBootstrapTransport(Object input, Object request, String finalUrl) {
        purgeCollected();
        BootstrapScope scope = CURRENT_BOOTSTRAP.get();
        if (scope == null || !scope.isLive() || input == null || request == null || !isDefaultAntispamUrl(finalUrl)) return false;
        if (scope.transportBound || scope.consumedChildInput == null || scope.consumedChildInput.get() != input
            || scope.consumedChildUrl == null || !scope.consumedChildUrl.equals(finalUrl)) return false;
        IdentityWeakReference key = new IdentityWeakReference(request, COLLECTED);
        if (BOOTSTRAP_TRANSPORTS.containsKey(key)) return false;
        BOOTSTRAP_TRANSPORTS.put(key, new TransportProof(scope, finalUrl));
        scope.transportBound = true;
        return true;
    }

    /** E53 claims this proof once before execute; callers without proof retain the original redirect policy. */
    public static synchronized boolean claimBootstrapTransport(Object request, String finalUrl) {
        purgeCollected();
        if (request == null) return false;
        IdentityWeakReference key = new IdentityWeakReference(request, null);
        TransportProof proof = BOOTSTRAP_TRANSPORTS.get(key);
        if (proof == null || proof.claimed || !proof.scope.isLive() || !proof.url.equals(finalUrl)) return false;
        proof.claimed = true;
        return true;
    }

    public static synchronized boolean hasBootstrapTransport(Object request) {
        purgeCollected();
        return request != null && BOOTSTRAP_TRANSPORTS.containsKey(new IdentityWeakReference(request, null));
    }

    public static synchronized void finishBootstrapTransport(Object request) {
        if (request != null) BOOTSTRAP_TRANSPORTS.remove(new IdentityWeakReference(request, null));
    }

    /** Register only the one reviewed antispam input created inside the active initialization call. */
    public static synchronized boolean registerBootstrapChild(
        Object input,
        String finalUrl,
        String signA,
        String pid,
        int method,
        String responseClass
    ) {
        purgeCollected();
        BootstrapScope scope = CURRENT_BOOTSTRAP.get();
        if (scope == null || !scope.isLive() || input == null || scope.childRegistered) return false;
        if (!isDefaultAntispamUrl(finalUrl) || signA == null || signA.length() == 0) return false;
        if (!"antispam".equals(pid) || method != 1 || !"Lcom/baidu/homework/common/net/model/v1/PlutoAntispam;".equals(responseClass)) return false;
        IdentityWeakReference key = new IdentityWeakReference(input, COLLECTED);
        if (BOOTSTRAP_CHILDREN.containsKey(key)) return false;
        scope.childRegistered = true;
        BOOTSTRAP_CHILDREN.put(key, new ChildLicense(scope, finalUrl, signA, pid, method, responseClass));
        return true;
    }

    /** Transfer, rather than copy, one permission from raw input into its exact wrapper. */
    public static synchronized boolean transfer(Object originalInput, Object wrapperInput) {
        purgeCollected();
        if (originalInput == null || wrapperInput == null || originalInput == wrapperInput) return false;
        IdentityWeakReference originalKey = new IdentityWeakReference(originalInput, null);
        License license = DYNAMIC.remove(originalKey);
        if (license == null || !license.isLive()) return false;
        IdentityWeakReference wrapperKey = new IdentityWeakReference(wrapperInput, COLLECTED);
        if (DYNAMIC.containsKey(wrapperKey)) return false;
        license.parent.input = wrapperKey;
        DYNAMIC.put(wrapperKey, license);
        return true;
    }

    /** Consume a dynamic permission exactly once immediately before low-level queue insertion. */
    public static synchronized boolean consume(Object input) {
        purgeCollected();
        if (input == null) return false;
        License license = DYNAMIC.remove(new IdentityWeakReference(input, null));
        return license != null && license.isLive();
    }

    /** Queue guard that also compares the exact URL snapshot authorized by the owner-bound parent. */
    public static synchronized boolean consumeForQueue(Object input, String finalUrl) {
        purgeCollected();
        if (input == null || finalUrl == null) return false;
        License license = DYNAMIC.remove(new IdentityWeakReference(input, null));
        if (license == null || !license.isLive()) return false;
        if (!sameRequestUrl(license.authorizedUrl, finalUrl)) {
            license.parent.revoke();
            return false;
        }
        return true;
    }

    /** Remove every unconsumed request owned by a Fragment before its original cleanup runs. */
    public static synchronized int revokeOwner(Object owner) {
        purgeCollected();
        if (owner == null) return 0;
        IdentityWeakReference ownerKey = new IdentityWeakReference(owner, COLLECTED);
        WeakReference<Object> currentReference = CURRENT_WEBVIEWS.get(new IdentityWeakReference(owner, null));
        Object currentView = currentReference == null ? null : currentReference.get();
        if (currentView == null) currentView = reflectedCurrentWebView(owner);
        if (currentView != null) REVOKED_WEBVIEWS.put(ownerKey, new WeakReference<Object>(currentView));
        REVOKED_OWNERS.put(ownerKey, Boolean.TRUE);
        CURRENT_WEBVIEWS.remove(new IdentityWeakReference(owner, null));
        int removed = 0;
        Iterator<Map.Entry<IdentityWeakReference, License>> iterator = DYNAMIC.entrySet().iterator();
        while (iterator.hasNext()) {
            Map.Entry<IdentityWeakReference, License> entry = iterator.next();
            if (entry.getValue().owner.get() == owner) {
                entry.getValue().parent.revoke();
                iterator.remove();
                removed++;
            }
        }
        revokeChildrenAndTransports();
        return removed;
    }

    /** Static permissions and object-bound bridge permissions meet at the same queue guard. */
    public static synchronized boolean allowsQueue(String classDescriptor, String url, Map<String, String> parameters, Object input) {
        purgeCollected();
        if (input == null) return false;
        IdentityWeakReference key = new IdentityWeakReference(input, null);
        License license = DYNAMIC.get(key);
        if (license == null || !license.isLive()) return false;

        boolean validSource;
        if (SCHOOL_LIST_CLASS.equals(classDescriptor)) {
            validSource = SOURCE_SCHOOL_LIST.equals(license.source) && allowsStatic(classDescriptor, url, parameters);
        } else if (SCRIPT_PLUGIN_CLASS.equals(classDescriptor)) {
            validSource = (SOURCE_V2.equals(license.source) || SOURCE_DX.equals(license.source)
                || SOURCE_WEBVIEW.equals(license.source))
                && allowsStatic(classDescriptor, url, parameters);
        } else if (SOURCE_SCHOOL_LIST.equals(license.source)) {
            validSource = HTTP_CURRENCY_WRAPPER_CLASS.equals(classDescriptor);
        } else if (SOURCE_WEBVIEW.equals(license.source)) {
            validSource = HTTP_CURRENCY_WRAPPER_CLASS.equals(classDescriptor);
        } else {
            validSource = RAW_BRIDGE_CLASS.equals(classDescriptor)
                || HTTP_CURRENCY_WRAPPER_CLASS.equals(classDescriptor)
                || DX_HTTP_WRAPPER_CLASS.equals(classDescriptor);
        }
        if (!validSource) {
            DYNAMIC.remove(key);
            license.parent.revoke();
            return false;
        }
        return consumeForQueue(input, url);
    }

    static synchronized int pendingCountForTest() {
        purgeCollected();
        return DYNAMIC.size();
    }

    static synchronized void clearForTest() {
        DYNAMIC.clear();
        CURRENT_WEBVIEWS.clear();
        REVOKED_OWNERS.clear();
        REVOKED_WEBVIEWS.clear();
        BOOTSTRAP_CHILDREN.clear();
        BOOTSTRAP_TRANSPORTS.clear();
        CURRENT_BOOTSTRAP.remove();
        while (COLLECTED.poll() != null) { /* drain references */ }
    }

    private static void purgeCollected() {
        Object collected;
        while ((collected = COLLECTED.poll()) != null) {
            IdentityWeakReference reference = (IdentityWeakReference) collected;
            DYNAMIC.remove(reference);
            CURRENT_WEBVIEWS.remove(reference);
            REVOKED_OWNERS.remove(reference);
            REVOKED_WEBVIEWS.remove(reference);
            BOOTSTRAP_CHILDREN.remove(reference);
            BOOTSTRAP_TRANSPORTS.remove(reference);
            Iterator<Map.Entry<IdentityWeakReference, License>> iterator = DYNAMIC.entrySet().iterator();
            while (iterator.hasNext()) {
                License license = iterator.next().getValue();
                if (license.owner == reference || license.webView == reference) {
                    license.parent.revoke();
                    iterator.remove();
                }
            }
            revokeChildrenAndTransports();
        }
    }

    private static void revokeChildrenAndTransports() {
        Iterator<Map.Entry<IdentityWeakReference, ChildLicense>> childIterator = BOOTSTRAP_CHILDREN.entrySet().iterator();
        while (childIterator.hasNext()) {
            if (!childIterator.next().getValue().scope.isLive()) childIterator.remove();
        }
        Iterator<Map.Entry<IdentityWeakReference, TransportProof>> transportIterator = BOOTSTRAP_TRANSPORTS.entrySet().iterator();
        while (transportIterator.hasNext()) {
            if (!transportIterator.next().getValue().scope.isLive()) transportIterator.remove();
        }
    }

    private static ParsedUrl parse(String text, boolean allowRelative) {
        if (text == null || text.length() == 0 || text.indexOf('\\') >= 0 || text.indexOf('\0') >= 0) return null;
        try {
            URI uri = new URI(text);
            if (uri.getRawFragment() != null || uri.getRawPath() == null) return null;
            String rawPath = uri.getRawPath();
            if (rawPath.indexOf(';') >= 0 || rawPath.matches("(?i).*%(2f|5c|2e).*")) return null;
            if (!uri.normalize().getRawPath().equals(rawPath)) return null;
            for (String segment : rawPath.split("/", -1)) {
                if (".".equals(segment) || "..".equals(segment)) return null;
            }
            if (!uri.isAbsolute()) {
                if (!allowRelative || uri.getRawAuthority() != null || !text.startsWith("/") || uri.getScheme() != null) return null;
                return new ParsedUrl(null, rawPath, uri.getRawQuery());
            }
            String scheme = uri.getScheme().toLowerCase(Locale.ROOT);
            if (!"http".equals(scheme) && !"https".equals(scheme)) return null;
            if (uri.getRawUserInfo() != null || uri.getHost() == null) return null;
            int port = uri.getPort();
            int defaultPort = "https".equals(scheme) ? 443 : 80;
            if (port != -1 && port != defaultPort) return null;
            String host = uri.getHost().toLowerCase(Locale.ROOT);
            if (!API_HOST.equals(host)) return null;
            return new ParsedUrl(host, rawPath, uri.getRawQuery());
        } catch (URISyntaxException | IllegalArgumentException exception) {
            return null;
        }
    }

    private static boolean isForbiddenParserPath(ParsedUrl parsed) {
        String path = parsed.path.toLowerCase(Locale.ROOT);
        if ("/wakeup/school/info".equals(path) || "/wakeup/script/enplugin".equals(path)) return true;
        for (String marker : FORBIDDEN_PATH_MARKERS) {
            if (path.contains(marker)) return true;
        }
        String query = parsed.query == null ? "" : parsed.query.toLowerCase(Locale.ROOT);
        if (query.contains("tracking") || query.contains("wakeup-tracking-inject-script")) return true;
        for (String marker : FORBIDDEN_PATH_MARKERS) {
            String token = marker.substring(1).replace('/', '_');
            if (query.contains(token)) return true;
        }
        return path.length() <= 1;
    }

    private static boolean sameRequestUrl(String authorized, String actual) {
        ParsedUrl left = parse(authorized, true);
        ParsedUrl right = parse(actual, true);
        if (left == null || right == null) return false;
        if (!left.path.equals(right.path) || !equal(left.query, right.query)) return false;
        if (left.host == null && right.host == null) return true;
        if (left.host == null || right.host == null) return API_HOST.equals(left.host == null ? right.host : left.host);
        return left.host.equals(right.host);
    }

    private static ChildSnapshot antispamSnapshot(Object input) {
        if (input == null || !"com.baidu.homework.common.net.model.v1.PlutoAntispam$OooO00o".equals(input.getClass().getName())) return null;
        try {
            Field urlField = input.getClass().getField("__url");
            Field pidField = input.getClass().getField("__pid");
            Field methodField = input.getClass().getField("__method");
            Field responseField = input.getClass().getField("__aClass");
            String requestPath = (String) urlField.get(input);
            String pid = (String) pidField.get(input);
            int method = methodField.getInt(input);
            Class<?> response = (Class<?>) responseField.get(input);
            Method getParams = input.getClass().getMethod("getParams");
            Object value = getParams.invoke(input);
            if (!(value instanceof Map<?, ?>)) return null;
            Object signValue = ((Map<?, ?>) value).get("data");
            if (!(signValue instanceof String)) return null;
            String signA = (String) signValue;
            String resolvedUrl = input.toString();
            String responseClass = response == null ? null : "L" + response.getName().replace('.', '/') + ";";
            if (!"/pluto/app/antispam".equals(requestPath) || !"antispam".equals(pid) || method != 1
                || !"Lcom/baidu/homework/common/net/model/v1/PlutoAntispam;".equals(responseClass)
                || signA.length() == 0 || !isDefaultAntispamUrl(resolvedUrl)) return null;
            return new ChildSnapshot(resolvedUrl, signA, pid, method, responseClass);
        } catch (ReflectiveOperationException | RuntimeException exception) {
            return null;
        }
    }

    private static boolean isDefaultAntispamUrl(String url) {
        if (url == null) return false;
        try {
            URI uri = new URI(url);
            if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getRawUserInfo() != null || uri.getRawFragment() != null
                || !API_HOST.equalsIgnoreCase(uri.getHost()) || (uri.getPort() != -1 && uri.getPort() != 443)
                || !"/pluto/app/antispam".equals(uri.getRawPath())) return false;
            String query = uri.getRawQuery();
            return query == null || (query.startsWith("data=") && query.indexOf('&') < 0);
        } catch (URISyntaxException | IllegalArgumentException exception) {
            return false;
        }
    }

    private static boolean equal(Object left, Object right) {
        return left == null ? right == null : left.equals(right);
    }

    private static final class ParsedUrl {
        private final String host;
        private final String path;
        private final String query;

        private ParsedUrl(String host, String path, String query) {
            this.host = host;
            this.path = path;
            this.query = query;
        }
    }

    private static final class License {
        private final IdentityWeakReference owner;
        private final IdentityWeakReference webView;
        private final String source;
        @SuppressWarnings("unused")
        private final String authorizedUrl;
        private final ParentToken parent;

        private License(IdentityWeakReference owner, IdentityWeakReference webView, String source, String authorizedUrl, ParentToken parent) {
            this.owner = owner;
            this.webView = webView;
            this.source = source;
            this.authorizedUrl = authorizedUrl;
            this.parent = parent;
        }

        private boolean isLive() {
            return owner.get() != null && (webView == null || webView.get() != null) && parent.isLive();
        }
    }

    /** Opaque owner-bound authority; its constructor is private and it never represents general network access. */
    public static final class ParentToken {
        private IdentityWeakReference input;
        private final IdentityWeakReference owner;
        private final IdentityWeakReference webView;
        private final String source;
        private final String authorizedUrl;
        private boolean initAttempted;
        private boolean bootstrapReady;
        private boolean active = true;

        private ParentToken(IdentityWeakReference input, IdentityWeakReference owner, IdentityWeakReference webView, String source, String authorizedUrl) {
            this.input = input;
            this.owner = owner;
            this.webView = webView;
            this.source = source;
            this.authorizedUrl = authorizedUrl;
        }

        private boolean isLive() {
            return active && input.get() != null && owner.get() != null && (webView == null || webView.get() != null);
        }

        private void revoke() { active = false; }
    }

    /** Scope must be closed in finally; it permits one antispam child and nothing else. */
    public static final class BootstrapScope implements AutoCloseable {
        private final ParentToken parent;
        private final BootstrapScope previous;
        private boolean childRegistered;
        private WeakReference<Object> consumedChildInput;
        private String consumedChildUrl;
        private boolean transportBound;
        private boolean closed;

        private BootstrapScope(ParentToken parent, BootstrapScope previous) {
            this.parent = parent;
            this.previous = previous;
        }

        private boolean isLive() { return !closed && parent.isLive(); }

        @Override
        public void close() {
            synchronized (SlimNetworkPolicy.class) {
                if (closed) return;
                closed = true;
                consumedChildInput = null;
                consumedChildUrl = null;
                if (CURRENT_BOOTSTRAP.get() == this) {
                    if (previous == null) CURRENT_BOOTSTRAP.remove();
                    else CURRENT_BOOTSTRAP.set(previous);
                }
                revokeChildrenAndTransports();
            }
        }
    }

    private static final class ChildLicense {
        private final BootstrapScope scope;
        private final String url;
        private final String signA;
        private final String pid;
        private final int method;
        private final String responseClass;

        private ChildLicense(BootstrapScope scope, String url, String signA, String pid, int method, String responseClass) {
            this.scope = scope;
            this.url = url;
            this.signA = signA;
            this.pid = pid;
            this.method = method;
            this.responseClass = responseClass;
        }

        private boolean matches(String url, String signA, String pid, int method, String responseClass) {
            return scope.isLive() && this.url.equals(url) && this.signA.equals(signA) && this.pid.equals(pid)
                && this.method == method && this.responseClass.equals(responseClass);
        }
    }

    private static final class ChildSnapshot {
        private final String url;
        private final String signA;
        private final String pid;
        private final int method;
        private final String responseClass;

        private ChildSnapshot(String url, String signA, String pid, int method, String responseClass) {
            this.url = url;
            this.signA = signA;
            this.pid = pid;
            this.method = method;
            this.responseClass = responseClass;
        }
    }

    private static final class TransportProof {
        private final BootstrapScope scope;
        private final String url;
        private boolean claimed;

        private TransportProof(BootstrapScope scope, String url) {
            this.scope = scope;
            this.url = url;
        }
    }

    private static final class IdentityWeakReference extends WeakReference<Object> {
        private final int identityHash;

        private IdentityWeakReference(Object value, ReferenceQueue<Object> queue) {
            super(value, queue);
            identityHash = System.identityHashCode(value);
        }

        @Override
        public int hashCode() {
            return identityHash;
        }

        @Override
        public boolean equals(Object other) {
            if (this == other) return true;
            if (!(other instanceof IdentityWeakReference)) return false;
            Object left = get();
            Object right = ((IdentityWeakReference) other).get();
            return left != null && left == right;
        }
    }
}
