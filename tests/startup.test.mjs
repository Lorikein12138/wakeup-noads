import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { applyPatchSpec } from '../scripts/patch.mjs';
import { readSmaliMethod } from './smali-helpers.mjs';

const baseline = path.resolve(process.env.SLIM_BASELINE_DECODED_ROOT ?? 'tools/_cache/slim-v1-decoded');
const fixtures = path.resolve('tools/_cache/slim-v1-review/fixtures/round-2');
const basePath = 'smali_classes6/com/suda/yzune/wakeupschedule/BaseApplication.smali';
const splashPath = 'smali_classes6/com/suda/yzune/wakeupschedule/SplashActivity.smali';
const channelPath = 'smali_classes6/o0OO0o00/OooOOOO.smali';
const baseClass = 'Lcom/suda/yzune/wakeupschedule/BaseApplication;';
const splashClass = 'Lcom/suda/yzune/wakeupschedule/SplashActivity;';
const channelClass = 'Lo0OO0o00/OooOOOO;';
const hotfixPath = 'smali_classes6/o0OO0o00/OooOO0O.smali';
const hotfixClass = 'Lo0OO0o00/OooOO0O;';
const taskFiles = [
  'smali_classes6/o0OO0o0O.1/OooOO0.smali',
  'smali_classes6/o0OO0o00/Oooo0.smali',
  'smali_classes6/o0OO0o0O.1/OooOO0O.smali',
  hotfixPath,
  'smali_classes6/o0OO0o00/OooOOO0.smali',
  channelPath,
  'smali_classes6/o0OO0o00/OooO0O0.smali',
  'smali_classes6/o0OO0o00/Oooo000.smali',
  'smali_classes6/o0OO0o0.1/OooO.smali',
];
const hotfixRemovedDescriptors = [
  'Lo0OO0o0O/OooOo00;',
  'Lo0OO0o0O/OooOOOO;',
  'Lo0OO0o00/OooO0o;',
];
const removedDescriptors = [
  'Lo0OO0o00/OooO;',
  'Lo0OO0o0O/OooOo00;', 'Lo0OO0o0O/OooOOOO;',
  'Lo0OO0o00/OooOo00;', 'Lo0OO0o00/OooOOO;', 'Lo0OO0o0O/OooO0o;',
  'Lo0OO0o00/OooO0o;', 'Lo0OO0o0O/OooO;', 'Lo0OO0o00/OooOO0;',
  'Lo0OO0o00/OooO00o;', 'Lo0OO0o00/OooOo;', 'Lo0OO0o0/OooO0o;',
];

async function assertNoRemovedTaskDependencies(root, descriptors) {
  for (const relative of taskFiles) {
    const source = await readFile(path.join(root, relative), 'utf8');
    for (const descriptor of descriptors) {
      assert.equal(source.includes(descriptor), false, relative + ' retains removed-task dependency ' + descriptor);
    }
  }
}

async function patchedFixture(t, { omitHotfixDependencyOperation = false } = {}) {
  await mkdir(fixtures, { recursive: true });
  const root = await mkdtemp(path.join(fixtures, 'startup-simulation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const relative of new Set([basePath, splashPath, channelPath, ...taskFiles])) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(baseline, relative), target);
  }
  const fullSpec = JSON.parse(await readFile('patches/slim-v1/patch-spec.json', 'utf8'));
  let operations = fullSpec.operations.filter((operation) =>
    operation.id.startsWith('T05-E02-') || operation.id.startsWith('T05-E03-') ||
    operation.id.startsWith('T05-E05-') || operation.id.startsWith('T05-E24-') ||
    operation.id === 'T26-E39-remove-device-id-startup-task');
  if (omitHotfixDependencyOperation) {
    operations = operations.filter((operation) => operation.id !== 'T05-E02-prune-hotfix-task-dependencies');
  }
  assert.equal(operations.filter((operation) => operation.id.startsWith('T05-E02-')).length, omitHotfixDependencyOperation ? 11 : 12);
  assert.equal(operations.filter((operation) => operation.id.startsWith('T05-E03-')).length, 2);
  assert.equal(operations.filter((operation) => operation.id.startsWith('T05-E05-')).length, 2);
  assert.equal(operations.filter((operation) => operation.id.startsWith('T05-E24-')).length, 1);
  assert.equal(operations.filter((operation) => operation.id.startsWith('T26-E39-')).length, 1);
  const specPath = path.join(root, 'startup-fixture-spec.json');
  await writeFile(specPath, JSON.stringify({ schemaVersion: 1, applicationId: 'io.github.wakeupnoads', operations }));
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

test('E02 startup keeps local initialization, WebView, and reminder tasks with no removed-task dependency', async (t) => {
  const root = await patchedFixture(t);
  const graph = await readSmaliMethod(root, basePath, baseClass, 'public final OooOo()V');
  const retained = [
    'Lo0OO0o0O/OooOO0;',
    'Lo0OO0o00/Oooo0;',
    'Lo0OO0o0O/OooOO0O;',
    'Lo0OO0o00/OooOO0O;',
    'Lo0OO0o00/OooOOO0;',
    'Lo0OO0o00/OooOOOO;',
    'Lo0OO0o00/OooO0O0;',
    'Lo0OO0o00/Oooo000;',
    'Lo0OO0o0/OooO;',
  ];
  const registered = [...graph.matchAll(/new-instance\s+v\d+,\s*(L[^;]+;)/g)]
    .map((match) => match[1])
    .filter((descriptor) => descriptor !== 'Lo0O0oO/OooO0o;');
  assert.deepEqual(registered, retained, 'the task graph retains only the reviewed local and teaching prerequisites');
  for (const relative of taskFiles) {
    await stat(path.join(baseline, relative));
    const source = await readFile(path.join(root, relative), 'utf8');
    for (const descriptor of removedDescriptors) {
      assert.doesNotMatch(source, new RegExp(descriptor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${relative} does not depend on removed ${descriptor}`);
    }
  }
  await assertNoRemovedTaskDependencies(root, removedDescriptors);
  const hotfixDependencies = await readSmaliMethod(root, 'smali_classes6/o0OO0o00/OooOO0O.smali', 'Lo0OO0o00/OooOO0O;', 'public OooO00o()Ljava/util/List;');
  assert.equal(hotfixDependencies.match(/const-class v2, Lo0OO0o0O\/OooOO0;/g)?.length, 1);
  assert.equal(hotfixDependencies.match(/filled-new-array \{v2\}, \[Ljava\/lang\/Class;/g)?.length, 1);
  for (const descriptor of hotfixRemovedDescriptors) assert.equal(hotfixDependencies.includes(descriptor), false);
  const originalRun = await readSmaliMethod(baseline, 'smali_classes6/o0OO0o00/OooOO0O.smali', 'Lo0OO0o00/OooOO0O;', 'public run()V');
  const patchedRun = await readSmaliMethod(root, 'smali_classes6/o0OO0o00/OooOO0O.smali', 'Lo0OO0o00/OooOO0O;', 'public run()V');
  assert.equal(patchedRun, originalRun, 'HotFix run() is unchanged from the 6.6.0 baseline');
});

test('E02 rejects the retained HotFix task when the dependency-pruning operation is absent', async (t) => {
  const root = await patchedFixture(t, { omitHotfixDependencyOperation: true });
  const hotfixPath = 'smali_classes6/o0OO0o00/OooOO0O.smali';
  const original = await readSmaliMethod(baseline, hotfixPath, 'Lo0OO0o00/OooOO0O;', 'public OooO00o()Ljava/util/List;');
  for (const descriptor of hotfixRemovedDescriptors) {
    assert.ok(original.includes(descriptor), 'the raw HotFix input still contains ' + descriptor);
    await assert.rejects(assertNoRemovedTaskDependencies(root, [descriptor]), descriptor);
  }
});

test('E03 goes through the existing privacy and local main-page path while forwarding startup parameters', async (t) => {
  const root = await patchedFixture(t);
  const init = await readSmaliMethod(root, splashPath, splashClass, 'public final init()V');
  const launch = await readSmaliMethod(root, splashPath, splashClass, 'public final o00ooo()V');
  const jump = await readSmaliMethod(root, splashPath, splashClass, 'public final o00Ooo(Landroid/app/Activity;)V');
  assert.match(init, /Lo0OO0oO0\/OooO00o;->OooO00o\(\)V/);
  assert.match(init, /o000oOoO;->OooOo0o\(Landroid\/content\/Context;Lo000o0OO\/OooO;\)V/);
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

test('E56 installs the local crash log first in attachBaseContext and leaves the rest of the method unchanged', async (t) => {
  await mkdir(fixtures, { recursive: true });
  const root = await mkdtemp(path.join(fixtures, 'crash-log-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, basePath);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(path.join(baseline, basePath), target);
  const fullSpec = JSON.parse(await readFile('patches/slim-v1/patch-spec.json', 'utf8'));
  const operations = fullSpec.operations.filter((operation) => operation.id.startsWith('T33-E56-'));
  assert.equal(operations.length, 1, 'one exact crash-log install operation is in the production spec');
  const dependencies = JSON.parse(await readFile('patches/slim-v1/teaching-dependencies.json', 'utf8'));
  assert.ok(dependencies.allowedOperationIds.includes('T33-E56-install-crash-log'), 'the protected BaseApplication change is explicitly allowed');
  const specPath = path.join(root, 'crash-log-spec.json');
  await (await import('node:fs/promises')).writeFile(specPath, JSON.stringify({ schemaVersion: 1, applicationId: 'io.github.wakeupnoads', operations }));
  const result = await applyPatchSpec({ root, specPath });
  assert.equal(result.operations.length, 1);
  const descriptor = 'public attachBaseContext(Landroid/content/Context;)V';
  const attach = await readSmaliMethod(root, basePath, baseClass, descriptor);
  const install = attach.indexOf('invoke-static {p1}, Lcom/suda/yzune/wakeupschedule/slim/CrashLog;->install(Ljava/lang/Object;)V');
  const attachSuper = attach.indexOf('invoke-super {p0, p1}, Landroid/content/ContextWrapper;->attachBaseContext(Landroid/content/Context;)V');
  assert.ok(install > 0 && install < attachSuper, 'the crash log is installed with the base context before any other startup work');
  assert.equal(attach.match(/CrashLog;->install/g).length, 1);
  const baselineAttach = await readSmaliMethod(baseline, basePath, baseClass, descriptor);
  assert.equal(attach.replace(/    invoke-static \{p1\}, Lcom\/suda\/yzune\/wakeupschedule\/slim\/CrashLog;->install\(Ljava\/lang\/Object;\)V\r?\n\r?\n/, ''), baselineAttach,
    'only the install call is added');
  const source = await readFile('runtime/src/com/suda/yzune/wakeupschedule/slim/CrashLog.java', 'utf8');
  assert.match(source, /public static void install\(Object context\)/);
  assert.doesNotMatch(source, /java\.net\.|HttpURLConnection|Socket/, 'the crash log never uploads');
});
