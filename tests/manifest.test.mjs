import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { applyPatchSpec } from '../scripts/patch.mjs';

const baseline = path.resolve(process.env.SLIM_BASELINE_DECODED_ROOT ?? 'tools/_cache/slim-v1-decoded');
const fixtures = path.resolve('tools/_cache/slim-v1-review/fixtures/round-2');
const manifestPath = 'AndroidManifest.xml';

function scanComponents(xml) {
  const tokenRe = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<![^>]*>|<\/?[A-Za-z_][\w:.-]*(?:\s[^>]*)?\/?\s*>/g;
  const stack = [];
  const components = [];
  let token;
  while ((token = tokenRe.exec(xml))) {
    const text = token[0];
    if (text.startsWith('<!--') || text.startsWith('<?') || text.startsWith('<!')) continue;
    const closing = text.startsWith('</');
    const tag = text.match(/^<\/?([\w:.-]+)/)?.[1];
    if (!tag) continue;
    if (closing) {
      for (let index = stack.length - 1; index >= 0; index -= 1) {
        const entry = stack.pop();
        if (entry.tag === tag) {
          if (entry.component) entry.component.end = tokenRe.lastIndex;
          break;
        }
      }
      continue;
    }
    const parent = stack.at(-1);
    let component = null;
    if (parent?.tag === 'application' && ['activity', 'activity-alias', 'service', 'receiver', 'provider'].includes(tag)) {
      const name = text.match(/\bandroid:name="([^"]+)"/)?.[1];
      if (name) {
        component = { tag, name, start: token.index, startTag: text, end: null };
        components.push(component);
      }
    }
    if (/\/\s*>$/.test(text)) {
      if (component) component.end = tokenRe.lastIndex;
    } else {
      stack.push({ tag, component });
    }
  }
  return components.map((component) => ({
    ...component,
    block: xml.slice(component.start, component.end),
  }));
}

function ruleMatches(rule, componentName) {
  return rule.names.includes(componentName) || rule.prefixes.some((prefix) => componentName.startsWith(prefix));
}

function androidAttribute(tag, name) {
  return tag.match(new RegExp(`\\bandroid:${name}="([^"]*)"`))?.[1] ?? null;
}

function countIntentFilters(block) {
  return (block.match(/<intent-filter\b/g) ?? []).length;
}

async function patchedFixture(t) {
  await mkdir(fixtures, { recursive: true });
  const root = await mkdtemp(path.join(fixtures, 'manifest-simulation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await copyFile(path.join(baseline, manifestPath), path.join(root, manifestPath));
  const fullSpec = JSON.parse(await readFile('patches/slim-v1/patch-spec.json', 'utf8'));
  const operations = fullSpec.operations.filter((operation) => operation.id.startsWith('T15-E01-'));
  assert.equal(operations.length, 210, 'the source manifest was expanded into exact component operations');
  const specPath = path.join(root, 'manifest-fixture-spec.json');
  await writeFile(specPath, JSON.stringify({ schemaVersion: 1, applicationId: 'io.github.wakeupnoads', operations }));
  await applyPatchSpec({ root, specPath });
  return { root, operations, rules: fullSpec.manifestCloseRules };
}

test('T15 expands every exact Manifest close rule into a counted component allowlist', async (t) => {
  const { operations, rules } = await patchedFixture(t);
  const original = await readFile(path.join(baseline, manifestPath), 'utf8');
  const components = scanComponents(original);
  assert.equal(rules.length, 11);
  const expectedNames = rules.flatMap((rule) => {
    const actualNames = components.filter((component) => ruleMatches(rule, component.name)).map((component) => component.name).sort();
    assert.equal(actualNames.length, rule.expectedHits, rule.id);
    assert.deepEqual(actualNames, rule.expandedNames.slice().sort(), rule.id);
    return actualNames;
  }).sort();
  assert.deepEqual(operations.map((operation) => operation.componentName).sort(), expectedNames);
  assert.equal(new Set(expectedNames).size, expectedNames.length, 'one exact operation is used for each component');
  for (const operation of operations) {
    assert.equal(operation.expectedHits, 1);
    assert.equal(operation.xmlNode.name, operation.componentName);
    assert.match(operation.expectedOriginal, new RegExp(`android:name="${operation.componentName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
    assert.equal(operation.rule.length > 0, true);
  }
});

test('T15 disables only the explicit component list and removes its filters', async (t) => {
  const { root, operations } = await patchedFixture(t);
  const beforeXml = await readFile(path.join(baseline, manifestPath), 'utf8');
  const afterXml = await readFile(path.join(root, manifestPath), 'utf8');
  const before = new Map(scanComponents(beforeXml).map((component) => [component.name, component]));
  const after = new Map(scanComponents(afterXml).map((component) => [component.name, component]));
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), 'all original component nodes remain present');
  const closed = new Set(operations.map((operation) => operation.componentName));
  for (const name of closed) {
    const node = after.get(name);
    assert.ok(node, name);
    assert.equal(androidAttribute(node.startTag, 'enabled'), 'false', name);
    assert.equal(countIntentFilters(node.block), 0, name);
  }
  for (const [name, original] of before) {
    if (!closed.has(name)) assert.equal(after.get(name).block, original.block, `protected component changed: ${name}`);
  }

  const protectedNames = [
    'com.suda.yzune.wakeupschedule.SplashActivity',
    'com.suda.yzune.wakeupschedule.schedule_import.LoginWebActivity',
    'com.suda.yzune.wakeupschedule.schedule_import.SchoolListActivity',
    'com.suda.yzune.wakeupschedule.schedule.ScheduleActivity',
    'com.suda.yzune.wakeupschedule.settings.SettingsActivity',
    'com.suda.yzune.wakeupschedule.settings.HolidayAdjustActivity',
    'com.suda.yzune.wakeupschedule.ScheduleContentProvider',
    'androidx.core.content.FileProvider',
    'com.yanzhenjie.permission.FileProvider',
    'com.suda.yzune.wakeupschedule.receiver.CourseReminderNativeReceiver',
    'com.suda.yzune.wakeupschedule.schedule_appwidget.ScheduleAppWidget',
    'com.suda.yzune.wakeupschedule.today_appwidget.TodayCourseAppWidget',
    'com.zuoyebang.page.activity.BaseCacheHybridActivity',
  ];
  for (const name of protectedNames) {
    assert.ok(before.has(name), `baseline protected node exists: ${name}`);
    assert.equal(after.get(name).block, before.get(name).block, `protected node is unchanged: ${name}`);
  }
  assert.match(after.get('com.suda.yzune.wakeupschedule.SplashActivity').block, /android.intent.action.MAIN/);
  assert.match(after.get('com.suda.yzune.wakeupschedule.SplashActivity').block, /android.intent.category.LAUNCHER/);
  assert.ok(countIntentFilters(after.get('com.suda.yzune.wakeupschedule.schedule_import.LoginWebActivity').block) > 0);
  assert.match(after.get('com.suda.yzune.wakeupschedule.schedule_import.LoginWebActivity').block, /android.intent.action.VIEW/);

  const permissionLines = (xml) => xml.match(/<(?:uses-permission|permission)\b[^>]*\/?\s*>/g) ?? [];
  assert.deepEqual(permissionLines(afterXml), permissionLines(beforeXml), 'permissions and their protection levels are unchanged');
  assert.match(afterXml, /<uses-library android:name="org\.apache\.http\.legacy" android:required="false"\s*\/>/);
  const applicationTag = afterXml.match(/<application\b[^>]*>/)?.[0] ?? '';
  assert.notEqual(androidAttribute(applicationTag, 'debuggable'), 'true');
});
