import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { applyPatchSpec } from '../scripts/patch.mjs';
import { readSmaliMethod } from './smali-helpers.mjs';

const baseline = path.resolve(process.env.SLIM_BASELINE_DECODED_ROOT ?? 'tools/_cache/slim-v1-decoded');
const fixtures = path.resolve('tools/_cache/slim-v1-review/fixtures/round-2');
const activityPath = 'smali_classes6/com/suda/yzune/wakeupschedule/schedule/ScheduleActivity.smali';
const tabsPath = 'smali_classes6/com/suda/yzune/wakeupschedule/widget/MainAiTitleTabView.smali';
const adapterPath = 'smali_classes5/o0O0OOoo.2/OooOOO.smali';
const switchesPath = 'smali_classes5/o0O0o0O.2/o00oO0o.smali';
const activityClass = 'Lcom/suda/yzune/wakeupschedule/schedule/ScheduleActivity;';
const tabsClass = 'Lcom/suda/yzune/wakeupschedule/widget/MainAiTitleTabView;';
const adapterClass = 'Lo0O0OOoo/OooOOO;';
const switchesClass = 'Lo0O0o0O/o00oO0o;';
const hash = (value) => createHash('sha256').update(value).digest('hex');

async function patchedFixture(t, { joint = false, layout = false } = {}) {
  await mkdir(fixtures, { recursive: true });
  const root = await mkdtemp(path.join(fixtures, 'navigation-simulation-'));
  const fixtureRoot = path.resolve(fixtures);
  assert.ok(root.startsWith(`${fixtureRoot}${path.sep}`), 'temporary fixture stays below tools/_cache');
  t.after(() => rm(root, { recursive: true, force: true }));
  const spec = JSON.parse(await readFile('patches/slim-v1/patch-spec.json', 'utf8'));
  let operations;
  if (joint) {
    operations = spec.operations.filter((operation) =>
      operation.id.startsWith('T04-E23-') || operation.id.startsWith('T07-E05-') || operation.id.startsWith('T11-E06-')
      || operation.id === 'T34-E05-hide-calendar-tab'
      || (layout && operation.id.startsWith('T34-E05-pager-')));
  } else {
    operations = spec.operations.filter((operation) => operation.id.startsWith('T07-E05-') || operation.id === 'T34-E05-hide-calendar-tab');
  }
  if (!joint) {
    assert.equal(operations.length, 7, 'ordinary mode selects the six retained T07 operations and the hide-calendar operation');
    assert.equal(operations.some((operation) => operation.id === 'T34-E05-hide-calendar-tab'), true);
    assert.equal(operations.some((operation) => operation.id === 'T07-E05-enable-local-calendar-tab'), false);
  }
  const targets = new Set(operations.map((operation) => operation.relativePath));
  if (!joint) for (const relative of [tabsPath, adapterPath]) targets.add(relative);
  for (const relative of targets) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(baseline, relative), target);
  }
  const specPath = path.join(root, 'navigation-fixture-spec.json');
  await writeFile(specPath, JSON.stringify({ schemaVersion: 1, applicationId: 'io.github.wakeupnoads', operations }));
  await applyPatchSpec({ root, specPath });
  return root;
}

function decodedSmaliString(value) {
  try { return JSON.parse(value); }
  catch { return value.slice(1, -1); }
}

function pagerMethodBlock(source, descriptor) {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `.method ${descriptor}`);
  assert.notEqual(start, -1, `production method exists: ${descriptor}`);
  const end = lines.findIndex((line, index) => index > start && line.trim() === '.end method');
  assert.notEqual(end, -1, `production method closes: ${descriptor}`);
  return lines.slice(start, end + 1).join('\n');
}

function pagerParseMethod(source, descriptor) {
  const block = pagerMethodBlock(source, descriptor);
  const localCount = Number(block.match(/^\s*\.locals\s+(\d+)/m)?.[1]);
  const instructions = [];
  const labels = new Map();
  for (const raw of block.split('\n').slice(1, -1)) {
    const line = raw.trim();
    if (!line || line.startsWith('.line ') || line.startsWith('.locals ')) continue;
    if (line.startsWith(':')) { labels.set(line, instructions.length); continue; }
    instructions.push(line);
  }
  return { descriptor, localCount, instructions, labels };
}

function pagerRegisterIndex(name, localCount) {
  if (name[0] === 'v') return Number(name.slice(1));
  if (name[0] === 'p') return localCount + Number(name.slice(1));
  throw new Error(`unsupported production pager register ${name}`);
}

function pagerExecuteMethod(source, descriptor, args, world) {
  const method = pagerParseMethod(source, descriptor);
  const registers = Array(method.localCount + args.length + 2).fill(null);
  args.forEach((value, index) => { registers[method.localCount + index] = value; });
  const previousRegisters = world.registers;
  const previousLocalCount = world.localCount;
  world.registers = registers;
  world.localCount = method.localCount;
  const read = (name) => /^[vp]\d+$/.test(name)
    ? registers[pagerRegisterIndex(name, method.localCount)]
    : name.startsWith('-0x') ? -Number.parseInt(name.slice(3), 16) : name.startsWith('0x') ? Number.parseInt(name.slice(2), 16) : Number(name);
  const write = (name, value) => { registers[pagerRegisterIndex(name, method.localCount)] = value; };
  const invoke = (instruction) => {
    const match = /^(invoke-(?:virtual|direct|interface))\s+\{([^}]*)\},\s+(.+);->([^ (]+)(\(.*)$/.exec(instruction);
    if (!match) throw new Error(`unsupported production pager invocation: ${instruction}`);
    const kind = match[1];
    const receiverAndArgs = match[2].split(',').map((item) => item.trim()).filter(Boolean).map(read);
    const owner = `${match[3]};`;
    const name = match[4];
    const descriptorText = match[5];
    if (owner === activityClass && (name === 'o00000OO' || name === 'o00000O')) return name === 'o00000OO' ? world.pager : world.tab;
    if (owner === activityClass && ['slimInstallPagerBounds', 'slimSyncPagerBounds', 'slimRemovePagerBounds'].includes(name)) {
      const targetDescriptor = `private ${name}()V`;
      return pagerExecuteMethod(source, targetDescriptor, receiverAndArgs, world);
    }
    const view = receiverAndArgs[0];
    if (name === 'getParent') return view.parent;
    if (name === 'getHeight') return view.height;
    if (name === 'getPaddingBottom') return view.paddingBottom;
    if (name === 'getTop') return view.top;
    if (name === 'getVisibility') return view.visibility;
    if (name === 'getLayoutParams') return view.layoutParams;
    if (name === 'setLayoutParams') {
      view.layoutParams = receiverAndArgs[1];
      view.setLayoutParamsCalls += 1;
      return undefined;
    }
    if (name === 'addOnLayoutChangeListener') {
      view.listeners.push(receiverAndArgs[1]);
      return undefined;
    }
    if (name === 'removeOnLayoutChangeListener') {
      view.listeners = view.listeners.filter((listener) => listener !== receiverAndArgs[1]);
      return undefined;
    }
    if (kind === 'invoke-direct' && owner === activityClass && name === 'slimSyncPagerBounds') {
      return pagerExecuteMethod(source, 'private slimSyncPagerBounds()V', receiverAndArgs, world);
    }
    throw new Error(`unsupported production pager call ${kind} ${owner}->${name}${descriptorText}`);
  };
  try {
    let pc = 0;
    let steps = 0;
    let lastResult;
    while (pc < method.instructions.length) {
      if (++steps > 1000) throw new Error(`production pager method exceeded instruction bound: ${descriptor}`);
      const instruction = method.instructions[pc];
      const op = instruction.split(/\s+/)[0];
      const tail = instruction.slice(op.length).trim();
      const parts = tail.split(',').map((item) => item.trim());
      let jump = null;
      if (/^const(?:\/4|\/16)?$/.test(op)) write(parts[0], read(parts[1]));
      else if (op === 'move' || op === 'move-object') write(parts[0], read(parts[1]));
      else if (op === 'move-result' || op === 'move-result-object') { write(parts[0], lastResult); lastResult = undefined; }
      else if (op === 'invoke-virtual' || op === 'invoke-direct' || op === 'invoke-interface') lastResult = invoke(instruction);
      else if (op === 'instance-of') {
        const value = read(parts[1]);
        const isFrame = parts[2] === 'Landroid/widget/FrameLayout;' && value?.kind === 'FrameLayout';
        const isFrameLayoutParams = parts[2] === 'Landroid/widget/FrameLayout$LayoutParams;' && value?.kind === 'FrameLayout$LayoutParams';
        write(parts[0], isFrame || isFrameLayoutParams);
      }
      else if (op === 'check-cast') { /* reference-preserving cast */ }
      else if (op === 'if-eqz' || op === 'if-nez') {
        const value = read(parts[0]);
        const zero = value === null || value === undefined || value === false || value === 0;
        if (op === 'if-eqz' ? zero : !zero) jump = parts[1];
      } else if (op === 'if-ne') { if (read(parts[0]) !== read(parts[1])) jump = parts[2]; }
      else if (op === 'if-ltz') { if (read(parts[0]) < 0) jump = parts[1]; }
      else if (op === 'if-lez') { if (read(parts[0]) <= 0) jump = parts[1]; }
      else if (op === 'if-gt') { if (read(parts[0]) > read(parts[1])) jump = parts[2]; }
      else if (op === 'if-gez') { if (read(parts[0]) >= 0) jump = parts[1]; }
      else if (op === 'goto') jump = tail;
      else if (op === 'sub-int/2addr') write(parts[0], read(parts[0]) - read(parts[1]));
      else if (op === 'sub-int') write(parts[0], read(parts[1]) - read(parts[2]));
      else if (op === 'iget') {
        const field = /;->([^:]+):/.exec(parts[2])?.[1];
        if (!field) throw new Error(`invalid pager field read ${instruction}`);
        write(parts[0], read(parts[1])[field]);
      } else if (op === 'iput') {
        const field = /;->([^:]+):/.exec(parts[2])?.[1];
        if (!field) throw new Error(`invalid pager field write ${instruction}`);
        read(parts[1])[field] = read(parts[0]);
      } else if (op === 'return-void') return undefined;
      else throw new Error(`unsupported production pager instruction ${descriptor}: ${instruction}`);
      if (jump) {
        assert.ok(method.labels.has(jump), `production branch target exists: ${jump}`);
        pc = method.labels.get(jump);
      } else pc += 1;
    }
    return undefined;
  } finally {
    world.registers = previousRegisters;
    world.localCount = previousLocalCount;
  }
}

function extractTabAdditions(onCreate) {
  const types = new Map();
  const strings = new Map();
  const tabs = new Map();
  const added = [];
  let skipUntil = null;
  for (const line of onCreate.split(/\r?\n/)) {
    const instruction = line.trim();
    if (skipUntil) {
      if (instruction === skipUntil) skipUntil = null;
      else continue;
    }
    const unconditionalJump = instruction.match(/^goto(?:\/\w+)?\s+(:\w+)$/);
    if (unconditionalJump) { skipUntil = unconditionalJump[1]; continue; }
    let match = line.match(/^\s*new-instance\s+(\w+),\s*(\S+)/);
    if (match) { types.set(match[1], match[2]); strings.delete(match[1]); continue; }
    match = line.match(/^\s*const-string\s+(\w+),\s*(".*")\s*$/);
    if (match) { strings.set(match[1], decodedSmaliString(match[2])); types.delete(match[1]); continue; }
    match = line.match(/^\s*invoke-direct\s+\{([^}]+)\},\s*Lo0O0OOoo\/OooOOOO;-><init>/);
    if (match) {
      const registers = match[1].split(',').map((value) => value.trim());
      const objectRegister = registers[0];
      const stringArgs = registers.slice(1).filter((register) => strings.has(register));
      const fragmentRegister = registers.slice(1).find((register) => types.has(register) && types.get(register) !== 'Lo0O0OOoo/OooOOOO;');
      if (types.get(objectRegister) === 'Lo0O0OOoo/OooOOOO;' && stringArgs.length >= 2 && fragmentRegister) {
        tabs.set(objectRegister, {
          id: strings.get(stringArgs[0]),
          title: strings.get(stringArgs[1]),
          fragment: types.get(fragmentRegister),
        });
      }
      continue;
    }
    match = line.match(/^\s*invoke-virtual\s+\{([^}]+)\},\s*Ljava\/util\/ArrayList;->add\(Ljava\/lang\/Object;\)Z/);
    if (match) {
      const registers = match[1].split(',').map((value) => value.trim());
      const tab = tabs.get(registers[1]);
      if (tab) added.push(tab);
    }
  }
  return added;
}

function hasTwoHomeTabContract(onCreate, tabs) {
  return !/OooOOo0\(\)Z/.test(onCreate)
    && tabs.length === 2
    && tabs[0].id === 'schedule'
    && tabs[1].id === 'mine';
}

test('home assembles only schedule and mine while the upstream calendar class remains unreachable', async (t) => {
  const root = await patchedFixture(t);
  const onCreate = await readSmaliMethod(root, activityPath, activityClass, 'public onCreate(Landroid/os/Bundle;)V');
  const tabs = extractTabAdditions(onCreate);
  assert.deepEqual(tabs, [
    { id: 'schedule', title: '课表', fragment: 'Lcom/suda/yzune/wakeupschedule/schedule/ScheduleFragment;' },
    { id: 'mine', title: '我的', fragment: 'Lcom/suda/yzune/wakeupschedule/aaa/fragment/MineFragment;' },
  ]);
  assert.equal(hasTwoHomeTabContract(onCreate, tabs), true, 'the patched onCreate has exactly the retained two tabs');
  const forcedJump = onCreate.indexOf('goto :cond_b');
  const unreachableCalendar = onCreate.indexOf('new-instance v5, Lcom/suda/yzune/wakeupschedule/aaa/calendar/ui/CalendarFragment;');
  const jumpTarget = [...onCreate.matchAll(/^\s*:cond_b\s*$/gm)].map((match) => match.index).find((index) => index > forcedJump) ?? -1;
  assert.ok(forcedJump >= 0 && unreachableCalendar > forcedJump && jumpTarget > unreachableCalendar,
    'the fixed unconditional jump skips the retained upstream calendar block before its target label');
  assert.equal((onCreate.match(/const-string v6, "calendar"/g) ?? []).length, 1,
    'the upstream calendar instructions remain as unreachable bytecode rather than being mistaken for a visible tab');
  assert.equal((await readFile(path.join(baseline, 'smali_classes5/com/suda/yzune/wakeupschedule/aaa/calendar/ui/CalendarFragment.smali'), 'utf8')).includes('.class '), true,
    'the upstream calendar implementation remains in the APK but is not reachable from home');
  assert.doesNotMatch(onCreate, /AssistantFragment|const-string v5, "assistant"|const-string v5, "learn"|aaa\/learn\/Oooo000/);
});

test('the removed calendar AB patch cannot restore a fixed tab in either AB state', async (t) => {
  const root = await patchedFixture(t);
  const onCreate = await readSmaliMethod(root, activityPath, activityClass, 'public onCreate(Landroid/os/Bundle;)V');
  const actualTabs = extractTabAdditions(onCreate);
  const spec = JSON.parse(await readFile('patches/slim-v1/patch-spec.json', 'utf8'));
  assert.equal(spec.operations.some((operation) => operation.id === 'T07-E05-enable-local-calendar-tab'), false);
  assert.deepEqual(actualTabs.map(({ id }) => id), ['schedule', 'mine']);
  for (const abValue of [false, true]) {
    assert.deepEqual(extractTabAdditions(onCreate).map(({ id }) => id), ['schedule', 'mine'], `AB value ${abValue} has no calendar call site to enable`);
  }
  assert.match(onCreate, /goto :cond_b/);
  assert.doesNotMatch(onCreate, /OooOOo0\(\)Z/);
});

test('restored bottom_banner cannot select the HomeBannerController branch', async (t) => {
  const root = await patchedFixture(t);
  const onCreate = await readSmaliMethod(root, activityPath, activityClass, 'public onCreate(Landroid/os/Bundle;)V');
  const assignedFalse = onCreate.indexOf('iput-boolean v0, p0, Lcom/suda/yzune/wakeupschedule/schedule/ScheduleActivity;->o00OOOO:Z');
  const bannerBranch = onCreate.indexOf('iget-boolean v1, p0, Lcom/suda/yzune/wakeupschedule/schedule/ScheduleActivity;->o00OOOO:Z');
  const bannerCreate = onCreate.indexOf('new-instance p1, Lcom/suda/yzune/wakeupschedule/schedule/home/HomeBannerController;');
  assert.ok(assignedFalse >= 0 && bannerBranch > assignedFalse && bannerCreate > bannerBranch);
  assert.match(onCreate.slice(bannerBranch, bannerCreate), /if-eqz v1, :cond_8/);
  assert.match(onCreate, /invoke-virtual \{p1\}, Lo0O0oOOO\/o00000OO;->OooO0O0\(\)Landroid\/widget\/FrameLayout;/);
});

test('schedule and mine IDs resolve against the actual two tabs; all other IDs fall back to schedule', async (t) => {
  const root = await patchedFixture(t);
  const onCreate = await readSmaliMethod(root, activityPath, activityClass, 'public onCreate(Landroid/os/Bundle;)V');
  const tabs = extractTabAdditions(onCreate);
  const adapter = await readSmaliMethod(root, adapterPath, adapterClass, 'public final OooO00o(Ljava/lang/String;)I');
  const route = await readSmaliMethod(root, activityPath, activityClass, 'public final o0000oO0(Ljava/lang/String;)V');
  assert.match(adapter, /Iterable;->iterator\(\)[\s\S]*?const\/4 v1, -0x1[\s\S]*?const\/4 v2, 0x0/);
  assert.match(adapter, /OooOOOO;->OooO0O0\(\)Ljava\/lang\/String;[\s\S]*?if-eqz v3, :cond_1[\s\S]*?return v1/);
  assert.match(route, /OooOOO;->OooO00o\(Ljava\/lang\/String;\)I[\s\S]*?if-gez p1, :slim_v1_schedule_tab_resolved[\s\S]*?const-string p1, "schedule"[\s\S]*?setCurrentItem\(I\)V/);
  const resolve = (id) => {
    const found = tabs.findIndex((tab) => tab.id === id);
    return found >= 0 ? found : tabs.findIndex((tab) => tab.id === 'schedule');
  };
  for (const id of ['schedule', 'mine']) assert.equal(tabs[resolve(id)].id, id);
  for (const id of ['calendar', 'learn', 'assistant', 'unknown', '']) assert.equal(tabs[resolve(id)].id, 'schedule');
  assert.match(route, /const-string p1, "schedule"/);

  const initial = await readSmaliMethod(root, activityPath, activityClass, 'public final o0000OOo()V');
  const newIntent = await readSmaliMethod(root, activityPath, activityClass, 'public onNewIntent(Landroid/content/Intent;)V');
  assert.match(initial, /getIntent\(\)[\s\S]*?const-string v2, "select_tab_id"[\s\S]*?hasExtra\(Ljava\/lang\/String;\)Z[\s\S]*?getStringExtra\(Ljava\/lang\/String;\)/);
  assert.match(initial, /const-string v0, "schedule"[\s\S]*?o0000oO0\(Ljava\/lang\/String;\)V/);
  assert.match(newIntent, /getStringExtra\(Ljava\/lang\/String;\)[\s\S]*?if-nez p1, :cond_1[\s\S]*?const-string p1, "schedule"[\s\S]*?o0000oO0\(Ljava\/lang\/String;\)V/);
  assert.match(newIntent, /const-string v0, "only_select_tab"[\s\S]*?setIntent\(Landroid\/content\/Intent;\)V[\s\S]*?o0000OOo\(\)V/);
  assert.equal(/const-string v2, "select_tab_id"[\s\S]*?hasExtra\(Ljava\/lang\/String;\)Z[\s\S]*?getStringExtra\(Ljava\/lang\/String;\)/.test(initial), true,
    'the initial request key is prepared, checked for presence, then read');
  assert.equal(/getStringExtra[\s\S]*?if-nez p1, :cond_1[\s\S]*?const-string p1, "schedule"/.test(newIntent), true,
    'a missing new-Intent Extra defaults to schedule');
  // The ID resolution above is a model over extracted Smali metadata; it does not execute Android routing.
});

test('routing state and home page gesture instructions remain at baseline', async (t) => {
  const root = await patchedFixture(t);
  for (const signature of [
    'public final o0000OOo()V',
    'public onNewIntent(Landroid/content/Intent;)V',
    'public onSaveInstanceState(Landroid/os/Bundle;)V',
  ]) {
    const before = await readSmaliMethod(baseline, activityPath, activityClass, signature);
    const after = await readSmaliMethod(root, activityPath, activityClass, signature);
    assert.equal(hash(after), hash(before), `${signature} stays unchanged`);
  }
  const beforeCreate = await readSmaliMethod(baseline, activityPath, activityClass, 'public onCreate(Landroid/os/Bundle;)V');
  const afterCreate = await readSmaliMethod(root, activityPath, activityClass, 'public onCreate(Landroid/os/Bundle;)V');
  const assertNoScrollTrue = (body) => {
    const call = body.indexOf('invoke-virtual {p1, v1}, Lcom/baidu/homework/common/ui/widget/NoScrollViewPager;->setNoScroll(Z)V');
    const assignment = body.lastIndexOf('const/4 v1, 0x1', call);
    assert.ok(call >= 0 && assignment >= 0, 'onCreate sets the pager to no-scroll with true');
    assert.doesNotMatch(body.slice(assignment + 'const/4 v1, 0x1'.length, call),
      /^\s*(?:const|move|move-result|iget|sget|new-instance|check-cast|array-length|aget)\S*\s+v1(?:,|\s)/m,
      'the true value is not overwritten before setNoScroll');
  };
  assertNoScrollTrue(beforeCreate);
  assertNoScrollTrue(afterCreate);
});

test('tab labels and page callbacks continue to use the adapter list and dynamic positions', async (t) => {
  const root = await patchedFixture(t);
  const loadTabs = await readSmaliMethod(root, tabsPath, tabsClass, 'private final loadTabs(Ljava/util/List;)V');
  const setViewPager = await readSmaliMethod(root, tabsPath, tabsClass, 'public final setViewPager(Landroidx/viewpager/widget/ViewPager;Lcom/suda/yzune/wakeupschedule/schedule/ScheduleViewModel;)V');
  assert.match(loadTabs, /List;->size\(\)I[\s\S]*?div-int\/2addr v1, v0[\s\S]*?Iterable;->iterator\(\)/);
  assert.match(loadTabs, /add-int\/lit8 v4, v3, 0x1[\s\S]*?OooOOOO;->OooO0OO\(\)Ljava\/lang\/String;[\s\S]*?MainAiTitleTabView\$OooO0O0;-><init>\(Lcom\/suda\/yzune\/wakeupschedule\/widget\/MainAiTitleTabView;ILjava\/lang\/String;\)V/);
  assert.match(setViewPager, /OooOOO;->OooO0O0\(\)Ljava\/util\/List;[\s\S]*?loadTabs\(Ljava\/util\/List;\)V[\s\S]*?getCount\(\)I/);
});

test('joint offline/network patch keeps the two-tab home local and preserves only intended delayed work', async (t) => {
  const root = await patchedFixture(t, { joint: true });
  const onCreate = await readSmaliMethod(root, activityPath, activityClass, 'public onCreate(Landroid/os/Bundle;)V');
  const tabs = extractTabAdditions(onCreate);
  assert.equal(hasTwoHomeTabContract(onCreate, tabs), true, 'the joint patch retains only schedule and mine');
  const switches = await readSmaliMethod(root, switchesPath, switchesClass, 'public static final OooOOOO()Z');
  const callback = await readSmaliMethod(root, switchesPath, switchesClass, 'public static final OooOo0o(Landroid/content/Context;Lo000O0Oo/OooO0O0;)V');
  assert.match(switches, /const\/4 v0, 0x0\s+return v0/);
  assert.match(callback, /OooO00o\(Ljava\/lang\/Object;\)V[\s\S]*?return-void/);
  assert.doesNotMatch(callback, /enqueue|execute|startActivity|Http|Request|OooO0OO\(/);

  const localTasks = await readSmaliMethod(root, activityPath, activityClass, 'public final oo0o0Oo()V');
  assert.match(localTasks, /ScheduleActivity\$OooO0o;-><init>/);
  assert.match(localTasks, /ScheduleActivity\$OooO;-><init>/);
  assert.match(localTasks, /o00OOooO:Lo0O00Ooo\/OooOOO;[\s\S]*?OooO0o\(\[Lcom\/homework\/launchmanager\/task\/OooO00o;\)/);
  for (const signature of [
    'public final o0000()V',
    'public final o00000Oo()V',
    'public final o0000o()V',
    'public final o0000OOO()V',
    'public final o00000oO(Landroid/content/Intent;)V',
  ]) assert.match(await readSmaliMethod(root, activityPath, activityClass, signature), /\.locals 0\s+return-void/, `${signature} stays disabled`);
});

test('production pager listener keeps the bottom sheet above the real home tabs', async (t) => {
  const root = await patchedFixture(t, { joint: true, layout: true });
  const source = await readFile(path.join(root, activityPath), 'utf8');
  assert.match(source, /^\.implements Landroid\/view\/View\$OnLayoutChangeListener;$/m);
  const onCreate = await readSmaliMethod(root, activityPath, activityClass, 'public onCreate(Landroid/os/Bundle;)V');
  const onDestroy = await readSmaliMethod(root, activityPath, activityClass, 'public onDestroy()V');
  assert.equal((onCreate.match(/slimInstallPagerBounds\(\)V/g) ?? []).length, 1);
  assert.ok(onCreate.indexOf('setViewPager(Landroidx/viewpager/widget/ViewPager;') < onCreate.indexOf('slimInstallPagerBounds()V'));
  assert.ok(onDestroy.indexOf('slimRemovePagerBounds()V') < onDestroy.indexOf('invoke-super {p0}, Landroidx/appcompat/app/AppCompatActivity;->onDestroy()V'));
  for (const descriptor of [
    'public onLayoutChange(Landroid/view/View;IIIIIIII)V',
    'private slimInstallPagerBounds()V',
    'private slimSyncPagerBounds()V',
    'private slimRemovePagerBounds()V',
  ]) assert.match(pagerMethodBlock(source, descriptor), /\.method /);

  const newView = (properties) => ({
    parent: null,
    height: 0,
    paddingBottom: 0,
    top: 0,
    visibility: 0,
    layoutParams: null,
    setLayoutParamsCalls: 0,
    listeners: [],
    ...properties,
  });
  const rootView = newView({ kind: 'FrameLayout', height: 0, paddingBottom: 24 });
  const pager = newView({ layoutParams: { kind: 'FrameLayout$LayoutParams', bottomMargin: 7, leftMargin: 2, topMargin: 4, rightMargin: 6, gravity: 3 } });
  const tab = newView({ height: 0, top: 680, visibility: 0 });
  pager.parent = rootView;
  tab.parent = rootView;
  const activity = { kind: 'ScheduleActivity' };
  const world = { registers: [], localCount: 0, pager, tab };
  pagerExecuteMethod(source, 'private slimInstallPagerBounds()V', [activity], world);
  assert.equal(rootView.listeners.length, 1);
  assert.equal(tab.listeners.length, 1);
  assert.equal(pager.layoutParams.bottomMargin, 7, 'unmeasured views wait for the next layout callback');
  assert.equal(pager.setLayoutParamsCalls, 0);

  rootView.height = 800;
  tab.height = 48;
  const callback = 'public onLayoutChange(Landroid/view/View;IIIIIIII)V';
  const fireLayout = (view = tab) => pagerExecuteMethod(source, callback, [activity, view, 0, 0, 0, 0, 0, 0, 0, 0], world);
  fireLayout();
  assert.equal(pager.layoutParams.bottomMargin, 96, 'content bottom 776 minus the tab top 680 gives the reserved margin');
  assert.deepEqual({ left: pager.layoutParams.leftMargin, top: pager.layoutParams.topMargin, right: pager.layoutParams.rightMargin, gravity: pager.layoutParams.gravity },
    { left: 2, top: 4, right: 6, gravity: 3 }, 'the production callback preserves other FrameLayout params');
  assert.equal(pager.setLayoutParamsCalls, 1);
  fireLayout();
  assert.equal(pager.setLayoutParamsCalls, 1, 'same measurements do not cause a setLayoutParams loop');

  rootView.height = 840;
  rootView.paddingBottom = 28;
  tab.top = 700;
  fireLayout(rootView);
  assert.equal(pager.layoutParams.bottomMargin, 112, 'updated root size, already-applied bottom inset, and tab top are remeasured');
  const insetAwareTab = newView({ height: 48, top: 700, visibility: 0, paddingBottom: 28, parent: rootView });
  const insetAwarePager = newView({ parent: rootView, layoutParams: { kind: 'FrameLayout$LayoutParams', bottomMargin: 0 } });
  const insetAwareWorld = { registers: [], localCount: 0, pager: insetAwarePager, tab: insetAwareTab };
  pagerExecuteMethod(source, 'private slimSyncPagerBounds()V', [activity], insetAwareWorld);
  assert.equal(insetAwarePager.layoutParams.bottomMargin, 112,
    'a tab whose own paddingBottom already includes the 28 px system area does not add that area to the reserved margin');
  tab.visibility = 8;
  fireLayout();
  assert.equal(pager.layoutParams.bottomMargin, 0, 'a hidden tab reserves no space');
  for (const visibility of [4, 8]) {
    tab.visibility = 0;
    tab.height = 48;
    fireLayout();
    assert.equal(pager.layoutParams.bottomMargin, 112);
    const calls = pager.setLayoutParamsCalls;
    tab.visibility = visibility;
    tab.height = 0;
    fireLayout();
    assert.equal(pager.layoutParams.bottomMargin, 0, `an unmeasured tab with visibility ${visibility} still releases the old margin`);
    assert.equal(pager.setLayoutParamsCalls, calls + 1);
  }
  tab.visibility = 0;
  tab.height = 0;
  const waitingMargin = pager.layoutParams.bottomMargin;
  const waitingCalls = pager.setLayoutParamsCalls;
  fireLayout();
  assert.equal(pager.layoutParams.bottomMargin, waitingMargin, 'a visible but unmeasured tab waits for its next layout');
  assert.equal(pager.setLayoutParamsCalls, waitingCalls);
  tab.height = 48;
  tab.top = -30;
  fireLayout();
  assert.equal(pager.layoutParams.bottomMargin, 812, 'a negative tab top clamps to the content top');
  tab.top = 900;
  fireLayout();
  assert.equal(pager.layoutParams.bottomMargin, 0, 'a tab below the content bottom clamps to the bottom');

  pagerExecuteMethod(source, 'private slimRemovePagerBounds()V', [activity], world);
  assert.equal(rootView.listeners.length, 0);
  assert.equal(tab.listeners.length, 0);
  pagerExecuteMethod(source, 'private slimInstallPagerBounds()V', [activity], world);
  assert.equal(rootView.listeners.length, 1, 'a rebuilt home registers exactly one listener');
  assert.equal(tab.listeners.length, 1);

  const differentParent = newView({ kind: 'FrameLayout', height: 600 });
  const wrongTab = newView({ height: 40, top: 500, parent: differentParent });
  const wrongPager = newView({ parent: rootView, layoutParams: { bottomMargin: 17 } });
  const mismatchWorld = { registers: [], localCount: 0, pager: wrongPager, tab: wrongTab };
  pagerExecuteMethod(source, 'private slimInstallPagerBounds()V', [activity], mismatchWorld);
  pagerExecuteMethod(source, 'private slimSyncPagerBounds()V', [activity], mismatchWorld);
  assert.equal(rootView.listeners.length, 1, 'different-parent views do not install an invalid shared callback');
  assert.equal(wrongPager.layoutParams.bottomMargin, 17);
  assert.equal(wrongPager.setLayoutParamsCalls, 0);
  const invalidParent = newView({ kind: 'LinearLayout', height: 600 });
  wrongPager.parent = invalidParent;
  wrongTab.parent = invalidParent;
  pagerExecuteMethod(source, 'private slimInstallPagerBounds()V', [activity], mismatchWorld);
  assert.equal(invalidParent.listeners.length, 0, 'non-FrameLayout parents are rejected');

  const nullPagerTab = newView({ parent: rootView, height: 48, top: 700 });
  const nullPagerWorld = { registers: [], localCount: 0, pager: null, tab: nullPagerTab };
  pagerExecuteMethod(source, 'private slimSyncPagerBounds()V', [activity], nullPagerWorld);
  assert.equal(nullPagerTab.setLayoutParamsCalls, 0, 'a null pager exits before any parameter write');

  const nullTabParams = { kind: 'FrameLayout$LayoutParams', bottomMargin: 23, leftMargin: 4, gravity: 3 };
  const nullTabPager = newView({ parent: rootView, layoutParams: nullTabParams });
  const nullTabWorld = { registers: [], localCount: 0, pager: nullTabPager, tab: null };
  pagerExecuteMethod(source, 'private slimSyncPagerBounds()V', [activity], nullTabWorld);
  assert.strictEqual(nullTabPager.layoutParams, nullTabParams, 'a null tab leaves the original pager params object intact');
  assert.deepEqual(nullTabParams, { kind: 'FrameLayout$LayoutParams', bottomMargin: 23, leftMargin: 4, gravity: 3 });
  assert.equal(nullTabPager.setLayoutParamsCalls, 0, 'a null tab never calls setLayoutParams');

  const nonFrameParams = { kind: 'LinearLayout$LayoutParams', bottomMargin: 31, leftMargin: 5, gravity: 7 };
  const invalidParamsPager = newView({ parent: rootView, layoutParams: nonFrameParams });
  const invalidParamsTab = newView({ parent: rootView, height: 48, top: 700 });
  const invalidParamsWorld = { registers: [], localCount: 0, pager: invalidParamsPager, tab: invalidParamsTab };
  pagerExecuteMethod(source, 'private slimSyncPagerBounds()V', [activity], invalidParamsWorld);
  assert.strictEqual(invalidParamsPager.layoutParams, nonFrameParams, 'a non-FrameLayout params object is retained by identity');
  assert.deepEqual(nonFrameParams, { kind: 'LinearLayout$LayoutParams', bottomMargin: 31, leftMargin: 5, gravity: 7 });
  assert.equal(invalidParamsPager.setLayoutParamsCalls, 0, 'invalid params do not call setLayoutParams');
});
