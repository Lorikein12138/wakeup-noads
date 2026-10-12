import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { applyPatchSpec } from '../scripts/patch.mjs';
import { readSmaliMethod } from './smali-helpers.mjs';

const baseline = path.resolve(process.env.SLIM_BASELINE_DECODED_ROOT ?? 'tools/_cache/slim-v1-decoded');
const fixtures = path.resolve('tools/_cache/slim-v1-review/fixtures/round-2');
const files = [
  'smali_classes5/o0O0Ooo.3/o0OoOo0.smali',
  'smali_classes6/o0OOo0oO.6/o00Oo0.smali',
  'smali_classes6/com/suda/yzune/wakeupschedule/schedule_import/v2/ParserFragment.smali',
  'smali_classes6/com/suda/yzune/wakeupschedule/schedule_import/v2/ParserCacheHybridWebView.smali',
  'smali_classes6/com/suda/yzune/wakeupschedule/schedule_import/DXParserLoginFragment.smali',
  'smali_classes6/com/suda/yzune/wakeupschedule/schedule_import/WebViewLoginFragment.smali',
  'smali_classes2/com/baidu/homework/common/ui/widget/HybridWebView.smali',
  'smali_classes5/com/suda/yzune/wakeupschedule/aaa/utils/EncryptNet.smali',
  'smali_classes6/com/zuoyebang/hybrid/stat/HybridStateObserverManager.smali',
];
const hash = (value) => createHash('sha256').update(value).digest('hex');

async function patchedFixture(t) {
  await mkdir(fixtures, { recursive: true });
  const root = await mkdtemp(path.join(fixtures, 'hybrid-simulation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const relative of files) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(baseline, relative), target);
  }
  const fullSpec = JSON.parse(await readFile('patches/slim-v1/patch-spec.json', 'utf8'));
  const operations = fullSpec.operations.filter((operation) => operation.id.startsWith('T06-E'));
  assert.equal(operations.length, 2, 'the provider observer and combined remote initialization removal are exact operations');
  const specPath = path.join(root, 'hybrid-fixture-spec.json');
  await writeFile(specPath, JSON.stringify({ schemaVersion: 1, applicationId: 'io.github.wakeupnoads', operations }));
  await applyPatchSpec({ root, specPath });
  return root;
}

test('Hybrid keeps local provider registration while removing statistics observer', async (t) => {
  const root = await patchedFixture(t);
  const method = await readSmaliMethod(root, files[0], 'Lo0O0Ooo/o0OoOo0;', 'public final OooOOOo()V');
  assert.match(method, /aaa\/utils\/o00O0O;-><init>\(Landroid\/app\/Application;\)V/);
  assert.match(method, /Lcom\/zuoyebang\/hybrid\/OooO0OO;->OooO0O0\(Lcom\/zuoyebang\/hybrid\/OooO0o;\)V/);
  assert.doesNotMatch(method, /HybridStateObserverManager/);
});

test('Hybrid keeps cache and local plugin initialization without remote module or AB calls', async (t) => {
  const root = await patchedFixture(t);
  const method = await readSmaliMethod(root, files[1], 'Lo0OOo0oO/o00Oo0;', 'public final OooO0Oo()V');
  assert.match(method, /HYBRID_OPEN_CACHE_SWITCH/);
  assert.match(method, /Lcom\/zuoyebang\/common\/OooO00o;->OooO0o\(\)V/);
  assert.match(method, /->OooO0OO\(\)V/);
  assert.doesNotMatch(method, /->Oooo\(Ljava\/lang\/String;\)V|->OooO0O0\(\)V/);
});

test('the three teaching WebActions, ParserCacheHybridWebView, and school CookieManager paths remain unchanged', async (t) => {
  const root = await patchedFixture(t);
  const parserRelative = files[2];
  const parser = await readSmaliMethod(
    root,
    parserRelative,
    'Lcom/suda/yzune/wakeupschedule/schedule_import/v2/ParserFragment;',
    'public final o000OoO(Lcom/suda/yzune/wakeupschedule/schedule_import/v2/ParserCacheHybridWebView;)V',
  );
  for (const action of ['wakeup_scheduleParseFinished', 'wakeup_loadAndExecuteJs', 'wakeup_getLatestRequest']) {
    assert.match(parser, new RegExp(action));
  }
  const cacheView = await readFile(path.join(root, files[3]), 'utf8');
  assert.match(cacheView, /^\.class .*Lcom\/suda\/yzune\/wakeupschedule\/schedule_import\/v2\/ParserCacheHybridWebView;$/m);

  for (const relative of files.slice(2)) {
    const before = await readFile(path.join(baseline, relative));
    const after = await readFile(path.join(root, relative));
    assert.equal(hash(after), hash(before), `${relative} stays byte-for-byte unchanged by the T06 patch`);
  }
  const dx = await readFile(path.join(root, files[4]), 'utf8');
  const legacyWebView = await readFile(path.join(root, files[5]), 'utf8');
  assert.match(dx, /Landroid\/webkit\/CookieManager;->getInstance\(\)Landroid\/webkit\/CookieManager;/);
  assert.match(legacyWebView, /Landroid\/webkit\/CookieManager;->getInstance\(\)Landroid\/webkit\/CookieManager;/);
  for (const [relative, descriptor] of [
    [files[6], 'Lcom/baidu/homework/common/ui/widget/HybridWebView;'],
    [files[7], 'Lcom/suda/yzune/wakeupschedule/aaa/utils/EncryptNet;'],
    [files[8], 'Lcom/zuoyebang/hybrid/stat/HybridStateObserverManager;'],
  ]) {
    const content = await readFile(path.join(root, relative), 'utf8');
    assert.match(content, new RegExp(`^\\.class .*${descriptor.replaceAll('/', '\\/')}$`, 'm'));
  }
});
