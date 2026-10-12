import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { applyPatchSpec } from '../scripts/patch.mjs';
import { readSmaliMethod } from './smali-helpers.mjs';

const baseline = path.resolve(process.env.SLIM_BASELINE_DECODED_ROOT ?? 'tools/_cache/slim-v1-decoded');
const fixtures = path.resolve('tools/_cache/slim-v1-review/fixtures/round-2');
const basePath = 'smali_classes5/com/suda/yzune/wakeupschedule/BaseApplication.smali';
const splashPath = 'smali_classes5/com/suda/yzune/wakeupschedule/SplashActivity.smali';
const channelPath = 'smali_classes5/o0O0OoOo.3/o00Ooo.smali';
const baseClass = 'Lcom/suda/yzune/wakeupschedule/BaseApplication;';
const splashClass = 'Lcom/suda/yzune/wakeupschedule/SplashActivity;';
const channelClass = 'Lo0O0OoOo/o00Ooo;';

async function patchedFixture(t) {
  await mkdir(fixtures, { recursive: true });
  const root = await mkdtemp(path.join(fixtures, 'startup-simulation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const relative of [basePath, splashPath, channelPath]) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(baseline, relative), target);
  }
  const fullSpec = JSON.parse(await readFile('patches/slim-v1/patch-spec.json', 'utf8'));
  const operations = fullSpec.operations.filter((operation) =>
    operation.id.startsWith('T05-E02-') || operation.id.startsWith('T05-E03-') ||
    operation.id.startsWith('T05-E05-') || operation.id.startsWith('T05-E24-') ||
    operation.id === 'T26-E39-remove-device-id-startup-task');
  assert.equal(operations.filter((operation) => operation.id.startsWith('T05-E02-')).length, 11);
  assert.equal(operations.filter((operation) => operation.id.startsWith('T05-E03-')).length, 2);
  assert.equal(operations.filter((operation) => operation.id.startsWith('T05-E05-')).length, 2);
  assert.equal(operations.filter((operation) => operation.id.startsWith('T05-E24-')).length, 1);
  assert.equal(operations.filter((operation) => operation.id.startsWith('T26-E39-')).length, 1);
  const specPath = path.join(root, 'startup-fixture-spec.json');
  await (await import('node:fs/promises')).writeFile(specPath, JSON.stringify({ schemaVersion: 1, applicationId: 'io.github.wakeupnoads', operations }));
  await applyPatchSpec({ root, specPath });
  return root;
}

test('E24 startup keeps local reminder and date initialization while cutting the two online initializers', async (t) => {
  const root = await patchedFixture(t);
  const base = await readSmaliMethod(root, basePath, baseClass, 'public OooOOOo()V');
  assert.doesNotMatch(base, /aaa\/utils\/o00O;->OooO00o\(\)V/);
  assert.doesNotMatch(base, /aaa\/utils\/o000oOoO;->OooO00o\(Landroid\/content\/Context;\)V/);
  assert.match(base, /registerReceiver\(Landroid\/content\/BroadcastReceiver;Landroid\/content\/IntentFilter;\)/);
  assert.match(base, /CourseReminderManager;->OooOooO\(Landroid\/content\/Context;\)V/);
  assert.match(base, /AppCompatDelegate;->setDefaultNightMode\(I\)V/);
});

test('E02 startup keeps the seven local tasks and the replacement WebView task with no removed-task dependency', async (t) => {
  const root = await patchedFixture(t);
  const graph = await readSmaliMethod(root, basePath, baseClass, 'public final OooOo()V');
  const retained = [
    'Lo0O0Ooo/o000oOoO;',
    'Lo0O0OoOo/o0OOO0o;',
    'Lo0O0Ooo/o0OoOo0;',
    'Lo0O0OoOo/o00O0O;',
    'Lo0O0OoOo/o00Ooo;',
    'Lo0O0OoOo/OooOo;',
    'Lo0O0OoOo/o0ooOOo;',
    'Lo0O0Ooo0/Oooo0;',
  ];
  const registered = [...graph.matchAll(/new-instance\s+v\d+,\s*(L[^;]+;)/g)]
    .map((match) => match[1])
    .filter((descriptor) => descriptor !== 'Lo0O00Ooo/OooOOO;');
  assert.deepEqual(registered, retained, 'the task graph retains only the reviewed local and teaching prerequisites');
  const taskFiles = [
    'smali_classes5/o0O0Ooo.3/o000oOoO.smali',
    'smali_classes5/o0O0OoOo.3/o0OOO0o.smali',
    'smali_classes5/o0O0Ooo.3/o0OoOo0.smali',
    'smali_classes5/o0O0OoOo.3/o00O0O.smali',
    channelPath,
    'smali_classes5/o0O0OoOo.3/OooOo.smali',
    'smali_classes5/o0O0OoOo.3/o0ooOOo.smali',
    'smali_classes5/o0O0Ooo0.2/Oooo0.smali',
  ];
  const removedDescriptors = [
    'Lo0O0OoOo/o000oOoO;', 'Lo0O0Ooo/oo000o;', 'Lo0O0Ooo/o00Ooo;',
    'Lo0O0OoOo/oo000o;', 'Lo0O0OoOo/o00Oo0;', 'Lo0O0Ooo/Oooo000;',
    'Lo0O0OoOo/Oooo0;', 'Lo0O0Ooo/Oooo0;', 'Lo0O0OoOo/o0OoOo0;',
    'Lo0O0OoOo/OooOo00;', 'Lo0O0OoOo/o00oO0o;', 'Lo0O0Ooo0/Oooo000;',
  ];
  for (const relative of taskFiles) {
    await stat(path.join(baseline, relative));
    const source = await readFile(path.join(baseline, relative), 'utf8');
    for (const descriptor of removedDescriptors) {
      assert.doesNotMatch(source, new RegExp(descriptor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${relative} does not depend on removed ${descriptor}`);
    }
  }
});

test('E03 goes through the existing privacy and local main-page path while forwarding startup parameters', async (t) => {
  const root = await patchedFixture(t);
  const init = await readSmaliMethod(root, splashPath, splashClass, 'public final init()V');
  const launch = await readSmaliMethod(root, splashPath, splashClass, 'public final o00ooo()V');
  const jump = await readSmaliMethod(root, splashPath, splashClass, 'public final o00Ooo(Landroid/app/Activity;)V');
  assert.match(init, /OooOOO0;->OooO00o\(\)V/);
  assert.match(init, /SplashActivity;->o00ooo\(\)V/);
  assert.doesNotMatch(init, /fromPush|ADET_Norequest|reportAppFullLaunch|addTag/);
  assert.doesNotMatch(launch, /aaa\/utils\/OooOOOO;->OooO0OO\(\)Z|SplashActivity\$OooO0OO;|fetchAD|reportAppFullLaunch/);
  assert.match(launch, /SplashActivity;->o00Oo0\(\)V/);
  for (const key of ['fromForm', 'EXTRA_REFRESH_SCHEDULE_SELECTED', 'EXTRA_SCHEDULE_SELECTED_IMPORT_ID', 'courseId', 'startNode', 'startTime', 'action']) {
    assert.ok(jump.includes(`"${key}"`), `startup parameter ${key} remains forwarded`);
  }
  const baselineJump = await readSmaliMethod(baseline, splashPath, splashClass, 'public final o00Ooo(Landroid/app/Activity;)V');
  assert.equal(jump, baselineJump, 'the existing parameter forwarding path is unchanged');
});

test('E05 retains only the schedule reminder channel and removes push subscriptions', async (t) => {
  const root = await patchedFixture(t);
  const createChannels = await readSmaliMethod(root, channelPath, channelClass, 'public final OooOOo(Landroid/content/Context;)V');
  const subscriptions = await readSmaliMethod(root, channelPath, channelClass, 'public final OooOOo0()V');
  assert.match(createChannels, /schedule_reminder/);
  assert.doesNotMatch(createChannels, /"news"/);
  assert.doesNotMatch(subscriptions, /wakeup_subscribe|wakeup_upgrade_subscribe/);
});
