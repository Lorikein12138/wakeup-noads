import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { applyPatchSpec } from '../scripts/patch.mjs';
import { readSmaliMethod } from './smali-helpers.mjs';

const baseline = path.resolve(process.env.SLIM_BASELINE_DECODED_ROOT ?? 'tools/_cache/slim-v1-decoded');
const fixtures = path.resolve('tools/_cache/slim-v1-review/fixtures/round-2');
const files = [
  'res/layout/share_schedule_popup_window.xml',
  'smali_classes6/o0OOOo0.1/o000oOoO.smali',
  'smali_classes6/com/suda/yzune/wakeupschedule/schedule/ScheduleFragment.smali',
];

async function patchedFixture(t) {
  await mkdir(fixtures, { recursive: true });
  const root = await mkdtemp(path.join(fixtures, 'export-routes-simulation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const relative of files) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(baseline, relative), target);
  }
  const fullSpec = JSON.parse(await readFile('patches/slim-v1/patch-spec.json', 'utf8'));
  const operations = fullSpec.operations.filter((operation) => operation.id.startsWith('T09-'));
  assert.equal(operations.length, 3, 'layout, menu binding, and removed-route guard operations are present');
  const specPath = path.join(root, 'export-routes-fixture-spec.json');
  await writeFile(specPath, JSON.stringify({ schemaVersion: 1, applicationId: 'io.github.wakeupnoads', operations }));
  await applyPatchSpec({ root, specPath });
  return root;
}

test('export menu and click binding retain only local iCalendar', async (t) => {
  const root = await patchedFixture(t);
  const xml = await readFile(path.join(root, files[0]), 'utf8');
  assert.deepEqual([...xml.matchAll(/android:id="@id\/([^"]+)"/g)].map((match) => match[1]), ['export_as_cal_file']);
  const binding = await readSmaliMethod(root, files[1], 'Lo0OOOo0/o000oOoO;', 'public OooO0o0()V');
  const boundIds = [...binding.matchAll(/^\s*const\s+v\d+,\s*(0x7f090[0-9a-f]{3})\s*$/gm)].map((match) => match[1]);
  assert.deepEqual(boundIds, ['0x7f090285']);
  assert.ok(binding.indexOf('return-void') > binding.lastIndexOf('setOnClickListener('), 'listeners are bound before the method returns');
  assert.equal((binding.match(/setOnClickListener\(Landroid\/view\/View\$OnClickListener;\)V/g) ?? []).length, 1);
});

test('removed share routes return before online helper or viewmodel calls while iCalendar export remains', async (t) => {
  const root = await patchedFixture(t);
  const route = await readSmaliMethod(root, files[2], 'Lcom/suda/yzune/wakeupschedule/schedule/ScheduleFragment;', 'public static final o00OooO(Lcom/suda/yzune/wakeupschedule/schedule/ScheduleFragment;Landroid/content/Context;Ljava/lang/Integer;)Lo0o0OO0/o000OOo;');
  const continueDefinition = route.indexOf('\n    :slim_removed_route_continue\n');
  assert.ok(continueDefinition >= 0);
  const guard = route.slice(route.indexOf('if-eqz p2, :slim_removed_route_continue'), continueDefinition);
  assert.match(guard, /0x7f090907[\s\S]*0x7f090908[\s\S]*return-object p0/);
  assert.match(guard, /if-eqz p2, :slim_removed_route_continue\s+invoke-virtual \{p2\}, Ljava\/lang\/Integer;->intValue\(\)I/, 'the guard reads the Integer menu id parameter');
  assert.doesNotMatch(guard, /\bp1\b/, 'the guard never treats the Context parameter as the menu id');
  const returnDefinition = route.indexOf('\n    :slim_removed_route_return\n');
  assert.match(route.slice(returnDefinition, continueDefinition), /return-object p0/);
  const continuingRoutes = route.slice(continueDefinition);
  assert.match(continuingRoutes, /0x7f090285[\s\S]*o00OooOo\(Lo0o0OO0\/o000oOoO;\)Ljava\/lang\/String;[\s\S]*o00O0o\(Ljava\/lang\/String;\)V/);
  const onlineShare = route.indexOf('o000O0;->OooOOo(Landroidx/fragment/app/FragmentActivity;)V');
  const onlineRefresh = route.indexOf('ScheduleViewModel;->o0000Ooo(Landroid/content/Context;)Lkotlinx/coroutines/o00O0OOO;');
  assert.ok(onlineShare > continueDefinition && onlineRefresh > continueDefinition,
    'removed online operations remain after the early-return guard for other route inputs');
});
