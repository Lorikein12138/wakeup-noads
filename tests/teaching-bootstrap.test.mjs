import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { applyPatchSpec } from '../scripts/patch.mjs';
import { assertPrivateInvokeAbi, hasSmaliInvoke, readSmaliMethod, sameExecutableSmaliMethod, smaliInvokeEdges } from './smali-helpers.mjs';

const root = path.resolve(process.env.SLIM_BASELINE_DECODED_ROOT ?? 'tools/_cache/slim-v1-decoded');
const cache = path.resolve('tools/_cache/slim-v1-review/fixtures/round-2');
const transportPath = 'smali_classes6/o0OO00o0/OooO.smali';
const transportClass = 'Lo0OO00o0/OooO;';
const transportMethod = 'public OooO00o(Lcom/android/volley/Request;Ljava/util/Map;)Lorg/apache/http/HttpResponse;';
const antispamPath = 'smali_classes6/o0Oo0OOO.6/o000OOo.smali';
const baseutilPath = 'smali_classes6/o0Oo0OOO.6/o0OO00O.smali';
const syncNetPath = 'smali_classes3/com/baidu/homework/common/net/OooOo00.smali';
const rc4Path = 'smali_classes6/com/suda/yzune/wakeupschedule/aaa/utils/oOO00O.smali';
const v2BridgePath = 'smali_classes6/com/suda/yzune/wakeupschedule/schedule_import/v2/ParserFragment$configWebView$7.smali';
const v2FragmentPath = 'smali_classes6/com/suda/yzune/wakeupschedule/schedule_import/v2/ParserFragment.smali';
const schoolListPath = 'smali_classes6/com/suda/yzune/wakeupschedule/schedule_import/SchoolListActivity$initSchoolList$1$3.smali';
const dxFragmentPath = 'smali_classes6/com/suda/yzune/wakeupschedule/schedule_import/DXParserLoginFragment.smali';
const dxBridgePath = 'smali_classes6/com/suda/yzune/wakeupschedule/schedule_import/DXParserLoginFragment$onViewCreated$7.smali';
const webViewFragmentPath = 'smali_classes6/com/suda/yzune/wakeupschedule/schedule_import/WebViewLoginFragment.smali';

test('E41 keeps the original loader, nativeSetToken, and readiness contract while removing reports', async (t) => {
  await mkdir(cache, { recursive: true });
  const fixtureRoot = await mkdtemp(path.join(cache, 'teaching-bootstrap-e41-simulation-'));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const targetPath = path.join(fixtureRoot, baseutilPath);
  await mkdir(path.dirname(targetPath), { recursive: true });
  await copyFile(path.join(root, baseutilPath), targetPath);

  const fullSpec = JSON.parse(await readFile('patches/slim-v1/patch-spec.json', 'utf8'));
  const operations = fullSpec.operations.filter((operation) => operation.id.startsWith('T26-E41-'));
  assert.equal(operations.length, 5, 'the E41 error/statistics/log changes are narrowly enumerated');
  const specPath = path.join(fixtureRoot, 'e41-fixture-spec.json');
  await writeFile(specPath, JSON.stringify({ schemaVersion: 1, applicationId: 'io.github.wakeupnoads', operations }));
  await applyPatchSpec({ root: fixtureRoot, specPath });

  const initializer = await readSmaliMethod(
    fixtureRoot, baseutilPath, 'Lo0Oo0OOO/o0OO00O;', 'public static declared-synchronized OooO0o()Z',
  );
  const ready = await readSmaliMethod(
    fixtureRoot, baseutilPath, 'Lo0Oo0OOO/o0OO00O;', 'public static OooO0oO()Z',
  );
  const stats = await readSmaliMethod(
    fixtureRoot, baseutilPath, 'Lo0Oo0OOO/o0OO00O;', 'public static varargs OooOOO0([Ljava/lang/String;)V',
  );
  const loader = await readSmaliMethod(
    fixtureRoot, baseutilPath, 'Lo0Oo0OOO/o0OO00O;', 'static constructor <clinit>()V',
  );
  assert.match(initializer, /NativeHelper;->nativeSetToken\(/, 'the original native token setup remains reachable');
  assert.equal((initializer.match(/invoke-interface \{[^\n]+\}, Lo0ooOOO0\/o00OOOO0;->OooO0OO\(Ljava\/lang\/String;\[Ljava\/lang\/Object;\)V/g) ?? []).length, 0,
    'the 6.6.0 initializer no longer sends any initialization result to the logging interface');
  assert.match(ready, /sget-boolean v0, Lo0Oo0OOO\/o0OO00O;->OooO0O0:Z/,
    'the concrete E41 readiness accessor remains available to the Java adapter');
  assert.match(stats, /return-void/, 'the telemetry callback is inert after the exact method replacement');
  assert.doesNotMatch(stats, /Lcom\/zuoyebang\/baseutil\/OooO;->OooO00o/);
  assert.match(loader, /System;->loadLibrary\(Ljava\/lang\/String;\)V/);
  assert.match(loader, /Lo00oo0oO\/o00O0000;->OooO00o\(Landroid\/content\/Context;Ljava\/lang\/String;\)V/);
  assert.doesNotMatch(loader, /Lo000OOO\/OooO00o;->OooO0OO\(Ljava\/lang\/String;\)V/,
    'native load failure no longer emits an online report');
});

test('production reflection bindings match the 6.6.0 privacy, version, baseutil, DX, and RC4 ABI', async () => {
  const bootstrapPath = 'runtime/src/com/suda/yzune/wakeupschedule/slim/TeachingBootstrap.java';
  const networkPath = 'runtime/src/com/suda/yzune/wakeupschedule/slim/SlimNetworkPolicy.java';
  const rc4RuntimePath = 'runtime/src/com/suda/yzune/wakeupschedule/slim/Rc4PoolLifecycle.java';
  const bootstrap = await readFile(bootstrapPath, 'utf8');
  const network = await readFile(networkPath, 'utf8');
  const rc4Runtime = await readFile(rc4RuntimePath, 'utf8');
  const rawPath = 'smali_classes6/o0Oo0o00.2/o00Ooo.smali';
  const parentPath = 'smali_classes3/o000oo0O.4/OooO.smali';
  const webViewPath = 'smali_classes6/o0OoOoo0.9/o000Oo0.smali';
  const dxPath = 'smali_classes6/com/suda/yzune/wakeupschedule/schedule_import/DXParserLoginFragment.smali';
  const privacyPath = 'smali_classes6/com/suda/yzune/wakeupschedule/utils/o0000OO0.smali';
  const versionPath = 'smali_classes3/o000o0OO.3/OooOOO0.smali';
  const baseutilPath = 'smali_classes6/o0Oo0OOO.6/o0OO00O.smali';
  const rc4Path = 'smali_classes3/o0000oo.3/o0ooOOo.smali';
  const raw = await readFile(path.join(root, rawPath), 'utf8');
  const parent = await readFile(path.join(root, parentPath), 'utf8');
  const webViewOwner = await readFile(path.join(root, webViewPath), 'utf8');
  const privacy = await readFile(path.join(root, privacyPath), 'utf8');
  const baseutil = await readFile(path.join(root, baseutilPath), 'utf8');
  const rc4 = await readFile(path.join(root, rc4Path), 'utf8');
  assert.match(raw, /^\.class public Lo0Oo0o00\/o00Ooo;$/m);
  assert.match(raw, /^\.super Lo000oo0O\/OooO;$/m);
  assert.match(raw, /^\.method public constructor <init>\(Ljava\/lang\/String;Ljava\/util\/Map;ILjava\/lang\/Class;\)V$/m);
  await assert.rejects(readSmaliMethod(root, rawPath, 'Lo0OOOoO0/OooO0O0;',
    'public constructor <init>(Ljava/lang/String;Ljava/util/Map;ILjava/lang/Class;)V'), /Class descriptor mismatch/,
  'the stale raw input binding is rejected against the actual class declaration');
  assert.match(parent, /^\.class public abstract Lo000oo0O\/OooO;$/m);
  for (const field of ['__url:Ljava/lang/String;', '__method:I', '__aClass:Ljava/lang/Class;']) assert.ok(parent.includes(field));
  assert.match(parent, /^\.method public abstract getParams\(\)Ljava\/util\/Map;$/m);
  assert.match(webViewOwner, /^\.field public o00OOoo:Lcom\/zuoyebang\/widget\/CacheHybridWebView;$/m);
  const dxMethod = await readSmaliMethod(root, dxPath,
    'Lcom/suda/yzune/wakeupschedule/schedule_import/DXParserLoginFragment;',
    'public final o00oOoo(Landroid/content/Context;ZLo000oo0O/OooO;Lcom/baidu/homework/common/net/OooOo00$Oooo0;Lcom/baidu/homework/common/net/OooOo00$OooOo00;)Lcom/android/volley/Request;');
  assert.match(dxMethod, /Lo000oo0O\/OooO;/);
  assert.match(privacy, /^\.method public static OooO0Oo\(Landroid\/content\/Context;\)Z$/m);
  const versionMethod = await readSmaliMethod(root, versionPath, 'Lo000o0OO/OooOOO0;', 'public static OooOO0()I');
  assert.match(versionMethod, /Lo0o00OO0\/OooOOO;->getVersionCode\(\)I/);
  const keyMethod = await readSmaliMethod(root, baseutilPath, 'Lo0Oo0OOO/o0OO00O;', 'public static declared-synchronized OooO0O0(Ljava/lang/String;)Ljava/lang/String;');
  const initMethod = await readSmaliMethod(root, baseutilPath, 'Lo0Oo0OOO/o0OO00O;', 'public static declared-synchronized OooO0o()Z');
  const readyMethod = await readSmaliMethod(root, baseutilPath, 'Lo0Oo0OOO/o0OO00O;', 'public static OooO0oO()Z');
  assert.match(initMethod, /Lo000o0OO\/OooOOO0;->OooOO0\(\)I[\s\S]*Ljava\/lang\/String;->valueOf\(I\)Ljava\/lang\/String;[\s\S]*OooO0O0\(Ljava\/lang\/String;\)Ljava\/lang\/String;/);
  assert.match(readyMethod, /OooO0O0:Z/);
  assert.match(keyMethod, /OooO0OO\(Ljava\/lang\/String;Z\)Ljava\/lang\/String;/);
  assert.match(rc4, /^\.class public Lo0000oo\/o0ooOOo;$/m);
  assert.match(rc4, /^\.method public constructor <init>\(Ljava\/lang\/String;\)V$/m);

  const javaNames = ['o000oo0O.OooO', 'com.suda.yzune.wakeupschedule.utils.o0000OO0',
    'o000o0OO.OooOOO0', 'o0Oo0OOO.o0OO00O', 'o0000oo.o0ooOOo'];
  assert.ok(javaNames.every((name) => !/[L/;]/.test(name)), 'Java reflection names contain no Smali wrapper characters');
  assert.match(bootstrap, /Class\.forName\("o000oo0O\.OooO"/);
  assert.match(bootstrap, /classFor\("com\.suda\.yzune\.wakeupschedule\.utils\.o0000OO0"\)[\s\S]*getMethod\("OooO0Oo", contextType\)/);
  assert.match(bootstrap, /invokeStatic\("o000o0OO\.OooOOO0", "OooOO0"\)/);
  assert.match(bootstrap, /invokeStatic\("o0Oo0OOO\.o0OO00O", "OooO0oO"\)/);
  assert.match(bootstrap, /invokeStatic\("o0Oo0OOO\.o0OO00O", "OooO0o"\)/);
  assert.match(bootstrap, /getMethod\("OooO0O0", String\.class\)\.invoke\(null, String\.valueOf\(versionCode\)\)/);
  assert.match(network, /RAW_BRIDGE_CLASS = "Lo0Oo0o00\/o00Ooo;"/);
  assert.match(network, /getField\("o00OOoo"\)/);
  assert.match(rc4Runtime, /RC4_CLASS = "o0000oo\.o0ooOOo"/);

  for (const stale of ['Lo0OOOoO0/OooO0O0;', 'Lo000OO0o/OooO0O0;', 'com.zybang.privacy.OooO0O0', 'com.zuoyebang.baseutil.OooO00o']) {
    assert.equal(bootstrap.includes(stale), false, `stale binding ${stale} is not used by production reflection`);
  }
});

test('E43 keeps its synchronous false,false request path and Volley result handling', async () => {
  const source = await readSmaliMethod(
    root,
    'smali_classes3/com/baidu/homework/common/net/OooOo00.smali',
    'Lcom/baidu/homework/common/net/OooOo00;',
    'public static Oooo0oo(Lo000oo0O/OooO;Ljava/lang/Class;ZZ)Ljava/lang/Object;',
  );
  assert.match(source, /OoooooO\(Lo000oo0O\/OooO;Lcom\/android\/volley\/o0OoOo0\$OooO0O0;Lcom\/android\/volley\/o0OoOo0\$OooO00o;\)Lo000o0o\/Oooo000;/);
  assert.match(source, /OooOOO0:Lcom\/baidu\/homework\/common\/net\/NetContext;[\s\S]*NetContext;->OooO00o\(\)Lo000o0o\/OooOo;/);
  assert.match(source, /Lo000o0o\/OooOo;->OooO00o\(Lcom\/android\/volley\/Request;\)Lcom\/android\/volley\/Oooo0;/);
  assert.match(source, /o0OoOo0;->OooO0O0\(\)Z/);
  assert.match(source, /Ooooo0o\(Lcom\/android\/volley\/VolleyError;Lo000o0o\/Oooo000;\)V/);
  assert.doesNotMatch(source, /return-void/);
});

test('E20 registers only the active v2 bridge owner before dispatch and completes rejected callbacks', async (t) => {
  await mkdir(cache, { recursive: true });
  const fixtureRoot = await mkdtemp(path.join(cache, 'teaching-bootstrap-v2-bridge-simulation-'));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const targetPath = path.join(fixtureRoot, v2BridgePath);
  await mkdir(path.dirname(targetPath), { recursive: true });
  await copyFile(path.join(root, v2BridgePath), targetPath);

  const fullSpec = JSON.parse(await readFile('patches/slim-v1/patch-spec.json', 'utf8'));
  const operations = fullSpec.operations.filter((operation) => operation.id === 'T27-E20-register-v2-raw-owner');
  assert.equal(operations.length, 1, 'the v2 raw bridge has one complete-descriptor operation');
  const specPath = path.join(fixtureRoot, 'v2-bridge-fixture-spec.json');
  await writeFile(specPath, JSON.stringify({ schemaVersion: 1, applicationId: 'io.github.wakeupnoads', operations }));
  await applyPatchSpec({ root: fixtureRoot, specPath });

  const method = await readSmaliMethod(
    fixtureRoot,
    v2BridgePath,
    'Lcom/suda/yzune/wakeupschedule/schedule_import/v2/ParserFragment$configWebView$7;',
    'public onAction(Landroid/app/Activity;Lorg/json/JSONObject;Lcom/baidu/homework/common/ui/widget/HybridWebView$OooOo;)V',
  );
  assert.match(method, /registerV2BridgeInput\(Ljava\/lang\/Object;Ljava\/lang\/Object;Ljava\/lang\/Object;Ljava\/lang\/Object;Ljava\/lang\/String;\)Z/);
  assert.match(method, /if-eqz v2, :slim_v2_reject_unowned_raw[\s\S]*?callback\(Lcom\/baidu\/homework\/common\/ui\/widget\/HybridWebView\$OooOo;Z\)V[\s\S]*?return-void[\s\S]*?EncryptNet;->OooOO0O/);
});

test('E18 creates the school-list parent only at the real Activity-backed request site', async (t) => {
  await mkdir(cache, { recursive: true });
  const fixtureRoot = await mkdtemp(path.join(cache, 'teaching-bootstrap-school-list-simulation-'));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const targetPath = path.join(fixtureRoot, schoolListPath);
  await mkdir(path.dirname(targetPath), { recursive: true });
  await copyFile(path.join(root, schoolListPath), targetPath);

  const fullSpec = JSON.parse(await readFile('patches/slim-v1/patch-spec.json', 'utf8'));
  const operations = fullSpec.operations.filter((operation) => operation.id === 'T27-E18-register-school-list-parent');
  assert.equal(operations.length, 1, 'school-list parent creation has one exact callsite');
  const specPath = path.join(fixtureRoot, 'school-list-fixture-spec.json');
  await writeFile(specPath, JSON.stringify({ schemaVersion: 1, applicationId: 'io.github.wakeupnoads', operations }));
  await applyPatchSpec({ root: fixtureRoot, specPath });

  const method = await readSmaliMethod(
    fixtureRoot,
    schoolListPath,
    'Lcom/suda/yzune/wakeupschedule/schedule_import/SchoolListActivity$initSchoolList$1$3;',
    'public final invokeSuspend(Ljava/lang/Object;)Ljava/lang/Object;',
  );
  assert.match(method, /registerKnownTeachingStaticInput\(Ljava\/lang\/Object;Ljava\/lang\/Object;Ljava\/lang\/String;\)Lcom\/suda\/yzune\/wakeupschedule\/slim\/SlimNetworkPolicy\$ParentToken;/);
  assert.match(method, /const-string v1, "school-list-teaching-route"[\s\S]*?move-result-object v1[\s\S]*?EncryptNet;->OooOO0O/);
});

test('E18 and E20 wire all reviewed parser owners and revoke them at view teardown', async (t) => {
  await mkdir(cache, { recursive: true });
  const fixtureRoot = await mkdtemp(path.join(cache, 'teaching-bootstrap-parser-routes-simulation-'));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  for (const relative of [v2FragmentPath, dxFragmentPath, dxBridgePath, v2BridgePath, webViewFragmentPath]) {
    const targetPath = path.join(fixtureRoot, relative);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await copyFile(path.join(root, relative), targetPath);
  }

  const fullSpec = JSON.parse(await readFile('patches/slim-v1/patch-spec.json', 'utf8'));
  const expectedIds = [
    'T27-E20-register-v2-root-script-owner',
    'T27-E20-register-dx-root-script-owner',
    'T27-E20-register-webview-script-owner',
    'T27-E20-register-dx-raw-owner',
    'T27-E20-register-v2-raw-owner',
    'T27-E20-revoke-v2-owner-on-destroy-view',
    'T27-E20-revoke-dx-owner-on-destroy-view',
    'T27-E20-revoke-webview-owner-on-destroy-view',
  ];
  const operations = fullSpec.operations.filter((operation) => expectedIds.includes(operation.id));
  assert.deepEqual(operations.map((operation) => operation.id).sort(), expectedIds.slice().sort());
  const specPath = path.join(fixtureRoot, 'parser-routes-fixture-spec.json');
  await writeFile(specPath, JSON.stringify({ schemaVersion: 1, applicationId: 'io.github.wakeupnoads', operations }));
  await applyPatchSpec({ root: fixtureRoot, specPath });

  const v2Root = await readSmaliMethod(fixtureRoot, v2FragmentPath, 'Lcom/suda/yzune/wakeupschedule/schedule_import/v2/ParserFragment;', 'private final o000Ooo0(Ljava/lang/String;)V');
  const dxRoot = await readSmaliMethod(fixtureRoot, dxFragmentPath, 'Lcom/suda/yzune/wakeupschedule/schedule_import/DXParserLoginFragment;', 'public final o000ooO0(Ljava/lang/String;)V');
  const webRoot = await readSmaliMethod(fixtureRoot, webViewFragmentPath, 'Lcom/suda/yzune/wakeupschedule/schedule_import/WebViewLoginFragment;', 'public final o0000o()V');
  const dxAction = await readSmaliMethod(fixtureRoot, dxBridgePath, 'Lcom/suda/yzune/wakeupschedule/schedule_import/DXParserLoginFragment$onViewCreated$7;', 'public onAction(Landroid/app/Activity;Lorg/json/JSONObject;Lcom/baidu/homework/common/ui/widget/HybridWebView$OooOo;)V');
  const dxTeardown = await readSmaliMethod(fixtureRoot, dxFragmentPath, 'Lcom/suda/yzune/wakeupschedule/schedule_import/DXParserLoginFragment;', 'public onDestroyView()V');
  const webTeardown = await readSmaliMethod(fixtureRoot, webViewFragmentPath, 'Lcom/suda/yzune/wakeupschedule/schedule_import/WebViewLoginFragment;', 'public onDestroyView()V');
  for (const method of [v2Root, dxRoot, webRoot]) {
    assert.match(method, /registerKnownTeachingStaticInput[\s\S]*EncryptNet;->OooOO0O/, 'each static plugin request is owner-registered before dispatch');
  }
  assert.match(dxAction, /registerDxBridgeInput[\s\S]*callback\(Lcom\/baidu\/homework\/common\/ui\/widget\/HybridWebView\$OooOo;Z\)V[\s\S]*return-void/);
  assert.match(dxTeardown, /revokeOwner\(Ljava\/lang\/Object;\)I[\s\S]*iput-boolean v0/);
  assert.match(webTeardown, /revokeOwner\(Ljava\/lang\/Object;\)I[\s\S]*CookieManager;->getInstance/);
});

test('E53 patch binds redirect changes to the claimed bootstrap Request identity', async (t) => {
  await mkdir(cache, { recursive: true });
  const fixtureRoot = await mkdtemp(path.join(cache, 'teaching-bootstrap-transport-simulation-'));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  for (const relative of [antispamPath, syncNetPath, transportPath, v2BridgePath, v2FragmentPath, schoolListPath]) {
    const targetPath = path.join(fixtureRoot, relative);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await copyFile(path.join(root, relative), targetPath);
  }
  const fullSpec = JSON.parse(await readFile('patches/slim-v1/patch-spec.json', 'utf8'));
  const transportOperationIds = [
    'T27-E18-register-school-list-parent',
    'T27-E20-register-v2-raw-owner',
    'T27-E20-revoke-v2-owner-on-destroy-view',
    'T27-E42-register-exact-child',
    'T27-E42-reject-unregistered-child',
    'T27-E43-require-sync-owner-permit',
    'T27-E43-bind-bootstrap-transport',
    'T27-E53-bootstrap-no-redirect',
  ];
  const operations = fullSpec.operations.filter((operation) => transportOperationIds.includes(operation.id));
  assert.equal(operations.length, 8, 'E18/E20 owner adapters, E42, E43, and E53 exact operations are in the production patch spec');
  const specPath = path.join(fixtureRoot, 'fixture-spec.json');
  await writeFile(specPath, JSON.stringify({ schemaVersion: 1, applicationId: 'io.github.wakeupnoads', operations }, null, 2));
  const result = await applyPatchSpec({ root: fixtureRoot, specPath });
  const method = await readSmaliMethod(fixtureRoot, transportPath, transportClass, transportMethod);
  const antispam = await readSmaliMethod(
    fixtureRoot, antispamPath, 'Lo0Oo0OOO/o000OOo;',
    'public static OooO0O0(Ljava/lang/String;)Lcom/baidu/homework/common/net/model/v1/PlutoAntispam;',
  );
  const synchronous = await readSmaliMethod(
    fixtureRoot, syncNetPath, 'Lcom/baidu/homework/common/net/OooOo00;',
    'public static Oooo0oo(Lo000oo0O/OooO;Ljava/lang/Class;ZZ)Ljava/lang/Object;',
  );
  assert.equal(result.operations.length, 8);
  const parserLifecycle = await readSmaliMethod(
    fixtureRoot, v2FragmentPath, 'Lcom/suda/yzune/wakeupschedule/schedule_import/v2/ParserFragment;', 'public onDestroyView()V',
  );
  assert.match(antispam, /registerBootstrapChild\(Ljava\/lang\/Object;\)Z/);
  assert.match(antispam, /:slim_reject_antispam_child[\s\S]*return-object v0/);
  assert.match(synchronous, /isBootstrapActive\(\)Z[\s\S]*consumeBootstrapChild\(Ljava\/lang\/Object;Ljava\/lang\/String;\)Z/);
  assert.match(synchronous, /hasRequestLicense\(Ljava\/lang\/Object;\)Z/);
  assert.match(synchronous, /bindBootstrapTransport\(Ljava\/lang\/Object;Ljava\/lang\/Object;Ljava\/lang\/String;\)Z/);
  assert.match(synchronous, /consumeForQueue\(Ljava\/lang\/Object;Ljava\/lang\/String;\)Z/);
  assert.match(method, /hasBootstrapTransport\(Ljava\/lang\/Object;\)Z/);
  assert.match(method, /claimBootstrapTransport\(Ljava\/lang\/Object;Ljava\/lang\/String;\)Z/);
  assert.match(method, /const\/4 v0, 0x0\s+goto :slim_bootstrap_apply_redirects\s+:slim_bootstrap_transport_reject/s);
  assert.match(method, /:slim_bootstrap_apply_redirects[\s\S]*?invoke-virtual \{v5, v0\}.*OooO0oO\(Z\)/);
  assert.match(method, /invoke-virtual \{v6, v0\}.*OooO0oo\(Z\)/s);
  assert.match(method, /new-instance v7, Ljava\/io\/IOException;[\s\S]*throw v7/);
  assert.match(parserLifecycle, /revokeOwner\(Ljava\/lang\/Object;\)I[\s\S]*setOnReceivedHttpErrorListener/);

  const mutationsRoot = path.join(fixtureRoot, 't30-mutations');
  await mkdir(mutationsRoot, { recursive: true });
  await writeFile(path.join(mutationsRoot, 'fixture-meta.json'), JSON.stringify({ simulated: true, source: 'baseline Smali plus exact T27 patch operations', noExternalRequests: true }, null, 2));
  const transportMutations = [
    {
      id: 'remove-antispam-parent-child-registration', source: antispam,
      edge: 'SlimNetworkPolicy;->registerBootstrapChild(Ljava/lang/Object;)Z',
      mutate: (source) => source.replace(/    invoke-static \{p0\}, Lcom\/suda\/yzune\/wakeupschedule\/slim\/SlimNetworkPolicy;->registerBootstrapChild\(Ljava\/lang\/Object;\)Z/, '    nop'),
    },
    {
      id: 'remove-sync-parent-license-check', source: synchronous,
      edge: 'SlimNetworkPolicy;->hasRequestLicense(Ljava/lang/Object;)Z',
      mutate: (source) => source.replace(/    invoke-static \{p0\}, Lcom\/suda\/yzune\/wakeupschedule\/slim\/SlimNetworkPolicy;->hasRequestLicense\(Ljava\/lang\/Object;\)Z/, '    nop'),
    },
    {
      id: 'enable-bootstrap-auto-redirect', source: method,
      mutate: (source) => source.replace('    const/4 v0, 0x0\n    goto :slim_bootstrap_apply_redirects', '    const/4 v0, 0x1\n    goto :slim_bootstrap_apply_redirects'),
    },
  ];
  for (const mutation of transportMutations) {
    const changed = mutation.mutate(mutation.source);
    assert.notEqual(changed, mutation.source, `${mutation.id} changes the actual patched adapter method`);
    assert.equal(sameExecutableSmaliMethod(mutation.source, changed), false, `${mutation.id} is detected at its exact method`);
    if (mutation.edge) {
      assert.equal(hasSmaliInvoke(mutation.source, mutation.edge), true, `${mutation.id} begins with the protected invoke edge`);
      assert.equal(hasSmaliInvoke(changed, mutation.edge), false, `${mutation.id} removes the protected invoke edge`);
      assert.notDeepEqual(smaliInvokeEdges(mutation.source), smaliInvokeEdges(changed));
    }
    await writeFile(path.join(mutationsRoot, `${mutation.id}.smali`), changed, 'utf8');
  }

  // The fixture models only the two redirect switches in the actual patched method; it is not an Android or server test.
  const bootstrapFollowsRedirects = (source) => /const\/4 v0, 0x1\s+goto :slim_bootstrap_apply_redirects/.test(source);
  const redirectAttempts = (bootstrap, redirectStatus, followsRedirects = true) => {
    const follows = bootstrap ? followsRedirects : true;
    return redirectStatus && follows ? 2 : 1;
  };
  assert.equal(bootstrapFollowsRedirects(method), false, 'the actual bootstrap branch disables both automatic redirect switches');
  assert.equal(redirectAttempts(true, true, bootstrapFollowsRedirects(method)), 1, 'a bootstrap 3xx does not issue a second request');
  const redirectMutation = transportMutations.find((mutation) => mutation.id === 'enable-bootstrap-auto-redirect');
  assert.equal(bootstrapFollowsRedirects(redirectMutation.mutate(method)), true, 'the redirected fixture is identified as a changed bootstrap transport');
  assert.equal(redirectAttempts(true, true, bootstrapFollowsRedirects(redirectMutation.mutate(method))), 2,
    'the redirect mutation causes the transport fixture to observe a second connection attempt');
  assert.equal(redirectAttempts(false, true), 2, 'ordinary requests retain their original redirect behavior');
});

test('E47 rebuilds the RC4 pool atomically, redacts the key, and invalidates stale leases', async (t) => {
  await mkdir(cache, { recursive: true });
  const fixtureRoot = await mkdtemp(path.join(cache, 'teaching-crypto-simulation-'));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const target = path.join(fixtureRoot, rc4Path);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(path.join(root, rc4Path), target);
  const fullSpec = JSON.parse(await readFile('patches/slim-v1/patch-spec.json', 'utf8'));
  const operations = fullSpec.operations.filter((operation) => operation.id === 'T28-E47-clear-rc4-pool-with-key' || operation.id === 'T28-E47-atomic-rc4-pool-rebuild');
  assert.equal(operations.length, 2, 'the exact log and invalidation operations are in the production spec');
  const specPath = path.join(fixtureRoot, 'crypto-fixture-spec.json');
  await writeFile(specPath, JSON.stringify({ schemaVersion: 1, applicationId: 'io.github.wakeupnoads', operations }));
  await applyPatchSpec({ root: fixtureRoot, specPath });
  const init = await readSmaliMethod(fixtureRoot, rc4Path, 'Lcom/suda/yzune/wakeupschedule/aaa/utils/oOO00O;', 'public OooOO0o()V');
  const invalidate = await readSmaliMethod(fixtureRoot, rc4Path, 'Lcom/suda/yzune/wakeupschedule/aaa/utils/oOO00O;', 'public OooOO0O()V');
  assert.doesNotMatch(init, /key: |o000O0;->OooO0OO\(Ljava\/lang\/String;Ljava\/lang\/String;\)V/);
  assert.match(init, /Rc4PoolLifecycle;->rebuild\(Ljava\/lang\/Object;Ljava\/util\/concurrent\/BlockingQueue;Ljava\/lang\/Object;\)V/);
  assert.match(invalidate, /iput-object v1, p0, Lcom\/suda\/yzune\/wakeupschedule\/aaa\/utils\/oOO00O;->OooO0O0:Ljava\/lang\/String;[\s\S]*?Rc4PoolLifecycle;->invalidate\(Ljava\/lang\/Object;Ljava\/util\/concurrent\/BlockingQueue;\)V/);
});

test('E16 runs the owner-bound bootstrap before crypto and routes failures to callback or continuation', async (t) => {
  await mkdir(cache, { recursive: true });
  const fixtureRoot = await mkdtemp(path.join(cache, 'teaching-bootstrap-encryptnet-simulation-'));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const paths = [
    'smali_classes6/com/suda/yzune/wakeupschedule/aaa/utils/EncryptNet.smali',
    'smali_classes6/com/suda/yzune/wakeupschedule/aaa/utils/EncryptNet$buildEncryptInput$1.smali',
    'smali_classes6/com/suda/yzune/wakeupschedule/aaa/utils/EncryptNet$OooO0O0.smali',
    'smali_classes6/com/suda/yzune/wakeupschedule/aaa/utils/o000OOo.smali',
  ];
  for (const relative of paths) {
    const target = path.join(fixtureRoot, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(root, relative), target);
  }
  const fullSpec = JSON.parse(await readFile('patches/slim-v1/patch-spec.json', 'utf8'));
  const operations = fullSpec.operations.filter((operation) => operation.id.startsWith('T28-E16-')
    && operation.id !== 'T28-E16-reject-empty-encrypted-data');
  assert.equal(operations.length, 16, 'the production spec has the bootstrap, dual callback ABI, migrated callers, and continuation operations');
  const specPath = path.join(fixtureRoot, 'encryptnet-fixture-spec.json');
  await writeFile(specPath, JSON.stringify({ schemaVersion: 1, applicationId: 'io.github.wakeupnoads', operations }, null, 2));
  await applyPatchSpec({ root: fixtureRoot, specPath });

  const buildInput = await readSmaliMethod(
    fixtureRoot, paths[1], 'Lcom/suda/yzune/wakeupschedule/aaa/utils/EncryptNet$buildEncryptInput$1;',
    'public final invokeSuspend(Ljava/lang/Object;)Ljava/lang/Object;',
  );
  const networkCallback = await readSmaliMethod(
    fixtureRoot, paths[3], 'Lcom/suda/yzune/wakeupschedule/aaa/utils/o000OOo;', 'public final invoke(Ljava/lang/Object;)Ljava/lang/Object;',
  );
  const coroutineCallback = await readSmaliMethod(
    fixtureRoot, paths[2], 'Lcom/suda/yzune/wakeupschedule/aaa/utils/EncryptNet$OooO0O0;',
    'public bridge synthetic invoke(Ljava/lang/Object;)Ljava/lang/Object;',
  );
  const apiEntry = await readSmaliMethod(
    fixtureRoot, paths[0], 'Lcom/suda/yzune/wakeupschedule/aaa/utils/EncryptNet;',
    'public final OooO0o(Lo000oo0O/OooO;Lkotlin/jvm/functions/Function1;)V',
  );
  const dualEntry = await readSmaliMethod(
    fixtureRoot, paths[0], 'Lcom/suda/yzune/wakeupschedule/aaa/utils/EncryptNet;',
    'private final OooO0oV(Lo000oo0O/OooO;Lkotlin/jvm/functions/Function1;Lkotlin/jvm/functions/Function1;)V',
  );
  const apiCaller = await readSmaliMethod(
    fixtureRoot, paths[0], 'Lcom/suda/yzune/wakeupschedule/aaa/utils/EncryptNet;',
    'public static final OooOO0O(Landroid/content/Context;Lo000oo0O/OooO;Lcom/baidu/homework/common/net/OooOo00$Oooo0;Lcom/baidu/homework/common/net/OooOo00$OooOo00;)V',
  );
  const suspendCaller = await readSmaliMethod(
    fixtureRoot, paths[0], 'Lcom/suda/yzune/wakeupschedule/aaa/utils/EncryptNet;',
    'public final OooOOO0(Landroid/content/Context;Lo000oo0O/OooO;Lo0o0OOO/o000Oo0;)Ljava/lang/Object;',
  );
  const encryptNetSource = await readFile(path.join(fixtureRoot, paths[0]), 'utf8');
  const abiContract = {
    classDescriptor: 'Lcom/suda/yzune/wakeupschedule/aaa/utils/EncryptNet;',
    targetMethodDescriptor: 'OooO0oV(Lo000oo0O/OooO;Lkotlin/jvm/functions/Function1;Lkotlin/jvm/functions/Function1;)V',
    callers: [
      { methodDescriptor: 'public final OooO0o(Lo000oo0O/OooO;Lkotlin/jvm/functions/Function1;)V' },
      { methodDescriptor: 'public static final OooOO0O(Landroid/content/Context;Lo000oo0O/OooO;Lcom/baidu/homework/common/net/OooOo00$Oooo0;Lcom/baidu/homework/common/net/OooOo00$OooOo00;)V' },
      { methodDescriptor: 'public final OooOOO0(Landroid/content/Context;Lo000oo0O/OooO;Lo0o0OOO/o000Oo0;)Ljava/lang/Object;' },
    ],
  };
  assert.equal(assertPrivateInvokeAbi(encryptNetSource, abiContract, paths[0]), true,
    'all three callers invoke the same private final entry with the exact argument word count');
  assert.match(buildInput, /requireReadyForInput\(Ljava\/lang\/Object;\)V[\s\S]*EncryptNet;->OooO0O0/,
    'background construction proves owner/bootstrap readiness before EncryptNet input construction');
  assert.match(buildInput, /\.catch Ljava\/lang\/Throwable; \{:slim_build_encrypt_input_start \.\. :slim_build_encrypt_input_end\}[\s\S]*CancellationException;[\s\S]*throw p1[\s\S]*Function1;->invoke\(Ljava\/lang\/Object;\)Ljava\/lang\/Object;/,
    'crypto failures are delivered once and cancellation remains cancellation');
  assert.match(networkCallback, /instance-of v0, p1, Ljava\/lang\/Throwable;[\s\S]*TeachingBootstrap;->reportNetworkFailure\(Ljava\/lang\/Object;Ljava\/lang\/Throwable;\)V[\s\S]*:slim_encrypt_success_callback/,
    'the existing NetError listener receives bootstrap/crypto failures and success stays separate');
  assert.match(coroutineCallback, /OooO00o\(Ljava\/lang\/Throwable;\)Ljava\/lang\/Object;[\s\S]*Lkotlin\/Result;->box-impl\(Ljava\/lang\/Object;\)Lkotlin\/Result;[\s\S]*Lkotlinx\/coroutines\/Oooo000;->OooO0oO\(Ljava\/lang\/Object;Lkotlin\/jvm\/functions\/Function1;\)V[\s\S]*:slim_encrypt_resume_success/,
    'suspend callers receive a boxed failed Kotlin Result, matching the original NetError listener, instead of a success callback');
  assert.doesNotMatch(coroutineCallback, /resumeWith\(Ljava\/lang\/Object;\)V/,
    'bootstrap/crypto failures never resume the caller exceptionally; the original API returns Result and callers do not catch');
  assert.match(apiEntry, /public final OooO0o\([\s\S]*OooO0oV\(Lo000oo0O\/OooO;Lkotlin\/jvm\/functions\/Function1;Lkotlin\/jvm\/functions\/Function1;\)V/,
    'the old binary entry remains and delegates with a null error callback, preserving its success-only contract');
  assert.match(dualEntry, /new-instance v4,[\s\S]*-><init>\(Lo000oo0O\/OooO;Lkotlin\/jvm\/functions\/Function1;Lkotlin\/jvm\/functions\/Function1;Lo0o0OOO\/o000Oo0;\)V/,
    'the new private entry carries separate success and failure callbacks into the coroutine');
  assert.match(apiCaller, /OooO0oV\(Lo000oo0O\/OooO;Lkotlin\/jvm\/functions\/Function1;Lkotlin\/jvm\/functions\/Function1;\)V/);
  assert.match(suspendCaller, /OooO0oV\(Lo000oo0O\/OooO;Lkotlin\/jvm\/functions\/Function1;Lkotlin\/jvm\/functions\/Function1;\)V/);
  assert.match(`${apiEntry}\n${apiCaller}\n${suspendCaller}`, /invoke-direct(?:\/range)?\s+\{[^}]+\}, Lcom\/suda\/yzune\/wakeupschedule\/aaa\/utils\/EncryptNet;->OooO0oV/,
    'private instance calls use invoke-direct at the old entry and both migrated sites');
  assert.doesNotMatch(`${apiCaller}\n${suspendCaller}`, /->OooO0o\(Lo000oo0O\/OooO;Lkotlin\/jvm\/functions\/Function1;\)V/,
    'no reachable API or suspend caller remains on the legacy success-only entry');
  assert.match(buildInput, /:slim_build_encrypt_input_report_error[\s\S]*\$errorCallback:Lkotlin\/jvm\/functions\/Function1;[\s\S]*if-eqz v1, :slim_build_encrypt_input_rethrow/,
    'only the separate failure callback receives build errors; legacy callers rethrow when no error callback exists');

  const mutationsRoot = path.join(fixtureRoot, 't30-mutations');
  await mkdir(mutationsRoot, { recursive: true });
  await writeFile(path.join(mutationsRoot, 'fixture-meta.json'), JSON.stringify({ simulated: true, source: 'baseline Smali plus exact T28 patch operations', noExternalRequests: true }, null, 2));
  const abiMutations = [
    ['virtual-private-call', encryptNetSource.replace('invoke-direct {p0, p1, p2, v0}, Lcom/suda/yzune/wakeupschedule/aaa/utils/EncryptNet;->OooO0oV', 'invoke-virtual {p0, p1, p2, v0}, Lcom/suda/yzune/wakeupschedule/aaa/utils/EncryptNet;->OooO0oV')],
    ['static-private-call', encryptNetSource.replace('invoke-direct {v0, p1, v1, v1}, Lcom/suda/yzune/wakeupschedule/aaa/utils/EncryptNet;->OooO0oV', 'invoke-static {v0, p1, v1, v1}, Lcom/suda/yzune/wakeupschedule/aaa/utils/EncryptNet;->OooO0oV')],
    ['wrong-register-word-count', encryptNetSource.replace('invoke-direct {p0, p1, p2, v0}, Lcom/suda/yzune/wakeupschedule/aaa/utils/EncryptNet;->OooO0oV', 'invoke-direct {p0, p1, p2}, Lcom/suda/yzune/wakeupschedule/aaa/utils/EncryptNet;->OooO0oV')],
    ['wrong-target-descriptor', encryptNetSource.replace('Lkotlin/jvm/functions/Function1;Lkotlin/jvm/functions/Function1;)V', 'Ljava/lang/Object;Lkotlin/jvm/functions/Function1;)V')],
    ['non-private-target', encryptNetSource.replace('.method private final OooO0oV(', '.method public final OooO0oV(')],
  ];
  for (const [name, changed] of abiMutations) {
    assert.notEqual(changed, encryptNetSource, `${name} mutates the real patched EncryptNet class`);
    assert.throws(() => assertPrivateInvokeAbi(changed, abiContract, paths[0]), undefined, `${name} violates the private call ABI`);
  }
  const failureResumeEdge = 'Lkotlinx/coroutines/Oooo000;->OooO0oO(Ljava/lang/Object;Lkotlin/jvm/functions/Function1;)V';
  const failureResumeLine = coroutineCallback.split('\n').find((line) => line.includes(failureResumeEdge));
  assert.ok(failureResumeLine, 'the patched callback contains the concrete continuation failure edge');
  const mutations = [
    {
      id: 'remove-encryptnet-bootstrap-front-edge', source: buildInput,
      edge: 'TeachingBootstrap;->requireReadyForInput(Ljava/lang/Object;)V',
      mutate: (source) => source.replace(/    invoke-static \{v2\}, Lcom\/suda\/yzune\/wakeupschedule\/slim\/TeachingBootstrap;->requireReadyForInput\(Ljava\/lang\/Object;\)V/, '    nop'),
    },
    {
      id: 'swallow-coroutine-failure-completion', source: coroutineCallback, edge: failureResumeEdge,
      mutate: (source) => source.replace(failureResumeLine, '    nop'),
    },
  ];
  for (const mutation of mutations) {
    const changed = mutation.mutate(mutation.source);
    assert.notEqual(changed, mutation.source, `${mutation.id} changes the actual patched method`);
    assert.equal(sameExecutableSmaliMethod(mutation.source, changed), false, `${mutation.id} is rejected at its exact method`);
    assert.equal(hasSmaliInvoke(mutation.source, mutation.edge), true, `${mutation.id} begins with the required front/error edge`);
    assert.equal(hasSmaliInvoke(changed, mutation.edge), false, `${mutation.id} removes the required edge`);
    assert.notDeepEqual(smaliInvokeEdges(mutation.source), smaliInvokeEdges(changed));
    await writeFile(path.join(mutationsRoot, `${mutation.id}.smali`), changed, 'utf8');
  }
});

test('E43 owner preflight rejects native signature sentinels before appending the signature', async (t) => {
  await mkdir(cache, { recursive: true });
  const fixtureRoot = await mkdtemp(path.join(cache, 'teaching-bootstrap-signature-simulation-'));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const relative = 'smali_classes3/com/baidu/homework/common/net/OooOo00.smali';
  const target = path.join(fixtureRoot, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(path.join(root, relative), target);
  const fullSpec = JSON.parse(await readFile('patches/slim-v1/patch-spec.json', 'utf8'));
  const operations = fullSpec.operations.filter((operation) => operation.id.startsWith('T28-E43-'));
  assert.equal(operations.length, 2);
  const specPath = path.join(fixtureRoot, 'signature-fixture-spec.json');
  await writeFile(specPath, JSON.stringify({ schemaVersion: 1, applicationId: 'io.github.wakeupnoads', operations }, null, 2));
  await applyPatchSpec({ root: fixtureRoot, specPath });
  const method = await readSmaliMethod(
    fixtureRoot, relative, 'Lcom/baidu/homework/common/net/OooOo00;',
    'public static OooO(Lo000oo0O/OooO;)Ljava/lang/String;',
  );
  assert.ok(method.indexOf('requireReadyForInput(Ljava/lang/Object;)V') < method.indexOf('OooOO0(Lo000oo0O/OooO;Ljava/util/ArrayList;)Ljava/lang/String;'),
    'owner-bound crypto readiness is checked before request signing');
  assert.ok(method.indexOf('requireUsableSignature(Ljava/lang/Object;)V') < method.indexOf('const-string v0, "&sign="'),
    'empty/error/init_error/so_error signing results cannot be appended to a business URL');
  const mutationRoot = path.join(fixtureRoot, 't30-mutations');
  await mkdir(mutationRoot, { recursive: true });
  await writeFile(path.join(mutationRoot, 'fixture-meta.json'), JSON.stringify({ simulated: true, source: 'baseline Smali plus exact T28 E43 patch operations', noExternalRequests: true }, null, 2));
  const signatureEdge = 'TeachingBootstrap;->requireUsableSignature(Ljava/lang/Object;)V';
  const mutation = method.replace(/    invoke-static \{p0\}, Lcom\/suda\/yzune\/wakeupschedule\/slim\/TeachingBootstrap;->requireUsableSignature\(Ljava\/lang\/Object;\)V/, '    nop');
  assert.notEqual(mutation, method, 'signature mutation changes the actual patched method');
  assert.equal(sameExecutableSmaliMethod(method, mutation), false, 'removing signature validation is rejected at the signing method');
  assert.equal(hasSmaliInvoke(method, signatureEdge), true, 'the patched signer contains the usable-signature edge');
  assert.equal(hasSmaliInvoke(mutation, signatureEdge), false, 'the mutation removes the usable-signature edge');
  assert.notDeepEqual(smaliInvokeEdges(method), smaliInvokeEdges(mutation));
  await writeFile(path.join(mutationRoot, 'remove-signature-sentinel-check.smali'), mutation, 'utf8');
});

test('E31 defers DX raw and encrypted requests off the WebView caller and transfers wrapper identity', async (t) => {
  await mkdir(cache, { recursive: true });
  const fixtureRoot = await mkdtemp(path.join(cache, 'teaching-bootstrap-dx-simulation-'));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const dxPath = 'smali_classes6/com/suda/yzune/wakeupschedule/schedule_import/DXParserLoginFragment.smali';
  const bridgePath = 'smali_classes6/com/suda/yzune/wakeupschedule/schedule_import/DXParserLoginFragment$onViewCreated$7.smali';
  for (const relative of [dxPath, bridgePath]) {
    const target = path.join(fixtureRoot, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(root, relative), target);
  }
  const fullSpec = JSON.parse(await readFile('patches/slim-v1/patch-spec.json', 'utf8'));
  const operations = fullSpec.operations.filter((operation) => operation.id.startsWith('T28-E31-'));
  assert.equal(operations.length, 2, 'the DX Request adapter defers initialization and transfers the wrapped request identity');
  const specPath = path.join(fixtureRoot, 'dx-fixture-spec.json');
  await writeFile(specPath, JSON.stringify({ schemaVersion: 1, applicationId: 'io.github.wakeupnoads', operations }, null, 2));
  await applyPatchSpec({ root: fixtureRoot, specPath });

  const requestMethod = await readSmaliMethod(
    fixtureRoot, dxPath, 'Lcom/suda/yzune/wakeupschedule/schedule_import/DXParserLoginFragment;',
    'public final o00oOoo(Landroid/content/Context;ZLo000oo0O/OooO;Lcom/baidu/homework/common/net/OooOo00$Oooo0;Lcom/baidu/homework/common/net/OooOo00$OooOo00;)Lcom/android/volley/Request;',
  );
  const webAction = await readSmaliMethod(
    fixtureRoot, bridgePath, 'Lcom/suda/yzune/wakeupschedule/schedule_import/DXParserLoginFragment$onViewCreated$7;',
    'public onAction(Landroid/app/Activity;Lorg/json/JSONObject;Lcom/baidu/homework/common/ui/widget/HybridWebView$OooOo;)V',
  );
  assert.match(requestMethod, /isReadyDxInputOnCurrentThread[\s\S]*runDxRequestAfterReady[\s\S]*return-object v0[\s\S]*:slim_dx_bootstrap_ready/,
    'the WebView action returns immediately while initialization and existing Request construction run on a worker');
  assert.match(requestMethod, /HybridHttpCurrencyRequest\$OooO00o;->OooO00o[\s\S]*SlimNetworkPolicy;->transfer\(Ljava\/lang\/Object;Ljava\/lang\/Object;\)Z[\s\S]*Oooo000\(/,
    'the encrypted wrapper inherits the original owner permit before the existing queue path');
  assert.match(requestMethod, /:slim_dx_wrapper_transferred[\s\S]*Oooo000\(/);
  const dispatch = webAction.indexOf('o000O(');
  assert.ok(dispatch >= 0, 'the actual bridge invokes the Request adapter');
  assert.doesNotMatch(webAction.slice(dispatch), /move-result-object[\s\S]*?return-void/,
    'the only reviewed caller ignores the nullable synchronous Request return');
});
