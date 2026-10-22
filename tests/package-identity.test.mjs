import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { applyPatchSpec } from '../scripts/patch.mjs';
import { DEFAULT_APPLICATION_ID, resolveApplicationId } from '../scripts/version.mjs';
import { readSmaliMethod } from './smali-helpers.mjs';

const repoRoot = path.resolve('.');
const decoded = path.join(repoRoot, 'tools/_cache/slim-v1-decoded');
const fixtureRoot = path.join(repoRoot, 'tools/_cache/slim-v1-review/fixtures');
const specDirRel = 'patches/slim-v1';
const manifestRel = 'AndroidManifest.xml';
const versionRel = 'apktool.yml';
const identitySpecRel = `${specDirRel}/package-identity-spec.json`;
const currentId = DEFAULT_APPLICATION_ID;
const officialId = 'com.suda.yzune.wakeupschedule';

const targets = [
  'smali_classes6/com/suda/yzune/wakeupschedule/ScheduleContentProvider.smali',
  'smali_classes6/com/suda/yzune/wakeupschedule/utils/AppWidgetUtils.smali',
  'smali_classes6/com/suda/yzune/wakeupschedule/today_appwidget/TodayCourseAppWidget.smali',
  'smali_classes6/com/suda/yzune/wakeupschedule/schedule/ScheduleFragment$exportIcsLauncher$1$1$storageUri$1.smali',
  'smali_classes6/com/suda/yzune/wakeupschedule/schedule/ScheduleFragment$exportAsICal$1$uri$1.smali',
];

function attribute(text, name) {
  return text.match(new RegExp(`${name}="([^"]+)"`))?.[1] ?? null;
}

function componentIdentities(xml) {
  return [...xml.matchAll(/<(activity|activity-alias|service|receiver|provider)\b([^>]*?)>/gs)]
    .map((match) => `${match[1]}|${attribute(match[2], 'android:name')}|${attribute(match[2], 'android:targetActivity')}`)
    .sort();
}

function declarations(xml, tagName) {
  const values = [];
  for (const match of xml.matchAll(new RegExp(`<${tagName}\\b([^>]*?)>`, 'gs'))) {
    values.push({ name: attribute(match[1], 'android:name'), protectionLevel: attribute(match[1], 'android:protectionLevel') });
  }
  return values;
}

function ownedPermissionNames(xml, applicationId) {
  const values = new Set();
  for (const match of xml.matchAll(/<(?:permission|uses-permission(?:-sdk-\d+)?)\b([^>]*?)>/gs)) {
    const name = attribute(match[1], 'android:name');
    if (name?.startsWith(`${applicationId}.`)) values.add(name);
  }
  for (const match of xml.matchAll(/<(?:activity|activity-alias|service|receiver|provider)\b([^>]*?)>/gs)) {
    for (const name of ['android:permission', 'android:readPermission', 'android:writePermission']) {
      const value = attribute(match[1], name);
      if (value?.startsWith(`${applicationId}.`)) values.add(value);
    }
  }
  return values;
}

function applyExpectedManifestOperations(original, operations) {
  let result = original;
  for (const operation of operations.filter((item) => item.relativePath === manifestRel)) {
    const count = result.split(operation.expectedOriginal).length - 1;
    assert.equal(count, operation.expectedHits, `reviewed manifest fragment count for ${operation.id}`);
    result = result.replaceAll(operation.expectedOriginal, operation.replacement.replaceAll('{{applicationId}}', currentId));
  }
  return result;
}

async function preparedPatch(t) {
  await mkdir(fixtureRoot, { recursive: true });
  const root = await mkdtemp(path.join(fixtureRoot, 'package-identity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const specDir = path.join(root, specDirRel);
  await mkdir(specDir, { recursive: true });
  const mainSpec = JSON.parse(await readFile(path.join(repoRoot, 'patches/slim-v1/patch-spec.json'), 'utf8'));
  const identitySpec = JSON.parse(await readFile(path.join(repoRoot, identitySpecRel), 'utf8'));
  await writeFile(path.join(specDir, 'package-identity-spec.json'), JSON.stringify(identitySpec));
  for (const relativePath of [manifestRel, versionRel, ...targets]) {
    const target = path.join(root, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(path.join(decoded, relativePath), target);
  }
  const versionOperation = mainSpec.operations.find((operation) => operation.id === 'T22-E01-version-metadata');
  assert.ok(versionOperation);
  const localSpec = {
    schemaVersion: 1,
    applicationId: currentId,
    packageIdentitySpecPath: 'package-identity-spec.json',
    operations: [versionOperation],
  };
  const localSpecPath = path.join(specDir, 'patch-spec.json');
  await writeFile(localSpecPath, JSON.stringify(localSpec));
  const result = await applyPatchSpec({ root, specPath: localSpecPath, applicationId: currentId, versionCode: 543, releaseName: 'wakeup-noads-v6.5.2-r1' });
  return { root, result, identitySpec, mainSpec };
}

test('ApplicationId defaults to the fixed new identity and rejects official or alternate values', () => {
  assert.equal(resolveApplicationId(), 'io.github.wakeupnoads');
  assert.equal(resolveApplicationId(undefined), 'io.github.wakeupnoads');
  for (const value of [officialId, 'io.github.other', '', 'io.github.wakeupnoads.extra']) {
    assert.throws(() => resolveApplicationId(value), /fixed to io\.github\.wakeupnoads/);
  }
});

test('Manifest package, authorities, and owned permissions change only by their reviewed exact operations', async (t) => {
  const fixture = await preparedPatch(t);
  const originalManifest = await readFile(path.join(decoded, manifestRel), 'utf8');
  const outputManifest = await readFile(path.join(fixture.root, manifestRel), 'utf8');
  const expectedManifest = applyExpectedManifestOperations(originalManifest, fixture.identitySpec.operations);
  assert.equal(outputManifest, expectedManifest, 'Manifest contains no unlisted changes');
  const manifestHeader = outputManifest.match(/<manifest\b([^>]*)>/s)?.[1] ?? '';
  assert.equal(attribute(manifestHeader, 'package'), currentId);

  const oldAuthorities = [...originalManifest.matchAll(/android:authorities="([^"]+)"/g)].map((match) => match[1]);
  const newAuthorities = [...outputManifest.matchAll(/android:authorities="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(oldAuthorities.length, 25);
  assert.equal(newAuthorities.length, 25);
  assert.deepEqual(newAuthorities, oldAuthorities.map((value) => value.replace(officialId, currentId)));
  assert.equal(newAuthorities.some((value) => value.startsWith(`${officialId}.`)), false);

  const oldPermissions = ownedPermissionNames(originalManifest, officialId);
  const newPermissions = ownedPermissionNames(outputManifest, currentId);
  assert.equal(oldPermissions.size, 9);
  assert.equal(newPermissions.size, 9);
  assert.equal([...newPermissions].some((value) => oldPermissions.has(value)), false);
  const oldDefinitions = declarations(originalManifest, 'permission').map((item) => ({ ...item, name: item.name.replace(officialId, currentId) })).sort((a, b) => a.name.localeCompare(b.name));
  const newDefinitions = declarations(outputManifest, 'permission').sort((a, b) => a.name.localeCompare(b.name));
  assert.deepEqual(newDefinitions, oldDefinitions, 'owned permission protection levels stay the same');
  assert.doesNotMatch(outputManifest, /android:sharedUserId=/);
  assert.deepEqual(componentIdentities(outputManifest), componentIdentities(originalManifest), 'component classes and alias targets stay unchanged');
});

test('version metadata and local Provider/widget URIs use the new identity without changing paths', async (t) => {
  const fixture = await preparedPatch(t);
  const yaml = await readFile(path.join(fixture.root, versionRel), 'utf8');
  assert.match(yaml, /^  versionCode: 543\s*$/m);
  assert.match(yaml, /^  versionName: wakeup-noads-v6\.5\.2-r1\s*$/m);

  const providerPath = targets[0];
  const providerMatcher = await readSmaliMethod(fixture.root, providerPath, 'Lcom/suda/yzune/wakeupschedule/ScheduleContentProvider;', 'public static final OooO0oo(Lcom/suda/yzune/wakeupschedule/ScheduleContentProvider;)Landroid/content/UriMatcher;');
  assert.match(providerMatcher, /const-string v3, "io\.github\.wakeupnoads\.provider"/);
  for (const route of ['show_table_id', 'table_config/#', 'course_list/#', 'table_list', 'refresh', 'scrollable', 'has_init']) {
    assert.ok(providerMatcher.includes(`"${route}"`), `UriMatcher retains ${route}`);
  }
  const selfCheck = await readSmaliMethod(fixture.root, providerPath, 'Lcom/suda/yzune/wakeupschedule/ScheduleContentProvider;', 'public query(Landroid/net/Uri;[Ljava/lang/String;Ljava/lang/String;[Ljava/lang/String;Ljava/lang/String;)Landroid/database/Cursor;');
  assert.match(selfCheck, /const-string p2, "io\.github\.wakeupnoads"/);
  const widget = targets[1];
  const refresh = await readSmaliMethod(fixture.root, widget, 'Lcom/suda/yzune/wakeupschedule/utils/AppWidgetUtils;', 'public final OooOOO0(Landroid/content/Context;Z)V');
  assert.match(refresh, /content:\/\/io\.github\.wakeupnoads\.provider\/refresh/);
  const configure = await readSmaliMethod(fixture.root, widget, 'Lcom/suda/yzune/wakeupschedule/utils/AppWidgetUtils;', 'public final OooOOoo(Landroid/content/Context;Landroid/appwidget/AppWidgetManager;ILcom/suda/yzune/wakeupschedule/today_appwidget/TodayAppWidgetType;Z)V');
  assert.match(configure, /content:\/\/io\.github\.wakeupnoads\.provider\/show_table_id/);
  assert.match(configure, /content:\/\/io\.github\.wakeupnoads\.provider\/table_config\//);
  const today = await readSmaliMethod(fixture.root, targets[2], 'Lcom/suda/yzune/wakeupschedule/today_appwidget/TodayCourseAppWidget;', 'public OooO00o(Landroid/content/Context;Landroid/appwidget/AppWidgetManager;[I)V');
  assert.match(today, /content:\/\/io\.github\.wakeupnoads\.provider\/has_init/);

  for (const relativePath of targets.slice(3)) {
    assert.equal(await readFile(path.join(fixture.root, relativePath), 'utf8'), await readFile(path.join(decoded, relativePath), 'utf8'), 'runtime FileProvider authority construction remains dynamic and unchanged');
  }
  for (const relativePath of targets) {
    const baseline = await readFile(path.join(decoded, relativePath), 'utf8');
    const actual = await readFile(path.join(fixture.root, relativePath), 'utf8');
    const identityOps = fixture.identitySpec.operations.filter((operation) => operation.relativePath === relativePath);
    let expected = baseline;
    for (const operation of identityOps) expected = expected.replaceAll(operation.expectedOriginal, operation.replacement.replaceAll('{{applicationId}}', currentId));
    assert.equal(actual, expected, `only listed identity instructions change in ${relativePath}`);
  }
});

test('a configured wrong application id is rejected by the patcher before any write', async (t) => {
  const fixture = await preparedPatch(t);
  const before = await readFile(path.join(fixture.root, manifestRel), 'utf8');
  await assert.rejects(applyPatchSpec({ root: fixture.root, specPath: path.join(fixture.root, specDirRel, 'patch-spec.json'), applicationId: 'com.suda.yzune.wakeupschedule' }), /application id mismatch/);
  assert.equal(await readFile(path.join(fixture.root, manifestRel), 'utf8'), before);
});
