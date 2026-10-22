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
  'smali_classes6/o0OOOo0.1/Oooo0.smali',
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
  const binding = await readSmaliMethod(root, files[1], 'Lo0OOOo0/Oooo0;', 'public OooO0o0()V');
  const boundIds = [...binding.matchAll(/^\s*const\s+v\d+,\s*(0x7f09038[a-f])\s*$/gm)].map((match) => match[1]);
  assert.deepEqual(boundIds, ['0x7f09038c', '0x7f09038d', '0x7f09038e', '0x7f09038b']);
  assert.ok(binding.indexOf('return-void') > binding.lastIndexOf('setOnClickListener('), 'listeners are bound before the method returns');
  assert.equal((binding.match(/setOnClickListener\(Landroid\/view\/View\$OnClickListener;\)V/g) ?? []).length, 4);
});

test('removed share-code and apply IDs return before LoginWebActivity dispatch', async (t) => {
  const root = await patchedFixture(t);
  const route = await readSmaliMethod(root, files[2], 'Lcom/suda/yzune/wakeupschedule/schedule/ScheduleFragment;', 'public static final o00OoooO(Lcom/suda/yzune/wakeupschedule/schedule/ScheduleFragment;Ljava/lang/Integer;)Lo0o0OO0/o000OOo;');
  const returnDefinition = route.indexOf('\n    :slim_removed_route_return\n');
  const continueDefinition = route.indexOf('\n    :slim_removed_route_continue\n');
  assert.ok(returnDefinition >= 0 && continueDefinition > returnDefinition);
  const guard = route.slice(route.indexOf('if-eqz p1, :slim_removed_route_continue'), continueDefinition);
  assert.match(guard, /invoke-virtual \{p1\}, Ljava\/lang\/Integer;->intValue\(\)I[\s\S]*?0x7f09038f[\s\S]*?if-eq v0, v1, :slim_removed_route_return[\s\S]*?0x7f09038a[\s\S]*?if-eq v0, v1, :slim_removed_route_return[\s\S]*?goto :slim_removed_route_continue/);
  assert.match(route.slice(returnDefinition, continueDefinition), /sget-object p0, Lo0o0OO0\/o000OOo;->OooO00o:Lo0o0OO0\/o000OOo;[\s\S]*?return-object p0/);
  const retainedRoutes = route.slice(continueDefinition);
  assert.match(retainedRoutes, /0x7f09038c[\s\S]*?->o00Oo00o\(\)V/);
  assert.match(retainedRoutes, /0x7f09038d[\s\S]*?o0oo0000;-><init>/);
  assert.match(retainedRoutes, /0x7f09038e[\s\S]*?schedule\/o;-><init>/);
  assert.match(retainedRoutes, /0x7f09038b[\s\S]*?oO00000;-><init>/);
  assert.ok(route.indexOf('const-class v0, Lcom/suda/yzune/wakeupschedule/schedule_import/LoginWebActivity;') > continueDefinition);
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
  const localsAt = baselineLogin.search(/^\s*\.locals\s+\d+\s*$/m);
  assert.ok(localsAt >= 0, 'the current 6.6.0 baseline method declares its locals');
  const baselineInstructions = baselineLogin.slice(baselineLogin.indexOf('\n', localsAt) + 1);
  assert.equal(login.slice(continueAt + continueLabel.length), baselineInstructions, 'all normal import and VIEW file handling remains byte-for-byte after the guard');
});
