import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { applyPatchSpec } from '../scripts/patch.mjs';
import { readSmaliMethod } from './smali-helpers.mjs';

const baseline = path.resolve(process.env.SLIM_BASELINE_DECODED_ROOT ?? 'tools/_cache/slim-v1-decoded');
const fixtures = path.resolve('tools/_cache/slim-v1-review/fixtures/round-2');
const files = [
  'res/layout/import_schedule_popup_window.xml',
  'smali_classes5/o0O0ooOO.9/o00O0OO0.smali',
  'smali_classes6/com/suda/yzune/wakeupschedule/schedule/ScheduleFragment.smali',
  'smali_classes6/com/suda/yzune/wakeupschedule/schedule_import/LoginWebActivity.smali',
];

async function patchedFixture(t) {
  await mkdir(fixtures, { recursive: true });
  const root = await mkdtemp(path.join(fixtures, 'import-routes-simulation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const relative of files) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(baseline, relative), target);
  }
  const fullSpec = JSON.parse(await readFile('patches/slim-v1/patch-spec.json', 'utf8'));
  const operations = fullSpec.operations.filter((operation) => operation.id.startsWith('T08-'));
  assert.equal(operations.length, 5, 'layout, menu binding, route guard, and saved-state restore guard operations are present');
  const specPath = path.join(root, 'import-routes-fixture-spec.json');
  await writeFile(specPath, JSON.stringify({ schemaVersion: 1, applicationId: 'io.github.wakeupnoads', operations }));
  await applyPatchSpec({ root, specPath });
  return root;
}

test('import menu contains only the four retained rows and binds only their listeners', async (t) => {
  const root = await patchedFixture(t);
  const xml = await readFile(path.join(root, files[0]), 'utf8');
  const ids = [...xml.matchAll(/android:id="@id\/([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(ids, ['import_dialog_from_eas', 'import_dialog_from_excel', 'import_dialog_from_html', 'import_dialog_from_backup']);
  const binding = await readSmaliMethod(root, files[1], 'Lo0O0ooOO/o00O0OO0;', 'public OooO0o0()V');
  for (const retained of ['0x7f090381', '0x7f090382', '0x7f090383', '0x7f090380']) assert.match(binding, new RegExp(retained));
  assert.doesNotMatch(binding, /0x7f090384|0x7f09037f/);
});

test('removed share-code and apply IDs return before LoginWebActivity dispatch', async (t) => {
  const root = await patchedFixture(t);
  const route = await readSmaliMethod(root, files[2], 'Lcom/suda/yzune/wakeupschedule/schedule/ScheduleFragment;', 'public static final o00OooOo(Lcom/suda/yzune/wakeupschedule/schedule/ScheduleFragment;Ljava/lang/Integer;)Lkotlin/o0ooOOo;');
  const guard = route.slice(0, route.indexOf('const-class v0, Lcom/suda/yzune/wakeupschedule/schedule_import/LoginWebActivity;'));
  assert.match(guard, /0x7f090384[\s\S]*0x7f09037f[\s\S]*return-object p0/);
  assert.match(route, /0x7f090381[\s\S]*->o00Oo000\(\)V/);
  assert.match(route, /0x7f090382[\s\S]*0x7f090383[\s\S]*0x7f090380/);
});

test('LoginWebActivity saved-state import_type guard is part of the patch set', async () => {
  const spec = JSON.parse(await readFile('patches/slim-v1/patch-spec.json', 'utf8'));
  assert.equal(spec.operations.some((operation) => operation.id.startsWith('T08-E14-')), true);
});

test('code/apply are rejected before Fragment restore for new and saved-state launches', async (t) => {
  const root = await patchedFixture(t);
  const login = await readSmaliMethod(
    root,
    files[3],
    'Lcom/suda/yzune/wakeupschedule/schedule_import/LoginWebActivity;',
    'public onCreate(Landroid/os/Bundle;)V',
  );
  const rejectAt = login.indexOf('\n    :slim_v1_import_removed\n');
  const continueAt = login.indexOf('\n    :slim_v1_import_continue\n');
  const guardedPrefix = login.slice(0, rejectAt);
  const rejectBranch = login.slice(rejectAt, continueAt);
  const baselineLogin = await readSmaliMethod(
    baseline,
    files[3],
    'Lcom/suda/yzune/wakeupschedule/schedule_import/LoginWebActivity;',
    'public onCreate(Landroid/os/Bundle;)V',
  );
  assert.ok(login.indexOf('getStringExtra(Ljava/lang/String;)Ljava/lang/String;') < rejectAt);
  assert.match(guardedPrefix, /const-string v2, "code"[\s\S]*?String;->equals\(Ljava\/lang\/Object;\)Z[\s\S]*?const-string v2, "apply"/);
  assert.match(rejectBranch, /invoke-super \{p0, v0\}, Lcom\/suda\/yzune\/wakeupschedule\/base_view\/BaseActivity;->onCreate\(Landroid\/os\/Bundle;\)V/);
  assert.match(rejectBranch, /Toast;->makeText\(Landroid\/content\/Context;Ljava\/lang\/CharSequence;I\)Landroid\/widget\/Toast;[\s\S]*?Toast;->show\(\)V[\s\S]*?Activity;->finish\(\)V[\s\S]*?return-void/);
  assert.ok(login.indexOf('invoke-super {p0, p1}, Lcom/suda/yzune/wakeupschedule/base_view/BaseActivity;->onCreate(Landroid/os/Bundle;)V') > continueAt);
  assert.ok(login.indexOf('new-instance p1, Lcom/suda/yzune/wakeupschedule/schedule_import/CodeImportFragment;') > continueAt);
  assert.ok(login.indexOf('new-instance p1, Lcom/suda/yzune/wakeupschedule/schedule_import/SchoolInfoFragment;') > continueAt);
  const continueLabel = '\n    :slim_v1_import_continue\n';
  const baselineInstructions = baselineLogin.slice(baselineLogin.indexOf('\n', baselineLogin.indexOf('.locals 6')) + 1);
  assert.equal(login.slice(continueAt + continueLabel.length), baselineInstructions, 'all normal import and VIEW file handling remains byte-for-byte after the guard');
});
