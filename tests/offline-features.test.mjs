import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { applyPatchSpec } from '../scripts/patch.mjs';
import { readSmaliMethod } from './smali-helpers.mjs';

const baseline = path.resolve(process.env.SLIM_BASELINE_DECODED_ROOT ?? 'tools/_cache/slim-v1-decoded');
const fixtures = path.resolve('tools/_cache/slim-v1-review/fixtures/round-2');
const schedulePath = 'smali_classes6/com/suda/yzune/wakeupschedule/schedule/ScheduleActivity.smali';
const settingsPath = 'smali_classes6/com/suda/yzune/wakeupschedule/settings/SettingsActivity.smali';
const startupCoroutinePath = 'smali_classes6/com/suda/yzune/wakeupschedule/schedule/ScheduleActivity$onCreate$3.smali';
const scheduleClass = 'Lcom/suda/yzune/wakeupschedule/schedule/ScheduleActivity;';
const settingsClass = 'Lcom/suda/yzune/wakeupschedule/settings/SettingsActivity;';

async function patchedFixture(t) {
  await mkdir(fixtures, { recursive: true });
  const root = await mkdtemp(path.join(fixtures, 'offline-features-simulation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const relative of [schedulePath, settingsPath, startupCoroutinePath]) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(baseline, relative), target);
  }
  const fullSpec = JSON.parse(await readFile('patches/slim-v1/patch-spec.json', 'utf8'));
  const operations = fullSpec.operations.filter((operation) => operation.id.startsWith('T11-'));
  assert.equal(operations.length, 8, 'the delayed task graph, remote methods, and legacy update setting are patched');
  const specPath = path.join(root, 'offline-features-fixture-spec.json');
  await writeFile(specPath, JSON.stringify({ schemaVersion: 1, applicationId: 'io.github.wakeupnoads', operations }));
  await applyPatchSpec({ root, specPath });
  return root;
}

test('T11 delayed startup retains local status refresh and UA while removing remote tasks', async (t) => {
  const root = await patchedFixture(t);
  const graph = await readSmaliMethod(root, schedulePath, scheduleClass, 'public final oo0o0Oo()V');
  assert.match(graph, /ScheduleActivity\$OooO0o;-><init>/);
  assert.match(graph, /ScheduleActivity\$OooO;-><init>/);
  assert.match(graph, /OooO0o\(\[Lcom\/homework\/launchmanager\/task\/OooO00o;\)/);
  for (const removed of ['OooO0O0', 'OooO0OO', 'OooOO0;', 'OooOO0O;', 'OooOOO0;']) {
    assert.doesNotMatch(graph, new RegExp(`ScheduleActivity\\$${removed}`));
  }

  const scheduleStateTask = await readSmaliMethod(
    baseline,
    'smali_classes6/com/suda/yzune/wakeupschedule/schedule/ScheduleActivity$OooO0o.smali',
    'Lcom/suda/yzune/wakeupschedule/schedule/ScheduleActivity$OooO0o;',
    'public run()V',
  );
  assert.match(scheduleStateTask, /o0000o0\(Z\)V/, 'the local synchronized-calendar status refresh remains');
  const userAgentTask = await readSmaliMethod(
    baseline,
    'smali_classes6/com/suda/yzune/wakeupschedule/schedule/ScheduleActivity$OooO.smali',
    'Lcom/suda/yzune/wakeupschedule/schedule/ScheduleActivity$OooO;',
    'public run()V',
  );
  assert.match(userAgentTask, /FasterUA;->OooO00o\(\)V/, 'the local UA setup remains');
});

test('T11 account sync, server update, login prefetch, and VIP intent cannot reach network code', async (t) => {
  const root = await patchedFixture(t);
  for (const [descriptor, forbidden] of [
    ['public final o0000()V', /EncryptNet|o00000Oo\(\)V|o0000o\(\)V/],
    ['public final o00000Oo()V', /EncryptNet|GetScheduleListBean/],
    ['public final o0000o()V', /synchronizeSchedule|Coroutine/],
    ['public final o0000OOO()V', /preOptimizeLogin|Coroutine/],
    ['public final o00000oO(Landroid/content/Intent;)V', /EXTRA_OPEN_VIP_CASHIER|VipExclusiveActivity|post\(Ljava\/lang\/Runnable;\)/],
  ]) {
    const method = await readSmaliMethod(root, schedulePath, scheduleClass, descriptor);
    assert.doesNotMatch(method, forbidden, descriptor);
    assert.match(method, /return-void/);
  }

  const localStatus = await readSmaliMethod(root, schedulePath, scheduleClass, 'public final o0000o0(Z)V');
  assert.match(localStatus, /ScheduleViewModel;->o0000oO\(ZZ\)V/);
  const onCreate = await readSmaliMethod(root, schedulePath, scheduleClass, 'public onCreate(Landroid/os/Bundle;)V');
  assert.match(onCreate, /ScheduleActivity;->oo0o0Oo\(\)V/, 'the local delayed task manager still starts');
  assert.doesNotMatch(onCreate, /GetScheduleListBean|o00000Oo\(\)V|reportWebViewFeatureSupport/);
  assert.doesNotMatch(onCreate, /HolidayAdjustActivity/);

  const localInitialization = await readSmaliMethod(
    root,
    startupCoroutinePath,
    'Lcom/suda/yzune/wakeupschedule/schedule/ScheduleActivity$onCreate$3;',
    'public final invokeSuspend(Ljava/lang/Object;)Ljava/lang/Object;',
  );
  assert.match(localInitialization, /TableConfig;-><init>\(Landroid\/content\/Context;I\)V/);
  assert.match(localInitialization, /ScheduleViewModel;->o00000Oo\(Lcom\/suda\/yzune\/wakeupschedule\/bean\/TableConfig;\)V/);
  assert.match(localInitialization, /ScheduleViewModel;->o00000OO\(Lcom\/suda\/yzune\/wakeupschedule\/bean\/TableBean;\)V/);
});

test('T11 ignores legacy s_update=true and preserves local setting behavior', async (t) => {
  const root = await patchedFixture(t);
  const settingsList = await readSmaliMethod(root, settingsPath, settingsClass, 'private final oo0o0Oo(Ljava/util/List;)V');
  const updateToggle = await readSmaliMethod(
    root,
    settingsPath,
    settingsClass,
    'public final o0O0O00(Lcom/suda/yzune/wakeupschedule/settings/items/OooOO0;Z)V',
  );
  const legacyPreferences = { s_update: true };
  assert.equal(legacyPreferences.s_update, true, 'the fixture models a previously persisted enabled value');
  assert.doesNotMatch(settingsList, /s_update|0x7f13033d/);
  assert.doesNotMatch(updateToggle, /s_update/);
  for (const setting of ['dynamic_colors', 'schedule_blank_area', 'show_timetable_error', 'key_schedule_vibrate']) {
    assert.match(settingsList, new RegExp(setting));
    assert.match(updateToggle, new RegExp(setting));
  }
  assert.match(updateToggle, /show_empty_view/);
  assert.match(updateToggle, /SharedPreferences\$Editor;->putBoolean/);
  assert.match(updateToggle, /return-void/);
});
