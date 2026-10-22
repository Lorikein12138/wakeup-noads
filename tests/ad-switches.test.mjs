import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { applyPatchSpec } from '../scripts/patch.mjs';
import { readSmaliMethod } from './smali-helpers.mjs';

const cacheRoot = path.resolve('tools/_cache/slim-v1-decoded');
const fixtureRoot = path.resolve('tools/_cache/slim-v1-review/fixtures');
const e04 = 'smali_classes6/com/suda/yzune/wakeupschedule/aaa/utils/OooOOOO.smali';
const e23 = 'smali_classes6/o0OO0oOo.3/o000oOoO.smali';
const e04Class = 'Lcom/suda/yzune/wakeupschedule/aaa/utils/OooOOOO;';
const e23Class = 'Lo0OO0oOo/o000oOoO;';
const specPath = path.resolve('patches/slim-v1/patch-spec.json');

function assertReturn(body, value, resultType) {
  assert.match(body, new RegExp(`const/4 v0, ${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(body, resultType === 'V' ? /return-void\n\.end method/ : /return v0\n\.end method/);
}

async function assertAdPatches(root) {
  for (const name of ['OooO00o', 'OooO0O0', 'OooO0OO']) {
    const method = await readSmaliMethod(root, e04, e04Class, `public static ${name}()Z`);
    assertReturn(method, '0x0', 'Z');
    assert.doesNotMatch(method, /CommonPreference|OooOO0\(\)Z|OooO0o0\(\)I/);
  }
  const config = await readSmaliMethod(root, e04, e04Class, 'public static OooO0Oo()V');
  assert.match(config, /return-void/);
  assert.doesNotMatch(config, /->Oooo0O0\(/);
  for (const name of ['OooO', 'OooO0o', 'OooO0o0', 'OooO0oO']) {
    assertReturn(await readSmaliMethod(root, e04, e04Class, `public static ${name}()I`), '0x0', 'I');
  }
  assertReturn(await readSmaliMethod(root, e04, e04Class, 'public static OooO0oo()I'), '-0x1', 'I');
  for (const name of ['OooOOO', 'OooOO0', 'OooOOOo', 'OooOOo0', 'OooOOOO']) {
    const method = await readSmaliMethod(root, e23, e23Class, `public static final ${name}()Z`);
    assertReturn(method, '0x0', 'Z');
    assert.doesNotMatch(method, /ABItemBean|invoke-interface/);
  }
  const callback = await readSmaliMethod(root, e23, e23Class, 'public static final OooOo0o(Landroid/content/Context;Lo000o0OO/OooO;)V');
  assert.equal((callback.match(/invoke-interface \{p1, v0\}, Lo000o0OO\/OooO;->OooO00o\(Ljava\/lang\/Object;\)V/g) ?? []).length, 1);
  assert.doesNotMatch(callback, /Lcom\/homework\/abtest\/|Net\.class|OooOOO0\(\)V/);
  const schoolIframe = await readSmaliMethod(root, e23, e23Class, 'public static final OooOO0o(Ljava/lang/String;)Z');
  const baselineIframe = await readSmaliMethod(cacheRoot, e23, e23Class, 'public static final OooOO0o(Ljava/lang/String;)Z');
  assert.equal(schoolIframe, baselineIframe, 'school iframe compatibility method stays unchanged');
}

test('advertising methods return fixed local values and AB completes once without a request', async (t) => {
  await mkdir(fixtureRoot, { recursive: true });
  const tempRoot = await mkdtemp(path.join(fixtureRoot, 'ad-switches-'));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  for (const relativePath of [e04, e23]) {
    const target = path.join(tempRoot, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(path.join(cacheRoot, relativePath), target);
  }
  const spec = JSON.parse(await readFile(specPath, 'utf8'));
  const localSpecPath = path.join(tempRoot, 'patch-spec.json');
  await writeFile(localSpecPath, JSON.stringify({
    schemaVersion: 1,
    applicationId: 'io.github.wakeupnoads',
    operations: spec.operations.filter((operation) => operation.id.startsWith('T04-')),
  }));
  await applyPatchSpec({ root: tempRoot, specPath: localSpecPath });
  await assertAdPatches(tempRoot);

  const signedOutput = process.env.SLIM_DECODED_ROOT;
  if (signedOutput) await assertAdPatches(path.resolve(signedOutput));
});
