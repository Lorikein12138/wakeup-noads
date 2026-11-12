import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { applyPatchSpec } from '../scripts/patch.mjs';
import { parseSmaliClassStructure, sameExecutableSmaliMethod } from './smali-helpers.mjs';

const baseline = path.resolve(process.env.SLIM_BASELINE_DECODED_ROOT ?? 'tools/_cache/slim-v1-decoded');
const fixtures = path.resolve('tools/_cache/slim-v1-review/fixtures/round-2');
const manifestPath = 'AndroidManifest.xml';
const schedulePackage = 'com/suda/yzune/wakeupschedule/schedule';
const schedulePath = `smali_classes6/${schedulePackage}`;
const mainStyleFragment = 'Lcom/suda/yzune/wakeupschedule/schedule_settings/MainStyleFragment;';
const scheduleClassFiles = new Map([
  ...['ScheduleFragment', 'ScheduleFragment$OooO', 'o00'].map((name) => [name, `${schedulePath}/${name}.smali`]),
  ['MainStyleFragment', `smali_classes6/${mainStyleFragment.slice(1, -1)}.smali`],
]);
const scheduleFiles = [...scheduleClassFiles.values()];

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

async function patchedFixture(t, { schedule = false } = {}) {
  await mkdir(fixtures, { recursive: true });
  const root = await mkdtemp(path.join(fixtures, 'manifest-simulation-'));
  assert.ok(root.startsWith(`${fixtures}${path.sep}`), 'fixture stays below tools/_cache');
  t.after(() => rm(root, { recursive: true, force: true }));
  await copyFile(path.join(baseline, manifestPath), path.join(root, manifestPath));
  const fullSpec = JSON.parse(await readFile('patches/slim-v1/patch-spec.json', 'utf8'));
  const operations = fullSpec.operations.filter((operation) =>
    operation.id.startsWith('T15-E01-') && operation.relativePath === manifestPath);
  assert.equal(operations.length, 210, 'the source manifest was expanded into exact component operations');
  if (schedule) {
    for (const file of scheduleFiles) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await copyFile(path.join(baseline, file), path.join(root, file));
    }
    operations.push(...fullSpec.operations.filter(({ relativePath }) => scheduleFiles.includes(relativePath)));
  }
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

test('T15 schedule menu and VIP handlers do not reference closed components in the output', async (t) => {
  const root = process.env.SLIM_VERIFIED_DECODED_ROOT ?? (await patchedFixture(t, { schedule: true })).root;
  const xml = await readFile(path.join(root, manifestPath), 'utf8');
  const closedNames = scanComponents(xml)
    .filter(({ startTag }) => androidAttribute(startTag, 'enabled') === 'false')
    .map(({ name }) => name);
  assert.ok(closedNames.includes('com.suda.yzune.wakeupschedule.aaa.activity.CommonCacheHybridActivity'));

  const classes = new Map();
  const fragment = `L${schedulePackage}/ScheduleFragment;`;
  const bannerClick = `o00O0o00(Lcom/suda/yzune/wakeupschedule/aaa/model/Bannerconf$HomeSourceBanner;${fragment}Landroid/view/View;)Lkotlin/Unit;`;
  for (const [className, file] of scheduleClassFiles) {
    const source = await readFile(path.join(root, file), 'utf8');
    assert.doesNotMatch(source, /vip-wakeup\/page\/cashier|wakeup-core\/page\/pages\/widget\/index/);
    const parsed = parseSmaliClassStructure(source, file);
    classes.set(className, parsed);
    for (const { methodDescriptor, canonicalBody } of parsed.methods) {
      for (const name of closedNames) {
        // This callback needs the remote HomeSourceBanner response, which T14 does not allow.
        if (className === 'ScheduleFragment' && methodDescriptor === bannerClick && name.endsWith('.FullWebTransActivity')) continue;
        const descriptor = `L${name.replaceAll('.', '/')}`;
        assert.ok(!canonicalBody.includes(`${descriptor};`) && !canonicalBody.includes(`${descriptor}$`)
          && !canonicalBody.includes(`"${name}"`), `${className}.${methodDescriptor} references ${name}`);
      }
    }
  }

  const method = (className, descriptor) => {
    const found = classes.get(className).methods.find(({ methodDescriptor }) => methodDescriptor === descriptor);
    assert.ok(found, `${className}.${descriptor} exists`);
    return found;
  };
  const instructions = ({ source }) => source.split('\n')
    .map((line) => line.trim().replace(/\s+#.*$/, ''))
    .filter((line) => line && !line.startsWith('.line ') && !line.startsWith('#')).join('\n');
  const contact = instructions(method('ScheduleFragment', `o00OoO0(${fragment})Lkotlin/Unit;`));
  assert.match(contact, /"https:\/\/www\.wakeup\.fun\/contact\.html"/);
  assert.match(contact, /Landroid\/net\/Uri;->parse\(Ljava\/lang\/String;\)Landroid\/net\/Uri;/);
  assert.match(contact, /"android\.intent\.action\.VIEW"/);
  assert.match(contact, /Landroid\/content\/Intent;-><init>\(Ljava\/lang\/String;Landroid\/net\/Uri;\)V/);
  assert.match(contact, /(:\w+)\ninvoke-virtual .*->startActivity\(Landroid\/content\/Intent;\)V\n(:\w+)\n\.catch Landroid\/content\/ActivityNotFoundException; \{\1 \.\. \2\}/);

  const widget = method('ScheduleFragment', `o0oOO(${fragment})Lkotlin/Unit;`);
  assert.match(widget.canonicalBody, /sget-object v0, Lkotlin\/Unit;->INSTANCE:Lkotlin\/Unit;\nreturn-object v0$/);
  for (const descriptor of [
    `o00oo0o(${fragment}Landroidx/fragment/app/FragmentActivity;Landroid/view/View;)V`,
    'o00o0oOO()V',
    'o00oOOo0()V',
  ]) {
    assert.match(method('ScheduleFragment', descriptor).canonicalBody, /^\.locals 0\nreturn-void$/);
  }
  assert.match(method('ScheduleFragment$OooO', 'OooO0o0()V').canonicalBody, /^\.locals 0\nreturn-void$/);
  // The VIP skin prompt's "去开通" button would otherwise open the closed cashier (from=skin1).
  assert.match(method('MainStyleFragment',
    `o0000o0O(Landroidx/fragment/app/FragmentActivity;${mainStyleFragment}Landroid/view/View;)V`).canonicalBody,
  /^\.locals 0\nreturn-void$/);

  const item = instructions(method('o00', 'OooO0OO(III)Landroid/widget/LinearLayout;'));
  const visibility = item.match(/\n(:\w+)\nconst\/16 v1, 0x8\ninvoke-virtual \{v0, v1\}, Landroid\/view\/View;->setVisibility\(I\)V\n(:\w+)/);
  assert.ok(visibility, 'the menu factory has a GONE branch and a visible branch');
  const [, gone, visible] = visibility;
  assert.ok(item.includes([
    'invoke-virtual {v0, p1}, Landroid/view/View;->setId(I)V',
    'const v1, 0x7f090786',
    `if-eq p1, v1, ${gone}`,
    'const v1, 0x7f090788',
    `if-eq p1, v1, ${gone}`,
    'const v1, 0x7f090789',
    `if-ne p1, v1, ${visible}`,
    gone,
  ].join('\n')), 'only the widget, night mode and simple mode IDs enter the GONE branch');

  // The zero-width, reciprocal chains let ConstraintLayout redistribute each row among visible items.
  // The lifecycle and membership checks still run their upstream branches.
  for (const [className, descriptors] of [
    ['o00', ['<init>(Landroid/content/Context;)V', 'OooOo0(Z)V', 'OooOo00(Z)V']],
    ['ScheduleFragment', ['onResume()V', 'o00O0O0o()V', 'o00O0OO0()V']],
  ]) {
    const file = `${schedulePath}/${className}.smali`;
    const original = parseSmaliClassStructure(await readFile(path.join(baseline, file), 'utf8'), file);
    for (const descriptor of descriptors) {
      const before = original.methods.find(({ methodDescriptor }) => methodDescriptor === descriptor);
      assert.ok(before, `${className}.${descriptor} exists in the baseline`);
      assert.ok(sameExecutableSmaliMethod(method(className, descriptor).source, before.source), `${className}.${descriptor}`);
    }
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
