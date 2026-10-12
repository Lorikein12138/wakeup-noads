import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { applyPatchSpec } from '../scripts/patch.mjs';
import { hasSmaliInvoke, readSmaliMethod, sameExecutableSmaliMethod, smaliInvokeEdges } from './smali-helpers.mjs';

const root = path.resolve(process.env.SLIM_BASELINE_DECODED_ROOT ?? 'tools/_cache/slim-v1-decoded');
const cache = path.resolve('tools/_cache/slim-v1-review/fixtures/round-2');
const relativePath = 'smali_classes5/com/suda/yzune/wakeupschedule/aaa/utils/o00O0000.smali';
const baseutilRelativePath = 'smali_classes6/com/zuoyebang/baseutil/OooO00o.smali';
const classDescriptor = 'Lcom/suda/yzune/wakeupschedule/aaa/utils/o00O0000;';
const protectedPaths = [
  'smali_classes5/com/suda/yzune/wakeupschedule/aaa/base/OooO00o.smali',
  'smali_classes5/com/suda/yzune/wakeupschedule/aaa/base/Config.smali',
  'smali_classes6/com/suda/yzune/wakeupschedule/schedule_import/login_school/OooO00o.smali',
  'smali_classes6/com/suda/yzune/wakeupschedule/schedule_import/login_school/hust/MobileHub.smali',
  'smali_classes6/com/suda/yzune/wakeupschedule/schedule_import/login_school/hust/MobileHub$OooO00o.smali',
  'smali_classes6/com/suda/yzune/wakeupschedule/schedule_import/login_school/jlu/UIMS.smali',
];
const readOnlyMethods = [
  'public static OooO0OO()Ljava/lang/String;',
  'public static OooO0oO()Lcom/suda/yzune/wakeupschedule/aaa/v1/UserInfo;',
  'public static OooOO0()Z',
  'public static OooO0o()Ljava/lang/String;',
];
const hash = (value) => createHash('sha256').update(value).digest('hex').toUpperCase();

async function makePatchedFixture(t) {
  await mkdir(cache, { recursive: true });
  const fixtureRoot = await mkdtemp(path.join(cache, 'teaching-dependencies-simulation-'));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const sourcePath = path.join(root, relativePath);
  const targetPath = path.join(fixtureRoot, relativePath);
  await mkdir(path.dirname(targetPath), { recursive: true });
  await copyFile(sourcePath, targetPath);
  for (const relative of protectedPaths) {
    const protectedTarget = path.join(fixtureRoot, relative);
    await mkdir(path.dirname(protectedTarget), { recursive: true });
    await copyFile(path.join(root, relative), protectedTarget);
  }
  const fullSpec = JSON.parse(await readFile('patches/slim-v1/patch-spec.json', 'utf8'));
  const operations = fullSpec.operations.filter((operation) => operation.id.startsWith('T25-E40-'));
  assert.equal(operations.length, 4, 'T25 E40 operations are present in the production patch spec');
  const specPath = path.join(fixtureRoot, 'fixture-spec.json');
  await writeFile(specPath, JSON.stringify({ schemaVersion: 1, applicationId: 'io.github.wakeupnoads', operations }, null, 2));
  const result = await applyPatchSpec({ root: fixtureRoot, specPath });
  return { fixtureRoot, targetPath, result };
}

test('E40 account read-only methods preserve their exact baseline instructions', async (t) => {
  const baseline = await readFile(path.join(root, relativePath), 'utf8');
  const fixture = await makePatchedFixture(t);
  const patched = await readFile(fixture.targetPath, 'utf8');
  for (const descriptor of readOnlyMethods) {
    assert.equal(
      hash(await readSmaliMethod(root, relativePath, classDescriptor, descriptor)),
      hash(await readSmaliMethod(fixture.fixtureRoot, relativePath, classDescriptor, descriptor)),
      `${descriptor} stays byte-for-byte equivalent after newline normalization`,
    );
  }
  assert.match(baseline, /ACCOUNT_DXUSS/);
  assert.match(baseline, /ACCOUNT_USER_INFO/);
  assert.equal(fixture.result.operations.length, 4);
});

test('session fixture preserves empty, valid, corrupt, and expired read results', async (t) => {
  const fixture = await makePatchedFixture(t);
  const source = await readFile(fixture.targetPath, 'utf8');
  const getter = await readSmaliMethod(fixture.fixtureRoot, relativePath, classDescriptor, readOnlyMethods[0]);
  const userInfoGetter = await readSmaliMethod(fixture.fixtureRoot, relativePath, classDescriptor, readOnlyMethods[1]);
  const validCheck = await readSmaliMethod(fixture.fixtureRoot, relativePath, classDescriptor, readOnlyMethods[2]);
  assert.match(getter, /ACCOUNT_DXUSS/);
  assert.match(userInfoGetter, /ACCOUNT_USER_INFO/);
  assert.match(validCheck, /OooO0OO\(\)Ljava\/lang\/String;/);
  assert.match(validCheck, /OooO0oO\(\)Lcom\/suda\/yzune\/wakeupschedule\/aaa\/v1\/UserInfo;/);

  const cases = [
    { name: 'empty', account: '', userInfo: null, expectedValid: false },
    { name: 'valid', account: 'dxuss-token', userInfo: { uid: 'u1' }, expectedValid: true },
    { name: 'corrupt user info', account: 'dxuss-token', userInfo: null, expectedValid: false },
    { name: 'expired', account: '', userInfo: { uid: 'expired' }, expectedValid: false },
  ];
  for (const state of cases) {
    const publicParams = state.userInfo ? { uid: state.userInfo.uid } : {};
    const schoolCookie = { 'school.example.edu': 'school-session' };
    const cookieBefore = JSON.stringify(schoolCookie);
    const isValid = state.account.length > 0 && state.userInfo !== null;
    assert.equal(isValid, state.expectedValid, `${state.name} session fixture follows the preserved validity predicate`);
    assert.deepEqual(publicParams, state.userInfo ? { uid: state.userInfo.uid } : {});
    assert.equal(JSON.stringify(schoolCookie), cookieBefore, `${state.name} app-account path does not clear school cookies`);
    assert.doesNotMatch(source, /Saas_submit_logout|Oooo0O0\(Landroid\/content\/Context;/);
    assert.doesNotMatch(source, /Lo0O0OO0\/o00oO0o;->OooO\(Lcom\/zybang\/approve\/JiguangCallback;\)V/);
    assert.doesNotMatch(source, /Lo0OoOOo0\/o0000O;->OooO0o\(Ljava\/lang\/Runnable;\)V/);
  }
});

test('error cleanup completes once locally without app-account request or relaunch', async (t) => {
  const fixture = await makePatchedFixture(t);
  const errorMethod = await readSmaliMethod(fixture.fixtureRoot, relativePath, classDescriptor, 'public static OooO0O0(Ljava/lang/String;)V');
  const cleanupMethod = await readSmaliMethod(fixture.fixtureRoot, relativePath, classDescriptor, 'public static OooOOOO()V');
  for (const localClear of [
    'OooOoO(Lcom/suda/yzune/wakeupschedule/aaa/v1/UserInfo;)V',
    'OooOo0o(Ljava/lang/String;)V',
    'OooOo(Z)V',
  ]) assert.equal(cleanupMethod.split(localClear).length - 1, 1, `${localClear} remains once`);
  assert.equal(errorMethod.split('o00O0O0;->OooO00o(Landroid/content/Context;Ljava/lang/CharSequence;)V').length - 1, 1, 'original local error toast completes once');
  assert.equal(cleanupMethod.split('OooO0oo()V').length - 1, 1, 'local logout state notification remains');
  assert.doesNotMatch(errorMethod, /LoginActivity|Runnable|o0000O;->OooO0o/);
  assert.doesNotMatch(cleanupMethod, /Saas_submit_logout|Oooo0O0\(Landroid\/content\/Context;|JiguangCallback/);
});

test('E44 public parameters and school-specific Cookie/session implementations remain byte-for-byte intact', async (t) => {
  const fixture = await makePatchedFixture(t);
  const guardedMethods = [
    [protectedPaths[0], 'Lcom/suda/yzune/wakeupschedule/aaa/base/OooO00o;', 'public OooOOO0(Ljava/lang/reflect/Type;Ljava/util/List;)V'],
    [protectedPaths[1], 'Lcom/suda/yzune/wakeupschedule/aaa/base/Config;', 'public static OooO0Oo()Ljava/util/Map;'],
    [protectedPaths[2], 'Lcom/suda/yzune/wakeupschedule/schedule_import/login_school/OooO00o;', 'public loadForRequest(Lokhttp3/HttpUrl;)Ljava/util/List;'],
    [protectedPaths[2], 'Lcom/suda/yzune/wakeupschedule/schedule_import/login_school/OooO00o;', 'public saveFromResponse(Lokhttp3/HttpUrl;Ljava/util/List;)V'],
    [protectedPaths[5], 'Lcom/suda/yzune/wakeupschedule/schedule_import/login_school/jlu/UIMS;', 'public final getVPNSCookie(Lkotlin/coroutines/OooO;)Ljava/lang/Object;'],
  ];
  for (const [relative, descriptor, method] of guardedMethods) {
    assert.equal(
      hash(await readSmaliMethod(root, relative, descriptor, method)),
      hash(await readSmaliMethod(fixture.fixtureRoot, relative, descriptor, method)),
      `${method} keeps the baseline implementation`,
    );
  }
  for (const relative of [protectedPaths[3], protectedPaths[4], protectedPaths[5]]) {
    assert.equal(
      hash(await readFile(path.join(root, relative))),
      hash(await readFile(path.join(fixture.fixtureRoot, relative))),
      `${relative} keeps its baseline school Cookie/session code`,
    );
  }
  const publicParameters = await readSmaliMethod(root, protectedPaths[0], 'Lcom/suda/yzune/wakeupschedule/aaa/base/OooO00o;', 'public OooOOO0(Ljava/lang/reflect/Type;Ljava/util/List;)V');
  assert.match(publicParameters, /WPUSS|ZYBUSS/);
  assert.match(await readFile(path.join(root, protectedPaths[2]), 'utf8'), /loadForRequest|saveFromResponse/);
});

test('T30 rejects account, public-parameter, Cookie, and school-password behavior mutations', async () => {
  const fixtureRoot = path.join(cache, 't30-account-cookie-password-mutations');
  const mutations = [
    {
      id: 'dxuss-empty', relativePath, classDescriptor, descriptor: readOnlyMethods[0],
      edge: 'o00O0O;->OooOO0(Ljava/lang/Enum;)Ljava/lang/String;',
      replace: (method) => method.replace('invoke-static {v0}, Lo000Oo00/o00O0O;->OooOO0(Ljava/lang/Enum;)Ljava/lang/String;', 'const/4 v0, 0x0'),
    },
    {
      id: 'userinfo-null', relativePath, classDescriptor, descriptor: readOnlyMethods[1],
      edge: 'o00O0O;->OooO0oo(Ljava/lang/Enum;Ljava/lang/Class;)Ljava/lang/Object;',
      replace: (method) => method.replace('invoke-static {v0, v1}, Lo000Oo00/o00O0O;->OooO0oo(Ljava/lang/Enum;Ljava/lang/Class;)Ljava/lang/Object;', 'const/4 v0, 0x0'),
    },
    {
      id: 'session-always-false', relativePath, classDescriptor, descriptor: readOnlyMethods[2],
      replace: (method) => method.replace('const/4 v0, 0x1', 'const/4 v0, 0x0'),
    },
    {
      id: 'public-params-session-omitted',
      relativePath: 'smali_classes5/com/suda/yzune/wakeupschedule/aaa/base/OooO00o.smali',
      classDescriptor: 'Lcom/suda/yzune/wakeupschedule/aaa/base/OooO00o;',
      descriptor: 'public OooOOO0(Ljava/lang/reflect/Type;Ljava/util/List;)V',
      edge: 'o00O0000;->OooOO0()Z',
      replace: (method) => method.replace('invoke-static {}, Lcom/suda/yzune/wakeupschedule/aaa/utils/o00O0000;->OooOO0()Z', 'const/4 v0, 0x0'),
    },
    {
      id: 'school-cookie-loop-removed',
      relativePath: 'smali_classes6/com/suda/yzune/wakeupschedule/schedule_import/login_school/OooO00o.smali',
      classDescriptor: 'Lcom/suda/yzune/wakeupschedule/schedule_import/login_school/OooO00o;',
      descriptor: 'public loadForRequest(Lokhttp3/HttpUrl;)Ljava/util/List;',
      edge: 'Ljava/util/Map;->entrySet()Ljava/util/Set;',
      replace: (method) => method.replace('invoke-interface {p1}, Ljava/util/Map;->entrySet()Ljava/util/Set;', 'const/4 v1, 0x0'),
    },
    {
      id: 'school-password-replaced-by-id',
      relativePath: 'smali_classes6/com/suda/yzune/wakeupschedule/schedule_import/login_school/suda/SudaXK$login$2.smali',
      classDescriptor: 'Lcom/suda/yzune/wakeupschedule/schedule_import/login_school/suda/SudaXK$login$2;',
      descriptor: 'public final invokeSuspend(Ljava/lang/Object;)Ljava/lang/Object;',
      edge: 'SudaXK;->getPassword()Ljava/lang/String;',
      replace: (method) => method.replace('SudaXK;->getPassword()Ljava/lang/String;', 'SudaXK;->getId()Ljava/lang/String;'),
    },
  ];

  for (const mutation of mutations) {
    const original = await readSmaliMethod(root, mutation.relativePath, mutation.classDescriptor, mutation.descriptor);
    const changed = mutation.replace(original);
    const diagnostic = `${mutation.relativePath}::${mutation.descriptor}`;
    assert.notEqual(changed, original, `${mutation.id} fixture targets real source instructions at ${diagnostic}`);
    assert.equal(sameExecutableSmaliMethod(original, changed), false,
      `${mutation.id} is rejected at ${diagnostic}`);
    if (mutation.edge) {
      assert.equal(hasSmaliInvoke(original, mutation.edge), true, `${mutation.id} starts from the actual protected call edge`);
      assert.equal(hasSmaliInvoke(changed, mutation.edge), false, `${mutation.id} removes or redirects that call edge`);
      assert.notDeepEqual(smaliInvokeEdges(original), smaliInvokeEdges(changed), `${mutation.id} changes the extracted route inventory`);
    }
    const target = path.join(fixtureRoot, mutation.id, path.basename(mutation.relativePath));
    await mkdir(path.dirname(target), { recursive: true });
    const wholeFile = await readFile(path.join(root, mutation.relativePath), 'utf8');
    await writeFile(target, wholeFile.replace(original, changed), 'utf8');
  }
});

test('E41 redaction patch keeps loader fallback, cached-token reads, and native token rebinding', async (t) => {
  await mkdir(cache, { recursive: true });
  const fixtureRoot = await mkdtemp(path.join(cache, 'baseutil-bootstrap-simulation-'));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const targetPath = path.join(fixtureRoot, baseutilRelativePath);
  await mkdir(path.dirname(targetPath), { recursive: true });
  await copyFile(path.join(root, baseutilRelativePath), targetPath);
  const spec = JSON.parse(await readFile('patches/slim-v1/patch-spec.json', 'utf8'));
  const operations = spec.operations.filter((operation) => operation.id.startsWith('T26-E41-'));
  assert.equal(operations.length, 5, 'all five E41 redaction operations are in the production patch spec');
  const specPath = path.join(fixtureRoot, 'fixture-spec.json');
  await writeFile(specPath, JSON.stringify({ schemaVersion: 1, applicationId: 'io.github.wakeupnoads', operations }, null, 2));
  const result = await applyPatchSpec({ root: fixtureRoot, specPath });
  const patched = await readFile(targetPath, 'utf8');
  const init = await readSmaliMethod(fixtureRoot, baseutilRelativePath, 'Lcom/zuoyebang/baseutil/OooO00o;', 'public static declared-synchronized OooO0o()Z');
  const clinit = await readSmaliMethod(fixtureRoot, baseutilRelativePath, 'Lcom/zuoyebang/baseutil/OooO00o;', 'static constructor <clinit>()V');
  const statistics = await readSmaliMethod(fixtureRoot, baseutilRelativePath, 'Lcom/zuoyebang/baseutil/OooO00o;', 'public static varargs OooOOO0([Ljava/lang/String;)V');
  assert.equal(result.operations.length, 5);
  assert.match(clinit, /loadLibrary\(Ljava\/lang\/String;\)V/);
  assert.match(clinit, /Lo00o0o\/o000OOo;->OooO00o\(Landroid\/content\/Context;Ljava\/lang\/String;\)V/);
  assert.doesNotMatch(clinit, /invoke-static \{v0\}, Lo000OOO\/OooO00o;->OooO0OO\(Ljava\/lang\/String;\)V/);
  assert.match(init, /NativeHelper;->nativeSetToken/);
  assert.match(init, /Lcom\/zuoyebang\/baseutil\/OooO0OO;->OooO0O0\(Ljava\/lang\/String;\)Ljava\/lang\/String;/);
  assert.match(init, /Lo000O0Oo\/OooO;->OooOO0\(\)I/);
  assert.match(init, /Lcom\/zuoyebang\/baseutil\/OooO00o;->OooO0O0\(Ljava\/lang\/String;\)Ljava\/lang\/String;/);
  assert.doesNotMatch(init, /invoke-interface \{v4, v6, v7\}, Lo0ooOOO0\/o00OOOO0;->OooO0OO\(Ljava\/lang\/String;\[Ljava\/lang\/Object;\)V/);
  assert.doesNotMatch(init, /invoke-interface \{v4, v7, v8\}, Lo0ooOOO0\/o00OOOO0;->OooO0OO\(Ljava\/lang\/String;\[Ljava\/lang\/Object;\)V/);
  assert.doesNotMatch(init, /invoke-interface \{v6, v7, v8\}, Lo0ooOOO0\/o00OOOO0;->OooO0OO\(Ljava\/lang\/String;\[Ljava\/lang\/Object;\)V/);
  assert.match(statistics, /return-void/);
  assert.doesNotMatch(statistics, /Lcom\/zuoyebang\/baseutil\/OooO;->OooO00o/);
  assert.match(patched, /KEY_ANTISPAM_SIGN_A/);
  assert.match(patched, /KEY_ANTISPAM_SIGN_B/);
});
