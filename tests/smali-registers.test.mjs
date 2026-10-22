import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { applyPatchSpec } from '../scripts/patch.mjs';
import { classHierarchy, introducedRegisterErrors, splitSmaliMethods } from './smali-registers.mjs';

const baseline = path.resolve(process.env.SLIM_BASELINE_DECODED_ROOT ?? 'tools/_cache/slim-v1-decoded');
const fixtures = path.resolve('tools/_cache/slim-v1-review/fixtures/round-2');
const specDirectory = path.resolve('patches/slim-v1');
const splashPath = 'smali_classes6/com/suda/yzune/wakeupschedule/SplashActivity.smali';
const netPath = 'smali_classes3/com/baidu/homework/common/net/OooOo00.smali';
const rc4Path = 'smali_classes6/com/suda/yzune/wakeupschedule/aaa/utils/oOO00O.smali';
const encryptNetPath = 'smali_classes6/com/suda/yzune/wakeupschedule/aaa/utils/EncryptNet.smali';

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

test('the checker rejects the cold-start integer log-tag mutation at the SplashActivity log call', async (t) => {
  const operation = (await loadOperations()).find((candidate) => candidate.id === 'T05-E03-disable-cold-ad-wait');
  const tagInstruction = 'const-string v3, "InitActivity"';
  assert.equal(operation.replacement.split(tagInstruction).length - 1, 1, 'the production tag instruction is a unique mutation anchor');
  assert.ok(operation.replacement.includes('goto :cond_3'), 'the production replacement retains the cold-start bypass');

  const correctRoot = await fixtureWith(t, [splashPath]);
  const correctSpecPath = path.join(correctRoot, 'register-correct-spec.json');
  await writeFile(correctSpecPath, JSON.stringify({ schemaVersion: 1, applicationId: 'io.github.wakeupnoads', operations: [operation] }));
  await applyPatchSpec({ root: correctRoot, specPath: correctSpecPath });
  assert.deepEqual(await introducedErrors(correctRoot, [splashPath]), [], 'the correct production cold-start fragment has no register findings');

  const root = await fixtureWith(t, [splashPath]);
  const mutatedReplacement = operation.replacement.replace(tagInstruction, 'const/4 v3, 0x1');
  assert.notEqual(mutatedReplacement, operation.replacement, 'the mutation changes the selected instruction');
  assert.equal(mutatedReplacement.replace('const/4 v3, 0x1', tagInstruction), operation.replacement, 'reversing the selected instruction restores the exact production replacement');
  assert.equal((mutatedReplacement.match(/goto :cond_3/g) ?? []).length, (operation.replacement.match(/goto :cond_3/g) ?? []).length, 'the bypass branch is unchanged');
  const mutant = {
    ...operation,
    replacement: mutatedReplacement,
    finalAssertions: operation.finalAssertions.filter((assertion) => assertion.text !== tagInstruction),
  };
  const specPath = path.join(root, 'register-mutant-spec.json');
  await writeFile(specPath, JSON.stringify({ schemaVersion: 1, applicationId: 'io.github.wakeupnoads', operations: [mutant] }));
  await applyPatchSpec({ root, specPath });
  const findings = await introducedErrors(root, [splashPath]);
  assert.equal(findings.length, 1);
  assert.match(findings[0], /public final o00ooo\(\)V/);
  assert.ok(findings[0].includes('v3 is int, expected reference Ljava/lang/String;'), findings[0]);
  assert.ok(findings[0].includes('invoke-static {v3, v0}'), findings[0]);
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

test('the checker rejects throwing the key flag instead of a caught exception', async (t) => {
  const findings = await mutantErrors(t, 'T28-E47-fail-decrypt-instead-of-returning-input', rc4Path,
    'if-eqz v8, :slim_rc4_decrypt_success\n\n    throw v8', 'if-eqz p2, :slim_rc4_decrypt_success\n\n    throw p2');
  assert.ok(findings.some((finding) => /throw p2/.test(finding) && /non-Throwable/.test(finding)), findings.join('\n'));
});

test('the checker rejects a key check that overwrites the register holding the pool monitor', async (t) => {
  const findings = await mutantErrors(t, 'T28-E47-OooO0O0-reject-invalid-key', rc4Path,
    'iget-object v0, v1, Lcom/suda/yzune/wakeupschedule/aaa/utils/oOO00O;->OooO0O0:Ljava/lang/String;\n\n    invoke-static {v0}',
    'iget-object v2, v1, Lcom/suda/yzune/wakeupschedule/aaa/utils/oOO00O;->OooO0O0:Ljava/lang/String;\n\n    invoke-static {v2}');
  assert.ok(findings.some((finding) => /monitor-exit v2 no longer holds the locked object: monitor-exit v2/.test(finding)), findings.join('\n'));
});

test('the checker rejects a call to a coroutine launcher descriptor the app does not define', async (t) => {
  const findings = await mutantErrors(t, 'T28-E16-add-dual-callback-entry', encryptNetPath, 'Lkotlin/coroutines/OooO0o;', 'Lkotlinx/coroutines/OooOOO;');
  assert.ok(findings.some((finding) => /unresolved method Lkotlinx\/coroutines\/OooOOO0;->OooO0Oo\(/.test(finding)), findings.join('\n'));
});

