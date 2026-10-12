import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { applyPatchSpec } from '../scripts/patch.mjs';
import { hasSmaliInvoke, readSmaliMethod, sameExecutableSmaliMethod, smaliInvokeEdges } from './smali-helpers.mjs';

const baselineRoot = path.resolve(process.env.SLIM_BASELINE_DECODED_ROOT ?? 'tools/_cache/slim-v1-decoded');
const fixtureCache = path.resolve('tools/_cache/slim-v1-review/fixtures/round-2');
const syncPath = 'smali_classes2/com/baidu/homework/common/net/OooOo00.smali';
const transportPath = 'smali_classes5/o0OooO0/o000OOo.smali';

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

  const syncMethod = 'public static OoooO0O(Lo000OO0o/OooO0O0;Ljava/lang/Class;ZZ)Ljava/lang/Object;';
  const sync = await readSmaliMethod(fixtureRoot, syncPath, 'Lcom/baidu/homework/common/net/OooOo00;', syncMethod);
  assert.ok(sync.indexOf('consumeBootstrapChild(Ljava/lang/Object;Ljava/lang/String;)Z') < sync.indexOf(':try_start_0'),
    'the exact bootstrap child is consumed before the synchronous HTTP try/send path');
  assert.ok(sync.indexOf('hasRequestLicense(Ljava/lang/Object;)Z') < sync.indexOf(':try_start_0'),
    'ordinary synchronous input also needs an existing object-bound license');
  assert.match(sync, /bindBootstrapTransport\(Ljava\/lang\/Object;Ljava\/lang\/Object;Ljava\/lang\/String;\)Z/);
  assert.match(sync, /consumeForQueue\(Ljava\/lang\/Object;Ljava\/lang\/String;\)Z/);

  const transport = await readSmaliMethod(
    fixtureRoot, transportPath, 'Lo0OooO0/o000OOo;',
    'public OooO00o(Lcom/android/volley/Request;Ljava/util/Map;)Lorg/apache/http/HttpResponse;',
  );
  assert.match(transport, /hasBootstrapTransport\(Ljava\/lang\/Object;\)Z/);
  assert.match(transport, /claimBootstrapTransport\(Ljava\/lang\/Object;Ljava\/lang\/String;\)Z/);
  assert.match(transport, /const\/4 v2, 0x0[\s\S]*?OooO0oO\(Z\)Lzyb\/okhttp3\/OkHttpClient\$OooO0O0;[\s\S]*?OooO0oo\(Z\)Lzyb\/okhttp3\/OkHttpClient\$OooO0O0;/,
    'only a claimed bootstrap Request disables redirects on its cloned client');
  assert.match(transport, /:slim_bootstrap_normal_redirects[\s\S]*?const\/4 v2, 0x1/,
    'unrelated requests retain the original redirect behavior');
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
  const encryptPath = 'smali_classes5/com/suda/yzune/wakeupschedule/aaa/utils/EncryptNet.smali';
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
    fixtureRoot, encryptPath, 'Lcom/suda/yzune/wakeupschedule/aaa/utils/EncryptNet;',
    'public final OooO0o0(Lo000OO0o/OooO0O0;)Lcom/suda/yzune/wakeupschedule/aaa/v1/HttpCurrencyRequest$OooO00o;',
  );
  assert.ok(encryptedInput.indexOf('move-object v2, p1') < encryptedInput.indexOf('->OooOOO(Lo000OO0o/OooO0O0;)Lkotlin/Pair;'),
    'the original input identity is retained before EncryptNet replaces the parameter register');
  assert.ok(encryptedInput.indexOf('HttpCurrencyRequest$OooO00o;->OooO00o') < encryptedInput.indexOf('SlimNetworkPolicy;->transfer'),
    'the exact new wrapper receives the parent permit after construction');
  assert.ok(encryptedInput.indexOf('SlimNetworkPolicy;->transfer') < encryptedInput.indexOf('return-object p1'),
    'the transferred wrapper is returned only after the identity handoff');

  const asyncQueue = await readSmaliMethod(
    fixtureRoot, netPath, 'Lcom/baidu/homework/common/net/OooOo00;',
    'public static Oooo(Landroid/content/Context;Lo000OO0o/OooO0O0;Ljava/util/List;Ljava/util/List;Ljava/util/List;Lcom/baidu/homework/common/net/OooOo00$Oooo0;Lcom/baidu/homework/common/net/OooOo00$OooOo00;)Lcom/android/volley/Request;',
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
  const downloadReturn = download.indexOf('return-object p0', downloadCancel);
  const downloadQueue = download.indexOf('NetContext;->OooO0O0()Lcom/android/volley/o000oOoO;', downloadReject);
  assert.ok(downloadReject >= 0 && downloadReject < downloadCancel && downloadCancel < downloadReturn && downloadReturn < downloadQueue,
    'the independent download path reports a local error and returns before its Volley queue call');
});

test('T28 guards the real RC4 helper with valid keys, bounded leases, and failure propagation', async (t) => {
  await mkdir(fixtureCache, { recursive: true });
  const fixtureRoot = await mkdtemp(path.join(fixtureCache, 'network-adapter-t28-rc4-simulation-'));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const rc4Path = 'smali_classes5/com/suda/yzune/wakeupschedule/aaa/utils/oOO00O.smali';
  const encryptPath = 'smali_classes5/com/suda/yzune/wakeupschedule/aaa/utils/EncryptNet.smali';
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
    'public OooOO0O()V');
  assert.match(rebuilt, /baseutil\/OooO00o;->OooO0O0\(Ljava\/lang\/String;\)Ljava\/lang\/String;/,
    'pool rebuilding retains the existing versionCode-seeded baseutil key algorithm');
  assert.match(rebuilt, /Rc4PoolLifecycle;->rebuild\(Ljava\/lang\/Object;Ljava\/util\/concurrent\/BlockingQueue;Ljava\/lang\/Object;\)V/);
  assert.match(rebuilt, /:catchall_0[\s\S]*?iput-object v2, p0[\s\S]*?Rc4PoolLifecycle;->invalidate/,
    'a key or constructor exception clears both key state and the current pool generation');
  assert.doesNotMatch(rebuilt, /key: |printStackTrace/,
    'pool creation does not log the raw key or continue after a partial build');

  const encryptInput = await readSmaliMethod(fixtureRoot, rc4Path, 'Lcom/suda/yzune/wakeupschedule/aaa/utils/oOO00O;',
    'public OooO0o0(Ljava/lang/Object;Z)Ljava/lang/Object;');
  assert.ok(encryptInput.indexOf('requireUsableVersionKey') < encryptInput.indexOf('Rc4PoolLifecycle;->take'),
    'an invalid key sentinel stops before borrowing a cipher');
  assert.ok(encryptInput.indexOf('Rc4PoolLifecycle;->requireCurrent') < encryptInput.indexOf('->OooO0o(Ljava/lang/String;'),
    'a stale generation is rejected before encryption');
  assert.match(encryptInput, /if-eqz v5, :slim_rc4_input_success\s+throw v5[\s\S]*?return-object p1/,
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

  const encryptNet = await readSmaliMethod(fixtureRoot, encryptPath, 'Lcom/suda/yzune/wakeupschedule/aaa/utils/EncryptNet;',
    'public final OooO0o0(Lo000OO0o/OooO0O0;)Lcom/suda/yzune/wakeupschedule/aaa/v1/HttpCurrencyRequest$OooO00o;');
  assert.ok(encryptNet.indexOf('requireNonEmptyEncryptedData') >= 0 &&
    encryptNet.indexOf('requireNonEmptyEncryptedData') < encryptNet.indexOf('return-object p1'),
    'an empty encrypted body is rejected before EncryptNet returns a queueable wrapper');
});

test('T30 crypto mutations fail the same method and invoke-edge checks used by preservation audit', async (t) => {
  await mkdir(fixtureCache, { recursive: true });
  const fixtureRoot = await mkdtemp(path.join(fixtureCache, 'network-adapter-t30-crypto-mutations-'));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const rc4Path = 'smali_classes5/com/suda/yzune/wakeupschedule/aaa/utils/oOO00O.smali';
  const encryptPath = 'smali_classes5/com/suda/yzune/wakeupschedule/aaa/utils/EncryptNet.smali';
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
      descriptor: 'public OooO0o0(Ljava/lang/Object;Z)Ljava/lang/Object;',
      requiredEdge: 'TeachingBootstrap;->requireUsableVersionKey',
      mutate: (source) => source.replace(/    invoke-static \{v0\}, Lcom\/suda\/yzune\/wakeupschedule\/slim\/TeachingBootstrap;->requireUsableVersionKey\(Ljava\/lang\/Object;\)V/, '    nop'),
    },
    {
      id: 'partial-pool-publish',
      path: rc4Path,
      descriptor: 'public OooOO0O()V',
      requiredEdge: 'Rc4PoolLifecycle;->rebuild',
      mutate: (source) => source.replace(/    invoke-static \{p0, v2, v1\}, Lcom\/suda\/yzune\/wakeupschedule\/slim\/Rc4PoolLifecycle;->rebuild\([^\r\n]+/, '    nop'),
    },
    {
      id: 'plaintext-on-encryption-failure',
      path: rc4Path,
      descriptor: 'public OooO0o0(Ljava/lang/Object;Z)Ljava/lang/Object;',
      mutate: (source) => source.replace('    throw v5', '    return-object p1'),
    },
    {
      id: 'empty-encrypted-body',
      path: encryptPath,
      descriptor: 'public final OooO0o0(Lo000OO0o/OooO0O0;)Lcom/suda/yzune/wakeupschedule/aaa/v1/HttpCurrencyRequest$OooO00o;',
      requiredEdge: 'Rc4PoolLifecycle;->requireNonEmptyEncryptedData',
      mutate: (source) => source.replace(/    invoke-static \{p1\}, Lcom\/suda\/yzune\/wakeupschedule\/slim\/Rc4PoolLifecycle;->requireNonEmptyEncryptedData\(Ljava\/lang\/Object;\)V/, '    nop'),
    },
  ];

  for (const mutation of mutationCases) {
    const expected = await readSmaliMethod(fixtureRoot, mutation.path,
      mutation.path === rc4Path ? 'Lcom/suda/yzune/wakeupschedule/aaa/utils/oOO00O;' : 'Lcom/suda/yzune/wakeupschedule/aaa/utils/EncryptNet;',
      mutation.descriptor);
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
  const net = 'smali_classes2/com/baidu/homework/common/net/';
  const app = 'com/suda/yzune/wakeupschedule/';
  const sign = 'Lcom/baidu/homework/common/net/OooOo00;->OooO(Lo000OO0o/OooO0O0;)Ljava/lang/String;';
  const decrypt = 'Lcom/suda/yzune/wakeupschedule/aaa/utils/oOO00O;->OooO0O0(Ljava/lang/String;)Ljava/lang/String;';
  const cacheRead = 'Lo000O0Oo/OooOO0;->OooO0O0(Ljava/lang/Object;)Ljava/lang/Object;';
  const cacheWrite = 'Lo000O0Oo/OooOO0;->OooO0Oo(Ljava/lang/Object;Z)Ljava/lang/Object;';
  const cases = [
    ['smali_classes2/com/android/volley/toolbox/OooOO0O.smali', 'Lcom/android/volley/toolbox/OooOO0O;', 'public final OooOO0(Ljava/io/File;)Ljava/io/File;', cacheRead,
      /return-object p1$/],
    [`${net}OooOo00$OooO0OO.smali`, 'Lcom/baidu/homework/common/net/OooOo00$OooO0OO;', 'public OooO0o0()Ljava/lang/String;', sign,
      /->o00OOOO:[\s\S]*reportNetworkFailure[\s\S]*const\/4 v0, 0x0\s+return-object v0$/],
    ['smali_classes2/o000O0o0.1/OooO0o.smali', 'Lo000O0o0/OooO0o;', 'public Oooo0()V', sign,
      /->o00OOOO:[\s\S]*Request;->cancel\(\)V[\s\S]*reportNetworkFailure[\s\S]*goto :goto_0$/],
    ['smali_classes4/o0OoOO00/o00000OO.smali', 'Lo0OoOO00/o00000OO;', 'public OooO00o(Lzyb/okhttp3/oo000o$OooO00o;)Lzyb/okhttp3/Response;',
      'Lcom/zybang/net/v2/OooO0o;->OooO00o(Lzyb/okhttp3/Request;)Lzyb/okhttp3/Request;', /Ljava\/io\/IOException;-><init>\(Ljava\/lang\/Throwable;\)V\s+throw v1$/],
    ['smali_classes2/o000O0o0.1/OooOO0O.smali', 'Lo000O0o0/OooOO0O;', 'public static OooO0Oo(Ljava/lang/Object;Lcom/android/volley/OooO0o$OooO00o;)Lcom/android/volley/o0OoOo0;', cacheRead,
      /VolleyError;-><init>\(Ljava\/lang\/Throwable;\)V[\s\S]*o0OoOo0;->OooO00o\(Lcom\/android\/volley\/VolleyError;\)[\s\S]*return-object p0$/],
    [`${net}OooOo00$OooOOOO$OooO00o.smali`, 'Lcom/baidu/homework/common/net/OooOo00$OooOOOO$OooO00o;', 'public varargs OooO00o([Ljava/lang/Object;)Ljava/lang/Boolean;', cacheWrite,
      /sget-object p1, Ljava\/lang\/Boolean;->FALSE:Ljava\/lang\/Boolean;\s+return-object p1$/],
    [`${net}OooOo00$OooOOOO.smali`, 'Lcom/baidu/homework/common/net/OooOo00$OooOOOO;', 'public final synthetic OooO0Oo(Ljava/lang/Object;)V', cacheWrite,
      /:catch_slim0\s+return-void$/],
    [`smali_classes5/${app}aaa/actions/WakeupHttpRequest$post$1.smali`, `L${app}aaa/actions/WakeupHttpRequest$post$1;`, 'public final invokeSuspend(Ljava/lang/Object;)Ljava/lang/Object;',
      `L${app}aaa/utils/EncryptNet;->OooOOO(Lo000OO0o/OooO0O0;)Lkotlin/Pair;`,
      /instance-of v2, v1, Ljava\/util\/concurrent\/CancellationException;\s+if-nez v2, :cond_slim0[\s\S]*->\$errorListener:[\s\S]*reportNetworkFailure[\s\S]*return-object p1$/],
    [`smali_classes5/${app}aaa/utils/RC4HelperNew$commonDecryptStringAsync$1.smali`, `L${app}aaa/utils/RC4HelperNew$commonDecryptStringAsync$1;`, 'public final invokeSuspend(Ljava/lang/Object;)Ljava/lang/Object;', decrypt,
      /iget-object p1, p0, \S+->\$input:Ljava\/lang\/String;\s+goto :goto_slim0$/],
    [`smali_classes6/${app}schedule_import/DXParserLoginFragment$OooO0O0.smali`, `L${app}schedule_import/DXParserLoginFragment$OooO0O0;`, 'public onResponse(Ljava/lang/String;)V', decrypt,
      /invoke-virtual \{v0, p1\}, Lcom\/baidu\/homework\/common\/net\/OooOo00\$Oooo0;->onResponse\(Ljava\/lang\/Object;\)V\s+(?::goto_0\s+)?return-void$/],
    [`smali_classes5/${app}action/FileDownLoadProcess.smali`, `L${app}action/FileDownLoadProcess;`, 'public onAction(Landroid/app/Activity;Lorg/json/JSONObject;Lcom/baidu/homework/common/ui/widget/HybridWebView$OooOo;)V', decrypt,
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
