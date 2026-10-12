import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { applyPatchSpec } from '../scripts/patch.mjs';
import { classHierarchy, introducedRegisterErrors, splitSmaliMethods } from './smali-registers.mjs';

const baseline = path.resolve(process.env.SLIM_BASELINE_DECODED_ROOT ?? 'tools/_cache/slim-v1-decoded');
const fixtures = path.resolve('tools/_cache/slim-v1-review/fixtures/round-2');
const specDirectory = path.resolve('patches/slim-v1');
const splashPath = 'smali_classes5/com/suda/yzune/wakeupschedule/SplashActivity.smali';
const netPath = 'smali_classes2/com/baidu/homework/common/net/OooOo00.smali';
const rc4Path = 'smali_classes5/com/suda/yzune/wakeupschedule/aaa/utils/oOO00O.smali';
const encryptNetPath ='smali_classes5/com/suda/yzune/wakeupschedule/aaa/utils/EncryptNet.smali';

async function loadOperations() {
  const spec = JSON.parse(await readFile(path.join(specDirectory, 'patch-spec.json'), 'utf8'));
  const identity = JSON.parse(await readFile(path.join(specDirectory, spec.packageIdentitySpecPath), 'utf8'));
  return [...spec.operations, ...identity.operations];
}

async function fixtureWith(t, relativePaths) {
  await mkdir(fixtures, { recursive: true });
  const root = await mkdtemp(path.join(fixtures, 'smali-registers-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const relative of relativePaths) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(baseline, relative), target);
  }
  return root;
}

async function introducedErrors(root, relativePaths) {
  const hierarchy = classHierarchy([root, baseline]);
  const findings = [];
  for (const relative of relativePaths.filter((value) => value.endsWith('.smali'))) {
    const before = splitSmaliMethods(await readFile(path.join(baseline, relative), 'utf8'));
    for (const [header, body] of splitSmaliMethods(await readFile(path.join(root, relative), 'utf8'))) {
      if (before.get(header) === body) continue;
      for (const error of introducedRegisterErrors(header, before.get(header), body, hierarchy)) findings.push(`${relative} :: ${header} :: ${error}`);
    }
  }
  return findings;
}

test('every patched Smali method keeps register types, invoke arguments and member references verifiable', async (t) => {
  const operations = await loadOperations();
  const relativePaths = [...new Set(operations.map((operation) => operation.relativePath))];
  const root = await fixtureWith(t, relativePaths);
  const result = await applyPatchSpec({ root, specPath: path.join(specDirectory, 'patch-spec.json'), versionCode: 1, releaseName: '0.0.0-r1' });
  assert.equal(result.operations.length, operations.length, 'the full production spec applied to the fixture');
  assert.deepEqual(await introducedErrors(root, relativePaths), []);
});

test('the checker rejects the cold-start mutant that drops the SplashActivity log tag definition', async (t) => {
  const operation = (await loadOperations()).find((candidate) => candidate.id === 'T05-E03-disable-cold-ad-wait');
  assert.ok(operation.replacement.includes('const-string v2, "InitActivity"'), 'the production replacement keeps the tag register defined');
  const root = await fixtureWith(t, [splashPath]);
  const mutant = { ...operation, replacement: '', finalAssertions: operation.finalAssertions.filter((assertion) => !assertion.text.includes('InitActivity')) };
  const specPath = path.join(root, 'register-mutant-spec.json');
  await writeFile(specPath, JSON.stringify({ schemaVersion: 1, applicationId: 'io.github.wakeupnoads', operations: [mutant] }));
  await applyPatchSpec({ root, specPath });
  const findings = await introducedErrors(root, [splashPath]);
  assert.equal(findings.length, 1);
  assert.match(findings[0], /public final o00ooo\(\)V :: undefined v2: invoke-static \{v2, v0\}/);
});

async function mutantErrors(t, id, relativePath, from, to) {
  const operation = (await loadOperations()).find((candidate) => candidate.id === id);
  assert.ok(operation.replacement.includes(from), `${id} carries the verified form`);
  const root = await fixtureWith(t, [relativePath]);
  const mutant = { ...operation, replacement: operation.replacement.replace(from, to), finalAssertions: [] };
  const specPath = path.join(root, 'register-mutant-spec.json');
  await writeFile(specPath, JSON.stringify({ schemaVersion: 1, applicationId: 'io.github.wakeupnoads', operations: [mutant] }));
  await applyPatchSpec({ root, specPath });
  return introducedErrors(root, [relativePath]);
}

test('the checker rejects a queue permit check that overwrites the int register compared after it', async (t) => {
  const findings = await mutantErrors(t, 'T14-E17-consume-permit-before-cache-and-queue', netPath,
    '    move-result-object p3\n    invoke-static {p1, p3}', '    move-result-object v1\n    invoke-static {p1, v1}');
  assert.ok(findings.some((finding) => /if-eq\/ne compares incompatible values: if-ne p3, v1/.test(finding)), findings.join('\n'));
});

test('the checker rejects throwing a register that merges the leased cipher with the caught exception', async (t) => {
  const findings = await mutantErrors(t, 'T28-E47-fail-decrypt-instead-of-returning-input', rc4Path,
    'if-eqz v2, :slim_rc4_decrypt_success\n\n    throw v2', 'if-eqz p2, :slim_rc4_decrypt_success\n\n    throw p2');
  assert.ok(findings.some((finding) => /thrown v\d+ may hold non-Throwable Lo00o0O\/o0OO00O;: throw p2/.test(finding)), findings.join('\n'));
});

test('the checker rejects a key check that overwrites the register holding the pool monitor', async (t) => {
  const findings = await mutantErrors(t, 'T28-E47-OooO0O0-reject-invalid-key', rc4Path,
    'iget-object v1, p0, Lcom/suda/yzune/wakeupschedule/aaa/utils/oOO00O;->OooO0O0:Ljava/lang/String;\n\n    invoke-static {v1}',
    'iget-object v0, p0, Lcom/suda/yzune/wakeupschedule/aaa/utils/oOO00O;->OooO0O0:Ljava/lang/String;\n\n    invoke-static {v0}');
  assert.ok(findings.some((finding) => /monitor-exit v0 no longer holds the locked object: monitor-exit v0/.test(finding)), findings.join('\n'));
});

test('the checker rejects a call to a coroutine launcher descriptor the app does not define', async (t) => {
  const findings = await mutantErrors(t, 'T28-E16-add-dual-callback-entry', encryptNetPath, 'Lkotlin/coroutines/OooOOO;', 'Lkotlinx/coroutines/OooOOO;');
  assert.ok(findings.some((finding) => /unresolved method Lkotlinx\/coroutines\/OooOOO0;->OooO0Oo\(/.test(finding)), findings.join('\n'));
});

