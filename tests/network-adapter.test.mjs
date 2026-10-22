import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { applyPatchSpec } from '../scripts/patch.mjs';
import { hasSmaliInvoke, parseSmaliClassStructure, readSmaliMethod, sameExecutableSmaliMethod, smaliInvokeEdges } from './smali-helpers.mjs';

const baselineRoot = path.resolve(process.env.SLIM_BASELINE_DECODED_ROOT ?? 'tools/_cache/slim-v1-decoded');
const fixtureCache = path.resolve('tools/_cache/slim-v1-review/fixtures/round-2');
const syncPath = 'smali_classes3/com/baidu/homework/common/net/OooOo00.smali';
const transportPath = 'smali_classes6/o0OO00o0/OooO.smali';
const encryptPath = 'smali_classes6/com/suda/yzune/wakeupschedule/aaa/utils/EncryptNet.smali';
const encryptClass = 'Lcom/suda/yzune/wakeupschedule/aaa/utils/EncryptNet;';
const encryptDescriptor = 'public final OooO0o0(Lo000oo0O/OooO;)Lcom/suda/yzune/wakeupschedule/aaa/v1/HttpCurrencyRequest$OooO00o;';
const transferEdge = 'SlimNetworkPolicy;->transfer(Ljava/lang/Object;Ljava/lang/Object;)Z';
const nonEmptyDataEdge = 'Rc4PoolLifecycle;->requireNonEmptyEncryptedData(Ljava/lang/Object;)V';

function occurrenceCount(source, text) {
  return source.split(text).length - 1;
}

function requiredIndex(source, text, description, startAt = 0) {
  const index = source.indexOf(text, startAt);
  assert.ok(index >= 0, `${description} anchor exists`);
  return index;
}

function assertEncryptInputFrame(method) {
  const frames = method.match(/^\s*\.(?:locals|registers)\s+\d+\s*$/gm) ?? [];
  assert.deepEqual(frames.map((frame) => frame.trim()), ['.locals 7'], 'the original .locals 7 frame is the only frame and remains at method entry');
  assert.ok(method.startsWith(`.method ${encryptDescriptor}\n    .locals 7\n`), 'the original .locals 7 frame is at method entry');
  assert.equal((method.match(/^\s*:cond_0\s*$/gm) ?? []).length, 1, 'the ordinary-branch label has one definition');
  assert.equal(occurrenceCount(method, 'if-eqz v1, :cond_0'), 1, 'the original PatchProxy branch remains');
}

function assertOriginalInputIdentity(method) {
  const labelAt = requiredIndex(method, '\n    :cond_0\n', 'ordinary branch label');
  const saveAt = requiredIndex(method, 'move-object v2, p1', 'original input save');
  const pairCallAt = requiredIndex(method, '->OooOOO(Lo000oo0O/OooO;)Lkotlin/Pair;', 'Pair encryption call');
  const overwrittenParameterAt = requiredIndex(method, 'move-result-object p1', 'Pair result overwrites p1');
  assert.equal(occurrenceCount(method, 'move-object v2, p1'), 1, 'the original input is saved exactly once');
  assert.ok(labelAt < saveAt && saveAt < pairCallAt && pairCallAt < overwrittenParameterAt,
    'the original p1 identity is saved on the ordinary branch before the Pair result overwrites p1');
}

function assertEncryptedWrapperFlow(method) {
  const proxyBranchAt = requiredIndex(method, 'if-eqz v1, :cond_0', 'PatchProxy branch');
  const proxyReturnAt = requiredIndex(method.slice(proxyBranchAt), 'return-object p1', 'PatchProxy early return') + proxyBranchAt;
  const labelAt = requiredIndex(method, '\n    :cond_0\n', 'ordinary branch label');
  const wrapperAt = requiredIndex(method, 'HttpCurrencyRequest$OooO00o;->OooO00o', 'wrapper construction');
  const wrapperResultAt = requiredIndex(method.slice(wrapperAt), 'move-result-object p1', 'constructed wrapper result') + wrapperAt;
  const transferAt = requiredIndex(method, transferEdge, 'wrapper permit transfer');
  const normalReturnAt = requiredIndex(method.slice(transferAt), 'return-object p1', 'ordinary-branch return') + transferAt;
  assert.equal(occurrenceCount(method, transferEdge), 1, 'the wrapper permit is transferred exactly once');
  assert.ok(proxyReturnAt < labelAt, 'the PatchProxy branch keeps its early return before the ordinary branch');
  assert.ok(labelAt < wrapperAt && wrapperAt < wrapperResultAt && wrapperResultAt < transferAt && transferAt < normalReturnAt,
    'the ordinary branch constructs the wrapper, transfers its permit, then returns that wrapper');
}

test('E43 and E53 production operations guard only the exact synchronous bootstrap transport', async (t) => {
  await mkdir(fixtureCache, { recursive: true });
  const fixtureRoot = await mkdtemp(path.join(fixtureCache, 'network-adapter-simulation-'));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  for (const relative of [syncPath, transportPath]) {
    const target = path.join(fixtureRoot, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(baselineRoot, relative), target);
  }
  const fullSpec = JSON.parse(await readFile('patches/slim-v1/patch-spec.json', 'utf8'));
  const ids = new Set(['T27-E43-require-sync-owner-permit', 'T27-E43-bind-bootstrap-transport', 'T27-E53-bootstrap-no-redirect']);
  const operations = fullSpec.operations.filter((operation) => ids.has(operation.id));
  assert.deepEqual(new Set(operations.map((operation) => operation.id)), ids,
    'sync permit, request-bound proof, and redirect control are all present in the production spec');
  const specPath = path.join(fixtureRoot, 'network-adapter-fixture-spec.json');
  await writeFile(specPath, JSON.stringify({ schemaVersion: 1, applicationId: 'io.github.wakeupnoads', operations }));
  await applyPatchSpec({ root: fixtureRoot, specPath });

  const syncMethod = 'public static Oooo0oo(Lo000oo0O/OooO;Ljava/lang/Class;ZZ)Ljava/lang/Object;';
  const sync = await readSmaliMethod(fixtureRoot, syncPath, 'Lcom/baidu/homework/common/net/OooOo00;', syncMethod);
  assert.ok(sync.indexOf('consumeBootstrapChild(Ljava/lang/Object;Ljava/lang/String;)Z') < sync.indexOf(':try_start_0'),
    'the exact bootstrap child is consumed before the synchronous HTTP try/send path');
  assert.ok(sync.indexOf('hasRequestLicense(Ljava/lang/Object;)Z') < sync.indexOf(':try_start_0'),
    'ordinary synchronous input also needs an existing object-bound license');
  assert.match(sync, /bindBootstrapTransport\(Ljava\/lang\/Object;Ljava\/lang\/Object;Ljava\/lang\/String;\)Z/);
  assert.match(sync, /consumeForQueue\(Ljava\/lang\/Object;Ljava\/lang\/String;\)Z/);

  const transport = await readSmaliMethod(
    fixtureRoot, transportPath, 'Lo0OO00o0/OooO;',
    'public OooO00o(Lcom/android/volley/Request;Ljava/util/Map;)Lorg/apache/http/HttpResponse;',
  );
  assert.match(transport, /hasBootstrapTransport\(Ljava\/lang\/Object;\)Z/);
  assert.match(transport, /claimBootstrapTransport\(Ljava\/lang\/Object;Ljava\/lang\/String;\)Z/);
  const hasProofAt = requiredIndex(transport, 'hasBootstrapTransport(Ljava/lang/Object;)Z', 'bootstrap transport proof');
  const claimAt = requiredIndex(transport, 'claimBootstrapTransport(Ljava/lang/Object;Ljava/lang/String;)Z', 'one-shot transport claim');
  const disableAt = requiredIndex(transport, 'const/4 v0, 0x0', 'claimed-request redirect setting', claimAt);
  const rejectAt = requiredIndex(transport, '\n    :slim_bootstrap_transport_reject\n', 'invalid-claim rejection label', disableAt);
  const normalAt = requiredIndex(transport, '\n    :slim_bootstrap_normal_redirects\n', 'ordinary-request redirect label', rejectAt);
  const enableAt = requiredIndex(transport.slice(normalAt), 'const/4 v0, 0x1', 'ordinary redirect setting') + normalAt;
  const applyAt = requiredIndex(transport, '\n    :slim_bootstrap_apply_redirects\n', 'redirect configuration join label', enableAt);
  const followAt = requiredIndex(transport, 'OooO0oO(Z)Lzyb/okhttp3/OkHttpClient$OooO0O0;', 'follow-redirect setting', applyAt);
  const sslAt = requiredIndex(transport, 'OooO0oo(Z)Lzyb/okhttp3/OkHttpClient$OooO0O0;', 'SSL-redirect setting', followAt);
  assert.ok(hasProofAt < claimAt && claimAt < disableAt && disableAt < rejectAt && rejectAt < normalAt,
    'only the successfully claimed bootstrap request reaches the redirect-disabled branch');
  assert.ok(normalAt < enableAt && enableAt < applyAt && applyAt < followAt && followAt < sslAt,
    'unrelated requests retain redirects on both cloned-client settings');
});

test('queue-fixture behavior is exercised by the Java runtime test suite', async () => {
  const javaTest = await readFile('tests/runtime/NetworkAdapterTest.java', 'utf8');
  const runner = await readFile('scripts/test.ps1', 'utf8');
  assert.match(javaTest, /allowsQueue\(classDescriptor, finalUrl, params, input\)/);
  assert.match(javaTest, /enqueued == 0 && success\.get\(\) == 0 && failure\.get\(\) == 2/);
  assert.match(javaTest, /consumeForQueue\(input, finalUrl\)/, 'the behavioral fixture exercises the production single-use queue check');
  assert.match(javaTest, /rejectsDownloadsBeforeQueueing/);
  assert.match(runner, /'NetworkAdapterTest'/, 'scripts/test.ps1 compiles and runs the queue fixture');
  assert.match(runner, /'Rc4PoolLifecycleTest'/, 'scripts/test.ps1 runs the bounded RC4 pool behavior fixture');
});

test('T14 transfers E16 identity and gates both actual E17 Volley entry points', async (t) => {
  await mkdir(fixtureCache, { recursive: true });
  const fixtureRoot = await mkdtemp(path.join(fixtureCache, 'network-adapter-t14-simulation-'));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const netPath = syncPath;
  for (const relative of [encryptPath, netPath]) {
    const target = path.join(fixtureRoot, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(baselineRoot, relative), target);
  }
  const fullSpec = JSON.parse(await readFile('patches/slim-v1/patch-spec.json', 'utf8'));
  const operations = fullSpec.operations.filter((operation) => operation.id.startsWith('T14-'));
  assert.equal(operations.length, 5, 'the T14 production patch contains transfer, async queue, cache, and download gates');
  const specPath = path.join(fixtureRoot, 'network-adapter-t14-spec.json');
  await writeFile(specPath, JSON.stringify({ schemaVersion: 1, applicationId: 'io.github.wakeupnoads', operations }, null, 2));
  await applyPatchSpec({ root: fixtureRoot, specPath });

  const encryptedInput = await readSmaliMethod(
    fixtureRoot, encryptPath, encryptClass, encryptDescriptor,
  );
  assertEncryptInputFrame(encryptedInput);
  assertOriginalInputIdentity(encryptedInput);
  assertEncryptedWrapperFlow(encryptedInput);

  const comboRoot = await mkdtemp(path.join(fixtureCache, 'network-adapter-e16-combo-'));
  t.after(() => rm(comboRoot, { recursive: true, force: true }));
  const comboTarget = path.join(comboRoot, encryptPath);
  await mkdir(path.dirname(comboTarget), { recursive: true });
  await copyFile(path.join(baselineRoot, encryptPath), comboTarget);
  const comboIds = [
    'T14-E16-transfer-owner-license-to-encrypted-input',
    'T14-E16-transfer-encrypted-wrapper-permit',
    'T28-E16-reject-empty-encrypted-data',
  ];
  const comboOperations = fullSpec.operations.filter((operation) => comboIds.includes(operation.id));
  assert.deepEqual(comboOperations.map(({ id }) => id), comboIds, 'the fixture uses the three real same-method production operations in spec order');
  const comboSpecPath = path.join(comboRoot, 'network-adapter-e16-combo-spec.json');
  await writeFile(comboSpecPath, JSON.stringify({ schemaVersion: 1, applicationId: 'io.github.wakeupnoads', operations: comboOperations }, null, 2));
  const comboResult = await applyPatchSpec({ root: comboRoot, specPath: comboSpecPath });
  assert.deepEqual(comboResult.operations.map(({ id, count }) => [id, count]), comboIds.map((id) => [id, 1]));
  const comboMethod = await readSmaliMethod(comboRoot, encryptPath, encryptClass, encryptDescriptor);
  assertEncryptInputFrame(comboMethod);
  assertOriginalInputIdentity(comboMethod);
  assertEncryptedWrapperFlow(comboMethod);
  const emptyCheckAt = requiredIndex(comboMethod, nonEmptyDataEdge, 'empty encrypted-data guard');
  const ordinaryReturnAt = requiredIndex(comboMethod.slice(emptyCheckAt), 'return-object p1', 'normal return after empty-data guard') + emptyCheckAt;
  const wrapperAt = requiredIndex(comboMethod, 'HttpCurrencyRequest$OooO00o;->OooO00o', 'wrapper construction');
  const transferAt = requiredIndex(comboMethod, transferEdge, 'wrapper permit transfer');
  assert.equal(occurrenceCount(comboMethod, nonEmptyDataEdge), 1, 'the empty encrypted-data guard occurs exactly once');
  assert.ok(wrapperAt < transferAt && transferAt < emptyCheckAt && emptyCheckAt < ordinaryReturnAt,
    'the wrapper is built, its permit transferred, then non-empty data checked before ordinary return');

  const originalMethod = await readSmaliMethod(baselineRoot, encryptPath, encryptClass, encryptDescriptor);
  let unmodifiedExecutable = comboMethod;
  for (const insertion of [
    /^    move-object v2, p1\n/gm,
    /^    invoke-static \{v2, p1\}, Lcom\/suda\/yzune\/wakeupschedule\/slim\/SlimNetworkPolicy;->transfer\(Ljava\/lang\/Object;Ljava\/lang\/Object;\)Z\n    move-result v0\n/gm,
    /^    invoke-static \{p1\}, Lcom\/suda\/yzune\/wakeupschedule\/slim\/Rc4PoolLifecycle;->requireNonEmptyEncryptedData\(Ljava\/lang\/Object;\)V\n/gm,
  ]) {
    assert.equal((unmodifiedExecutable.match(insertion) ?? []).length, 1, 'each approved insertion is present exactly once before comparison');
    unmodifiedExecutable = unmodifiedExecutable.replace(insertion, '');
  }
  assert.equal(sameExecutableSmaliMethod(originalMethod, unmodifiedExecutable), true,
    'after removing only the three approved insertions, original proxy and encryption behavior is unchanged');

  const asyncQueue = await readSmaliMethod(
    fixtureRoot, netPath, 'Lcom/baidu/homework/common/net/OooOo00;',
    'public static Oooo0o0(Landroid/content/Context;Lo000oo0O/OooO;Ljava/util/List;Ljava/util/List;Ljava/util/List;Lcom/baidu/homework/common/net/OooOo00$Oooo0;Lcom/baidu/homework/common/net/OooOo00$OooOo00;)Lcom/android/volley/Request;',
  );
  const consume = asyncQueue.indexOf('consumeForQueue(Ljava/lang/Object;Ljava/lang/String;)Z');
  const cacheSuccess = asyncQueue.indexOf('onCacheResponse(Ljava/lang/Object;)V');
  const queueInsert = asyncQueue.indexOf('o000oOoO;->OooO00o(Lcom/android/volley/Request;)');
  const queueReject = asyncQueue.indexOf('\n    :slim_network_queue_rejected') + 1;
  const requestCancel = asyncQueue.indexOf('Request;->cancel()V', queueReject);
  assert.ok(consume >= 0 && consume < cacheSuccess && cacheSuccess < queueInsert,
    'the final Request URL and one-shot input permit are checked before cache success or Volley insertion');
  assert.ok(queueReject > consume && asyncQueue.indexOf('\\u6b64\\u5728\\u7ebf\\u529f\\u80fd\\u5df2\\u79fb\\u9664', queueReject) > queueReject,
    'an unlicensed request follows the local removal-error path');
  assert.ok(requestCancel > queueReject && asyncQueue.indexOf('return-object p2', requestCancel) > requestCancel,
    'the rejected path returns a non-null canceled Request to its callers');
  const rejected = asyncQueue.slice(queueReject, asyncQueue.indexOf('\n    :slim_network_queue_allowed', queueReject));
  assert.equal((rejected.match(/onErrorResponse\(/g) ?? []).length, 1, 'the rejected async request completes one error callback');
  assert.doesNotMatch(rejected, /onResponse\(|onCacheResponse\(/, 'a rejected request does not report success');

  const download = await readSmaliMethod(
    fixtureRoot, netPath, 'Lcom/baidu/homework/common/net/OooOo00;',
    'public static OooOOo0(Landroid/content/Context;Ljava/lang/String;Ljava/lang/String;Lcom/baidu/homework/common/net/OooOo00$Oooo0;Lcom/baidu/homework/common/net/OooOo00$OooOo00;)Lcom/android/volley/Request;',
  );
  const downloadReject = download.indexOf('\\u6b64\\u5728\\u7ebf\\u529f\\u80fd\\u5df2\\u79fb\\u9664');
  const downloadCancel = download.indexOf('Request;->cancel()', downloadReject);
  const downloadReturn = download.indexOf('return-object v0', downloadCancel);
  const downloadQueue = download.indexOf('NetContext;->OooO0O0()Lcom/android/volley/o000oOoO;', downloadReject);
  assert.ok(downloadReject >= 0 && downloadReject < downloadCancel && downloadCancel < downloadReturn && downloadReturn < downloadQueue,
    'the independent download path reports a local error and returns before its Volley queue call');
});

test('T14 rejects missing-label, duplicate-frame, and wrong-input-identity mutations', async (t) => {
  await mkdir(fixtureCache, { recursive: true });
  const fixtureRoot = await mkdtemp(path.join(fixtureCache, 'network-adapter-e16-mutations-'));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const target = path.join(fixtureRoot, encryptPath);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(path.join(baselineRoot, encryptPath), target);
  const fullSpec = JSON.parse(await readFile('patches/slim-v1/patch-spec.json', 'utf8'));
  const ids = [
    'T14-E16-transfer-owner-license-to-encrypted-input',
    'T14-E16-transfer-encrypted-wrapper-permit',
    'T28-E16-reject-empty-encrypted-data',
  ];
  const operations = fullSpec.operations.filter((operation) => ids.includes(operation.id));
  assert.deepEqual(operations.map(({ id }) => id), ids);
  const specPath = path.join(fixtureRoot, 'network-adapter-e16-mutation-spec.json');
  await writeFile(specPath, JSON.stringify({ schemaVersion: 1, applicationId: 'io.github.wakeupnoads', operations }, null, 2));
  await applyPatchSpec({ root: fixtureRoot, specPath });
  const method = await readSmaliMethod(fixtureRoot, encryptPath, encryptClass, encryptDescriptor);

  const label = '\n    :cond_0\n';
  assert.equal(occurrenceCount(method, label), 1, 'missing-label mutation anchor is unique');
  const missingLabel = method.replace(label, '\n');
  assert.notEqual(missingLabel, method, 'missing-label mutation changes the fixture');
  const syntheticClass = `.class public ${encryptClass}\n.super Ljava/lang/Object;\n\n${missingLabel}\n`;
  assert.throws(() => parseSmaliClassStructure(syntheticClass, encryptPath), /Unresolved Smali label :cond_0/);

  assert.equal(occurrenceCount(method, label), 1, 'duplicate-frame mutation anchor is unique');
  const duplicateFrame = method.replace(label, `${label}    .locals 3\n`);
  assert.notEqual(duplicateFrame, method, 'duplicate-frame mutation changes the fixture');
  assert.throws(() => assertEncryptInputFrame(duplicateFrame), /original \.locals 7 frame/);

  assert.equal(occurrenceCount(method, 'move-object v2, p1'), 1, 'wrong-source mutation anchor is unique');
  const wrongIdentity = method.replace('move-object v2, p1', 'move-object v2, p0');
  assert.notEqual(wrongIdentity, method, 'wrong-source mutation changes the fixture');
  assert.throws(() => assertOriginalInputIdentity(wrongIdentity));
});

test('raw bridge and inherited WebView bindings match the original 6.6.0 class ABI', async () => {
  const rawPath = 'smali_classes6/o0Oo0o00.2/o00Ooo.smali';
  const parentPath = 'smali_classes3/o000oo0O.4/OooO.smali';
  const webViewPath = 'smali_classes6/o0OoOoo0.9/o000Oo0.smali';
  const raw = await readFile(path.join(baselineRoot, rawPath), 'utf8');
  const parent = await readFile(path.join(baselineRoot, parentPath), 'utf8');
  const webView = await readFile(path.join(baselineRoot, webViewPath), 'utf8');
  const policy = await readFile('runtime/src/com/suda/yzune/wakeupschedule/slim/SlimNetworkPolicy.java', 'utf8');
  assert.match(raw, /^\.class public Lo0Oo0o00\/o00Ooo;$/m);
  assert.match(raw, /^\.super Lo000oo0O\/OooO;$/m);
  assert.match(raw, /^\.method public constructor <init>\(Ljava\/lang\/String;Ljava\/util\/Map;ILjava\/lang\/Class;\)V$/m);
  assert.match(parent, /^\.class public abstract Lo000oo0O\/OooO;$/m);
  for (const field of ['.field public __url:Ljava/lang/String;', '.field public __method:I', '.field public __aClass:Ljava/lang/Class;']) {
    assert.ok(parent.includes(field), `raw request parent exposes ${field}`);
  }
  assert.match(parent, /^\.method public abstract getParams\(\)Ljava\/util\/Map;$/m);
  assert.match(webView, /^\.field public o00OOoo:Lcom\/zuoyebang\/widget\/CacheHybridWebView;$/m,
    'the public WebView field is declared on the parser fragment base class');
  assert.match(policy, /RAW_BRIDGE_CLASS = "Lo0Oo0o00\/o00Ooo;"/);
  assert.match(policy, /getField\("o00OOoo"\)/);
  assert.doesNotMatch(raw, /Lo0OOOoO0\/OooO0O0;/, 'the old raw request ABI does not resolve to the new 6.6.0 class');
  assert.doesNotMatch(policy, /getField\("oOooo0o"\)/, 'runtime access uses the current inherited WebView field');
});

test('T28 guards the real RC4 helper with valid keys, bounded leases, and failure propagation', async (t) => {
  await mkdir(fixtureCache, { recursive: true });
  const fixtureRoot = await mkdtemp(path.join(fixtureCache, 'network-adapter-t28-rc4-simulation-'));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const rc4Path = 'smali_classes6/com/suda/yzune/wakeupschedule/aaa/utils/oOO00O.smali';
  const encryptPath = 'smali_classes6/com/suda/yzune/wakeupschedule/aaa/utils/EncryptNet.smali';
  for (const relative of [rc4Path, encryptPath]) {
    const target = path.join(fixtureRoot, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(baselineRoot, relative), target);
  }

  const fullSpec = JSON.parse(await readFile('patches/slim-v1/patch-spec.json', 'utf8'));
  const operations = fullSpec.operations.filter((operation) => operation.id.startsWith('T28-E47-') || operation.id === 'T28-E16-reject-empty-encrypted-data');
  assert.ok(operations.length >= 20, 'the production spec covers the pool, key gate, bounded borrows, and transform failures');
  const specPath = path.join(fixtureRoot, 'network-adapter-t28-rc4-spec.json');
  await writeFile(specPath, JSON.stringify({ schemaVersion: 1, applicationId: 'io.github.wakeupnoads', operations }, null, 2));
  await applyPatchSpec({ root: fixtureRoot, specPath });

  const rebuilt = await readSmaliMethod(fixtureRoot, rc4Path, 'Lcom/suda/yzune/wakeupschedule/aaa/utils/oOO00O;',
    'public OooOO0o()V');
  assert.match(rebuilt, /Lo0Oo0OOO\/o0OO00O;->OooO0O0\(Ljava\/lang\/String;\)Ljava\/lang\/String;/,
    'pool rebuilding retains the existing versionCode-seeded baseutil key algorithm');
  assert.match(rebuilt, /Rc4PoolLifecycle;->rebuild\(Ljava\/lang\/Object;Ljava\/util\/concurrent\/BlockingQueue;Ljava\/lang\/Object;\)V/);
  assert.match(rebuilt, /:catchall_0[\s\S]*?iput-object v2, p0[\s\S]*?Rc4PoolLifecycle;->invalidate/,
    'a key or constructor exception clears both key state and the current pool generation');
  assert.doesNotMatch(rebuilt, /key: |printStackTrace/,
    'pool creation does not log the raw key or continue after a partial build');

  const encryptInput = await readSmaliMethod(fixtureRoot, rc4Path, 'Lcom/suda/yzune/wakeupschedule/aaa/utils/oOO00O;',
    'public OooO0o(Ljava/lang/Object;Z)Ljava/lang/Object;');
  const versionKeyAt = requiredIndex(encryptInput, 'requireUsableVersionKey', 'version-key guard');
  const poolTakeAt = requiredIndex(encryptInput, 'Rc4PoolLifecycle;->take', 'bounded pool take');
  assert.ok(versionKeyAt < poolTakeAt, 'an invalid key sentinel stops before borrowing a cipher');
  const generationCheckAt = requiredIndex(encryptInput, 'Rc4PoolLifecycle;->requireCurrent', 'RC4 generation check');
  const encryptCallAt = requiredIndex(encryptInput, '->OooO0oO(Ljava/lang/String;Lo0000oo/o0ooOOo;Z)Ljava/lang/String;', 'current RC4 encryption method');
  assert.ok(poolTakeAt < generationCheckAt && generationCheckAt < encryptCallAt,
    'a stale generation is rejected after lease acquisition and before current-generation encryption');
  assert.match(encryptInput, /if-eqz v8, :slim_rc4_input_success\s+throw v8[\s\S]*?return-object p1/,
    'the encrypted-input transform reports failure instead of returning the original plaintext object');

  const decryptString = await readSmaliMethod(fixtureRoot, rc4Path, 'Lcom/suda/yzune/wakeupschedule/aaa/utils/oOO00O;',
    'public OooO0O0(Ljava/lang/String;)Ljava/lang/String;');
  const encryptString = await readSmaliMethod(fixtureRoot, rc4Path, 'Lcom/suda/yzune/wakeupschedule/aaa/utils/oOO00O;',
    'public OooO0OO(Ljava/lang/String;)Ljava/lang/String;');
  assert.match(decryptString, /throw v6[\s\S]*?return-object p1/,
    'response decryption errors are propagated instead of returning ciphertext as plaintext');
  assert.match(encryptString, /throw v4[\s\S]*?return-object p1/,
    'string encryption errors are propagated instead of returning their source value');

  const patched = await readFile(path.join(fixtureRoot, rc4Path), 'utf8');
  assert.doesNotMatch(patched, /BlockingQueue;->take\(\)Ljava\/lang\/Object;/,
    'all four RC4 borrow paths use bounded queue waits');
  assert.doesNotMatch(patched, /BlockingQueue;->(?:add|offer)\(Ljava\/lang\/Object;\)Z/,
    'all RC4 returns pass through generation-aware lease validation');

  const encryptNet = await readSmaliMethod(fixtureRoot, encryptPath, encryptClass, encryptDescriptor);
  const emptyCheckAt = requiredIndex(encryptNet, nonEmptyDataEdge, 'empty encrypted-data guard');
  const normalReturnAt = requiredIndex(encryptNet.slice(emptyCheckAt), 'return-object p1', 'normal return after empty-data guard') + emptyCheckAt;
  assert.ok(emptyCheckAt < normalReturnAt,
    'an empty encrypted body is rejected before EncryptNet returns a queueable wrapper');
});

test('T30 crypto mutations fail the same method and invoke-edge checks used by preservation audit', async (t) => {
  await mkdir(fixtureCache, { recursive: true });
  const fixtureRoot = await mkdtemp(path.join(fixtureCache, 'network-adapter-t30-crypto-mutations-'));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const rc4Path = 'smali_classes6/com/suda/yzune/wakeupschedule/aaa/utils/oOO00O.smali';
  const encryptPath = 'smali_classes6/com/suda/yzune/wakeupschedule/aaa/utils/EncryptNet.smali';
  for (const relative of [rc4Path, encryptPath]) {
    const target = path.join(fixtureRoot, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(baselineRoot, relative), target);
  }
  const fullSpec = JSON.parse(await readFile('patches/slim-v1/patch-spec.json', 'utf8'));
  const operations = fullSpec.operations.filter((operation) => operation.id.startsWith('T28-E47-')
    || operation.id === 'T28-E16-reject-empty-encrypted-data');
  const specPath = path.join(fixtureRoot, 't30-expected-spec.json');
  await writeFile(specPath, JSON.stringify({ schemaVersion: 1, applicationId: 'io.github.wakeupnoads', operations }, null, 2));
  await applyPatchSpec({ root: fixtureRoot, specPath });

  const mutationPath = path.join(fixtureRoot, 'mutations');
  await mkdir(mutationPath, { recursive: true });
  const mutationCases = [
    {
      id: 'empty-key-bypass',
      path: rc4Path,
      descriptor: 'public OooO0o(Ljava/lang/Object;Z)Ljava/lang/Object;',
      requiredEdge: 'TeachingBootstrap;->requireUsableVersionKey',
      mutate: (source) => source.replace(/    invoke-static \{v0\}, Lcom\/suda\/yzune\/wakeupschedule\/slim\/TeachingBootstrap;->requireUsableVersionKey\(Ljava\/lang\/Object;\)V/, '    nop'),
    },
    {
      id: 'partial-pool-publish',
      path: rc4Path,
      descriptor: 'public OooOO0o()V',
      requiredEdge: 'Rc4PoolLifecycle;->rebuild',
      mutate: (source) => source.replace(/    invoke-static \{p0, v2, v1\}, Lcom\/suda\/yzune\/wakeupschedule\/slim\/Rc4PoolLifecycle;->rebuild\([^\r\n]+/, '    nop'),
    },
    {
      id: 'plaintext-on-encryption-failure',
      path: rc4Path,
      descriptor: 'public OooO0o(Ljava/lang/Object;Z)Ljava/lang/Object;',
      anchor: '    throw v8',
      mutate: (source) => source.replace('    throw v8', '    return-object p1'),
    },
    {
      id: 'empty-encrypted-body',
      path: encryptPath,
      descriptor: 'public final OooO0o0(Lo000oo0O/OooO;)Lcom/suda/yzune/wakeupschedule/aaa/v1/HttpCurrencyRequest$OooO00o;',
      requiredEdge: 'Rc4PoolLifecycle;->requireNonEmptyEncryptedData',
      mutate: (source) => source.replace(/    invoke-static \{p1\}, Lcom\/suda\/yzune\/wakeupschedule\/slim\/Rc4PoolLifecycle;->requireNonEmptyEncryptedData\(Ljava\/lang\/Object;\)V/, '    nop'),
    },
  ];

  for (const mutation of mutationCases) {
    const expected = await readSmaliMethod(fixtureRoot, mutation.path,
      mutation.path === rc4Path ? 'Lcom/suda/yzune/wakeupschedule/aaa/utils/oOO00O;' : 'Lcom/suda/yzune/wakeupschedule/aaa/utils/EncryptNet;',
      mutation.descriptor);
    if (mutation.anchor) assert.equal(occurrenceCount(expected, mutation.anchor), 1, `${mutation.id} mutation anchor is unique`);
    const mutated = mutation.mutate(expected);
    assert.notEqual(mutated, expected, `${mutation.id} fixture changes the selected method`);
    assert.equal(sameExecutableSmaliMethod(expected, mutated), false,
      `${mutation.id} is rejected at ${mutation.path}::${mutation.descriptor}`);
    if (mutation.requiredEdge) {
      assert.equal(hasSmaliInvoke(expected, mutation.requiredEdge), true, `${mutation.id} starts from the reviewed real call edge`);
      assert.equal(hasSmaliInvoke(mutated, mutation.requiredEdge), false, `${mutation.id} removes the targeted call edge`);
      assert.notDeepEqual(smaliInvokeEdges(expected), smaliInvokeEdges(mutated), `${mutation.id} is visible in the invoke-edge inventory`);
    }
    await writeFile(path.join(mutationPath, `${mutation.id}.smali`), mutated, 'utf8');
  }
});

function guardingHandlers(method, call) {
  const lines = method.split(/\r?\n/);
  const at = lines.findIndex((line) => line.includes(call));
  assert.ok(at >= 0, `call site present: ${call}`);
  const labelAt = new Map(lines.flatMap((line, index) => (/^\s*:\w+\s*$/.test(line) ? [[line.trim(), index]] : [])));
  return lines.flatMap((line) => {
    const match = line.match(/^\s*\.catch\s+(\S+)\s+\{(:\w+) \.\. (:\w+)\} (:\w+)/);
    if (!match || !(labelAt.get(match[2]) <= at && at < labelAt.get(match[3]))) return [];
    const start = labelAt.get(match[4]);
    const end = lines.findIndex((candidate, index) => index > start && /^\s*(return|throw|goto)/.test(candidate));
    return [{ type: match[1], handler: lines.slice(start, end + 1).join('\n') }];
  });
}

test('T34 routes crypto and signature failures on worker, cache and callback paths to their original error channels', async (t) => {
  await mkdir(fixtureCache, { recursive: true });
  const fixtureRoot = await mkdtemp(path.join(fixtureCache, 'network-guard-simulation-'));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const fullSpec = JSON.parse(await readFile('patches/slim-v1/patch-spec.json', 'utf8'));
  const guards = fullSpec.operations.filter((operation) => operation.id.startsWith('T34-E57-'));
  assert.equal(guards.length, 12);
  const paths = new Set(guards.map((operation) => operation.relativePath));
  for (const relative of paths) {
    const target = path.join(fixtureRoot, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(baselineRoot, relative), target);
  }
  const specPath = path.join(fixtureRoot, 'network-guard-fixture-spec.json');
  const operations = fullSpec.operations.filter((operation) => paths.has(operation.relativePath));
  await writeFile(specPath, JSON.stringify({ schemaVersion: 1, applicationId: 'io.github.wakeupnoads', operations }, null, 2));
  await applyPatchSpec({ root: fixtureRoot, specPath });

  const report = 'Lcom/suda/yzune/wakeupschedule/slim/TeachingBootstrap;->reportNetworkFailure(Ljava/lang/Object;Ljava/lang/Throwable;)V';
  const net = 'smali_classes3/com/baidu/homework/common/net/';
  const app = 'com/suda/yzune/wakeupschedule/';
  const sign = 'Lcom/baidu/homework/common/net/OooOo00;->OooO(Lo000oo0O/OooO;)Ljava/lang/String;';
  const decrypt = 'Lcom/suda/yzune/wakeupschedule/aaa/utils/oOO00O;->OooO0O0(Ljava/lang/String;)Ljava/lang/String;';
  const cacheRead = 'Lo000o0OO/OooOOO;->OooO0O0(Ljava/lang/Object;)Ljava/lang/Object;';
  const cacheWrite = 'Lo000o0OO/OooOOO;->OooO0Oo(Ljava/lang/Object;Z)Ljava/lang/Object;';
  const cases = [
    ['smali_classes3/com/android/volley/toolbox/OooOO0O.smali', 'Lcom/android/volley/toolbox/OooOO0O;', 'public final OooOO0(Ljava/io/File;)Ljava/io/File;', cacheRead,
      /return-object p1$/],
    [`${net}OooOo00$OooO0OO.smali`, 'Lcom/baidu/homework/common/net/OooOo00$OooO0OO;', 'public OooO0o0()Ljava/lang/String;', sign,
      /Request;->o00OOOo:Lcom\/android\/volley\/o0OoOo0\$OooO00o;[\s\S]*reportNetworkFailure[\s\S]*const\/4 v0, 0x0\s+return-object v0$/],
    ['smali_classes3/o000o0o.3/Oooo000.smali', 'Lo000o0o/Oooo000;', 'public Oooo0()V', sign,
      /Request;->o00OOOo:Lcom\/android\/volley\/o0OoOo0\$OooO00o;[\s\S]*Request;->cancel\(\)V[\s\S]*reportNetworkFailure[\s\S]*goto :goto_0$/],
    ['smali_classes5/o0o00o0.1/OooOO0O.smali', 'Lo0o00o0/OooOO0O;', 'public OooO0O0(Lzyb/okhttp3/oo000o$OooO00o;)Lzyb/okhttp3/Response;',
      'Lcom/zybang/net/v2/OooO0o;->OooO00o(Lzyb/okhttp3/Request;)Lzyb/okhttp3/Request;', /Ljava\/io\/IOException;-><init>\(Ljava\/lang\/Throwable;\)V\s+throw v1$/],
    ['smali_classes3/o000o0o.3/o0OoOo0.smali', 'Lo000o0o/o0OoOo0;', 'public static OooO0Oo(Ljava/lang/Object;Lcom/android/volley/OooO0o$OooO00o;)Lcom/android/volley/o0OoOo0;', cacheRead,
      /VolleyError;-><init>\(Ljava\/lang\/Throwable;\)V[\s\S]*o0OoOo0;->OooO00o\(Lcom\/android\/volley\/VolleyError;\)[\s\S]*return-object p0$/],
    [`${net}OooOo00$OooOOOO$OooO00o.smali`, 'Lcom/baidu/homework/common/net/OooOo00$OooOOOO$OooO00o;', 'public varargs OooO00o([Ljava/lang/Object;)Ljava/lang/Boolean;', cacheWrite,
      /sget-object p1, Ljava\/lang\/Boolean;->FALSE:Ljava\/lang\/Boolean;\s+return-object p1$/],
    [`${net}OooOo00$OooOOOO.smali`, 'Lcom/baidu/homework/common/net/OooOo00$OooOOOO;', 'public static synthetic OooO00o(Lcom/baidu/homework/common/net/OooOo00$OooOOOO;Ljava/lang/Object;)V', cacheWrite,
      /:catch_slim0\s+return-void$/],
    [`smali_classes6/${app}aaa/actions/WakeupHttpRequest$post$1.smali`, `L${app}aaa/actions/WakeupHttpRequest$post$1;`, 'public final invokeSuspend(Ljava/lang/Object;)Ljava/lang/Object;',
      `L${app}aaa/utils/EncryptNet;->OooOOO(Lo000oo0O/OooO;)Lkotlin/Pair;`,
      /instance-of v2, v1, Ljava\/util\/concurrent\/CancellationException;\s+if-nez v2, :cond_slim0[\s\S]*->\$errorListener:[\s\S]*reportNetworkFailure[\s\S]*return-object p1$/],
    [`smali_classes6/${app}aaa/utils/RC4HelperNew$commonDecryptStringAsync$1.smali`, `L${app}aaa/utils/RC4HelperNew$commonDecryptStringAsync$1;`, 'public final invokeSuspend(Ljava/lang/Object;)Ljava/lang/Object;', decrypt,
      /iget-object p1, p0, \S+->\$input:Ljava\/lang\/String;\s+goto :goto_slim0$/],
    [`smali_classes6/${app}schedule_import/DXParserLoginFragment$OooO0O0.smali`, `L${app}schedule_import/DXParserLoginFragment$OooO0O0;`, 'public onResponse(Ljava/lang/String;)V', decrypt,
      /invoke-virtual \{v0, p1\}, Lcom\/baidu\/homework\/common\/net\/OooOo00\$Oooo0;->onResponse\(Ljava\/lang\/Object;\)V\s+(?::goto_0\s+)?return-void$/],
    [`smali_classes6/${app}action/FileDownLoadProcess.smali`, `L${app}action/FileDownLoadProcess;`, 'public onAction(Landroid/app/Activity;Lorg/json/JSONObject;Lcom/baidu/homework/common/ui/widget/HybridWebView$OooOo;)V', decrypt,
      /:catch_slim0\s+return-void$/],
  ];
  for (const [relative, classDescriptor, methodDescriptor, call, handler] of cases) {
    const method = await readSmaliMethod(fixtureRoot, relative, classDescriptor, methodDescriptor);
    const guarding = guardingHandlers(method, call)
      .filter(({ type }) => type === 'Ljava/lang/RuntimeException;' || type === 'Ljava/lang/Exception;');
    assert.equal(guarding.length, 1, `${classDescriptor}${methodDescriptor} guards ${call}`);
    assert.match(guarding[0].handler, handler, `${classDescriptor}${methodDescriptor} hands the failure to its original error channel`);
    if (handler.source.includes('reportNetworkFailure')) assert.ok(hasSmaliInvoke(method, report));
  }
  const post = await readSmaliMethod(fixtureRoot, cases[7][0], cases[7][1], cases[7][2]);
  assert.match(post, /:cond_slim0\s+throw v1/, 'coroutine cancellation is rethrown, not reported');

  const enqueue = await readSmaliMethod(fixtureRoot, `${net}OooOo00$OooO0OO.smali`,
    'Lcom/baidu/homework/common/net/OooOo00$OooO0OO;', 'public OooO0Oo(Ljava/lang/String;)V');
  const skipAt = enqueue.indexOf('if-nez p1, :cond_slim0');
  assert.ok(skipAt >= 0 && skipAt < enqueue.indexOf('Lcom/android/volley/o000oOoO;->OooO00o(Lcom/android/volley/Request;)'),
    'an unsigned async request is never queued');
});
