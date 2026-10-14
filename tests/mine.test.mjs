import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { applyPatchSpec } from '../scripts/patch.mjs';
import { readSmaliMethod } from './smali-helpers.mjs';

const baseline = path.resolve(process.env.SLIM_BASELINE_DECODED_ROOT ?? 'tools/_cache/slim-v1-decoded');
const fixtures = path.resolve('tools/_cache/slim-v1-review/fixtures/round-2');
const fragmentPath = 'smali_classes5/com/suda/yzune/wakeupschedule/aaa/fragment/MineFragment.smali';
const layoutPath = 'res/layout/fragment_mine_tab_content_view_new.xml';
const fragmentClass = 'Lcom/suda/yzune/wakeupschedule/aaa/fragment/MineFragment;';
const settingsBasePath = 'smali_classes5/com/suda/yzune/wakeupschedule/base_view/OooOO0.smali';
const settingsClass = 'Lcom/suda/yzune/wakeupschedule/settings/SettingsActivity;';

async function patchedFixture(t) {
  await mkdir(fixtures, { recursive: true });
  const root = await mkdtemp(path.join(fixtures, 'mine-simulation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fullSpec = JSON.parse(await readFile('patches/slim-v1/patch-spec.json', 'utf8'));
  const operations = fullSpec.operations.filter((operation) => operation.id.startsWith('T10-E')
    || operation.id.startsWith('T35-E55-') || operation.id === 'T34-E55-settings-viewport-clip');
  assert.equal(operations.length, 21, 'the XML, lifecycle/listener patches, four SettingsActivity log operations, and revised inset operation are present');
  assert.equal(operations.filter((operation) => operation.id.startsWith('T35-E55-')).length, 4);
  const targets = new Set([...operations.map((operation) => operation.relativePath), fragmentPath, layoutPath, settingsBasePath]);
  for (const relative of targets) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(baseline, relative), target);
  }
  const specPath = path.join(root, 'mine-fixture-spec.json');
  await writeFile(specPath, JSON.stringify({ schemaVersion: 1, applicationId: 'io.github.wakeupnoads', operations }));
  await applyPatchSpec({ root, specPath });
  return root;
}

async function productionPatchFixture(t, operations, lineEnding) {
  await mkdir(fixtures, { recursive: true });
  const root = await mkdtemp(path.join(fixtures, 'mine-round4-production-'));
  assert.ok(root.startsWith(`${path.resolve(fixtures)}${path.sep}`), 'the round-four Smali fixture stays below tools/_cache');
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const relative of new Set(operations.map((operation) => operation.relativePath))) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    const original = await readFile(path.join(baseline, relative), 'utf8');
    const normalized = original.replace(/\r\n/g, '\n');
    await writeFile(target, lineEnding === '\r\n' ? normalized.replace(/\n/g, '\r\n') : normalized);
  }
  const specPath = path.join(root, 'round4-production-fixture-spec.json');
  await writeFile(specPath, JSON.stringify({ schemaVersion: 1, applicationId: 'io.github.wakeupnoads', operations }));
  return { root, specPath };
}

function parsedMethod(source, descriptor) {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `.method ${descriptor}`);
  assert.notEqual(start, -1, `patched method exists: ${descriptor}`);
  const end = lines.findIndex((line, index) => index > start && line.trim() === '.end method');
  assert.notEqual(end, -1, `patched method closes: ${descriptor}`);
  const block = lines.slice(start, end + 1);
  const locals = Number(block.find((line) => /^\s*\.locals\s+\d+/.test(line))?.trim().split(/\s+/)[1] ?? 0);
  const instructions = [];
  const labels = new Map();
  for (const raw of block.slice(1, -1)) {
    const line = raw.trim();
    if (!line || line.startsWith('.')) continue;
    if (line.startsWith(':')) { labels.set(line, instructions.length); continue; }
    instructions.push(line);
  }
  return { locals, instructions, labels };
}

function executeSettingsSmali(source, descriptor, args, world) {
  const method = parsedMethod(source, descriptor);
  const registers = Array(method.locals + args.length + 2).fill(null);
  args.forEach((value, index) => { registers[method.locals + index] = value; });
  const previous = world.registers;
  const previousLocals = world.locals;
  world.registers = registers;
  world.locals = method.locals;
  const read = (name) => /^[vp]\d+$/.test(name)
    ? registers[name[0] === 'v' ? Number(name.slice(1)) : method.locals + Number(name.slice(1))]
    : name.startsWith('-0x') ? -Number.parseInt(name.slice(3), 16) : name.startsWith('0x') ? Number.parseInt(name.slice(2), 16) : Number(name);
  const write = (name, value) => { registers[name[0] === 'v' ? Number(name.slice(1)) : method.locals + Number(name.slice(1))] = value; };
  const invoke = (instruction) => {
    const match = /^(invoke-[\w/-]+)\s+\{([^}]*)\},\s*([^;]+);->([^ (]+)(\(.*)$/.exec(instruction);
    assert.ok(match, `supported SettingsActivity invoke: ${instruction}`);
    const [, kind, rawRegisters, ownerName, name, targetDescriptor] = match;
    const owner = `${ownerName};`;
    const values = rawRegisters.split(',').map((value) => value.trim()).filter(Boolean).map(read);
    world.trace.push(`${owner}->${name}`);
    if (owner === 'Lcom/suda/yzune/wakeupschedule/slim/LogPage;') {
      if (name === 'isLogActivity') return Boolean(values[0].logMode);
      if (name === 'prepareActivity') { values[0].prepared += 1; return undefined; }
      if (name === 'attachActivity') { values[0].attached += 1; return undefined; }
      if (name === 'onBackPressed') { values[0].backBridge += 1; return Boolean(values[0].logMode); }
      if (name === 'onActivityResult') { values[0].resultBridge += 1; return undefined; }
      if (name === 'onDestroy') { values[0].destroyBridge += 1; return undefined; }
    }
    if (owner === 'Landroid/app/Activity;' && name === 'getWindow') return world.window;
    if (owner === 'Landroid/view/Window;' && name === 'getDecorView') return world.decorView;
    if (owner === 'Landroid/app/Activity;' && name === 'getApplication') return world.application;
    if (owner === 'Landroid/app/Activity;' && name === 'setResult') { world.setResult += 1; return undefined; }
    if (owner === 'Lcom/suda/yzune/wakeupschedule/AppDatabase$OooOOOO;' && name === 'OooO0o0') { world.databaseLookups += 1; return world.database; }
    if (owner === 'Lcom/suda/yzune/wakeupschedule/AppDatabase;' && name === 'OooOo0o') { world.daoLookups += 1; return world.dao; }
    if (owner === 'Landroid/app/Activity;' && name === 'getApplication') return world.application;
    if (owner === 'Landroidx/core/view/WindowInsetsControllerCompat;') return undefined;
    if (owner === 'Lkotlin/jvm/internal/o00oO0o;') return undefined;
    if (owner === 'Ljava/util/ArrayList;' && name === '<init>') return [];
    if (owner === settingsClass && name === 'oo0o0Oo') { world.settingsDataBuilds += 1; return undefined; }
    if (owner === 'Lcom/chad/library/adapter/base/BaseQuickAdapter;') { world.adapterCalls.push(name); return undefined; }
    if (owner === 'Landroidx/recyclerview/widget/RecyclerView;' && name === 'setAdapter') { world.recyclerAdapterInstalls += 1; return undefined; }
    if (owner === 'Ljava/lang/Integer;' && name === 'valueOf') return values[0];
    if (owner === 'Lcom/suda/yzune/wakeupschedule/base_view/OooOO0;' && name === 'o0OoOo0') return world.recycler;
    if (owner === 'Landroidx/recyclerview/widget/RecyclerView;' && name === 'getItemAnimator') return world.animator;
    if (owner.endsWith('ItemAnimator;')) return undefined;
    if (owner.endsWith('LinearLayoutManager;')) return undefined;
    if (owner.endsWith('RecyclerView;')) return undefined;
    if (kind === 'invoke-direct' && name === '<init>') return undefined;
    if (kind === 'invoke-super') return undefined;
    throw new Error(`unsupported SettingsActivity invoke: ${kind} ${owner}->${name}${targetDescriptor}`);
  };
  try {
    let pc = 0;
    let lastResult;
    let steps = 0;
    while (pc < method.instructions.length) {
      assert.ok(++steps < 600, `SettingsActivity fixture reaches return in ${descriptor}`);
      const instruction = method.instructions[pc];
      const op = instruction.split(/\s+/)[0];
      const tail = instruction.slice(op.length).trim();
      const parts = tail.split(',').map((value) => value.trim());
      let jump = null;
      if (/^const(?:\/4|\/16)?$/.test(op)) write(parts[0], read(parts[1]));
      else if (op === 'const-wide/16') write(parts[0], read(parts[1]));
      else if (op === 'const-string') write(parts[0], JSON.parse(tail.slice(tail.indexOf(',') + 1).trim()));
      else if (op === 'new-instance') write(parts[0], { type: parts[1] });
      else if (op === 'move' || op === 'move-object') write(parts[0], read(parts[1]));
      else if (op === 'move-result' || op === 'move-result-object') { write(parts[0], lastResult); lastResult = undefined; }
      else if (op === 'invoke-static' || op === 'invoke-virtual' || op === 'invoke-interface' || op === 'invoke-direct' || op === 'invoke-super') {
        lastResult = invoke(instruction);
      } else if (op === 'sget-object') { world.databaseHolder = { type: 'AppDatabaseHolder' }; write(parts[0], world.databaseHolder); }
      else if (op === 'iput-object') {
        const field = /;->([^:]+):/.exec(parts[2])?.[1];
        if (field === 'o00OOO') world.databaseInstalled += 1;
        if (field === 'o00OOOO0') world.daoInstalled += 1;
        write(parts[1], read(parts[1]));
      } else if (op === 'iget-object') {
        const field = /;->([^:]+):/.exec(parts[2])?.[1];
        write(parts[0], read(parts[1])[field] ?? { type: field });
      } else if (op === 'filled-new-array') {
        const regs = /\{([^}]*)\}/.exec(tail)[1].split(',').map((value) => value.trim());
        lastResult = regs.map(read);
      } else if (op === 'if-eqz' || op === 'if-nez') {
        const value = read(parts[0]);
        const zero = value === null || value === undefined || value === false || value === 0;
        if (op === 'if-eqz' ? zero : !zero) jump = parts[1];
      } else if (op === 'if-ne' || op === 'if-eq') {
        const equal = read(parts[0]) === read(parts[1]);
        if (op === 'if-ne' ? !equal : equal) jump = parts[2];
      } else if (op === 'goto' || op === 'goto/16') jump = tail;
      else if (op === 'check-cast') { /* reference-preserving fixture cast */ }
      else if (op === 'return-object' || op === 'return') {
        const returned = read(tail);
        world.returnValue = op === 'return-object' && returned === 0 ? null : returned;
        return { returned: true, steps };
      }
      else if (op === 'return-void') return { returned: true, steps };
      else throw new Error(`unsupported SettingsActivity instruction: ${op} ${instruction}`);
      if (jump) {
        assert.ok(method.labels.has(jump), `SettingsActivity label exists: ${jump}`);
        pc = method.labels.get(jump);
      } else pc += 1;
    }
    return { returned: false, steps };
  } finally { world.registers = previous; world.locals = previousLocals; }
}

test('T10 layout has two settings rows and a tagged logs row, all supporting enlarged text', async (t) => {
  const root = await patchedFixture(t);
  const xml = await readFile(path.join(root, layoutPath), 'utf8');
  const ids = [...xml.matchAll(/android:id="@id\/([^\"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(ids, ['mine_user_nested_scrollview', 'll_mine_tab_content_view_new_course_setting', 'll_mine_tab_content_view_global_setting']);
  assert.equal((xml.match(/<View\b/g) ?? []).length, 2, 'three rows use two dividers');
  assert.equal((xml.match(/android:tag="wakeup_noads_logs_entry"/g) ?? []).length, 1, 'the logs row has one stable non-resource tag');
  assert.equal((xml.match(/android:minHeight="52dp"/g) ?? []).length, 3);
  assert.equal((xml.match(/android:layout_height="wrap_content"/g) ?? []).length, 11);
  assert.match(xml, /android:paddingTop="12dp"/);
  assert.match(xml, /android:layout_marginStart="12dp"/);
  assert.match(xml, /android:layout_marginEnd="12dp"/);
  assert.match(xml, /android:layout_marginStart="16dp"/);
  assert.match(xml, /@drawable\/shape_solid_ffffffff_radius_16dp/);
  assert.doesNotMatch(xml, /android:id="@\+id\//, 'logs adds no numeric resource ID');
  assert.doesNotMatch(xml, /MineNewUserLoginView|ComposeView|Banner|bannerLayout|mine_user_login_view|ll_mine_vip_card|ll_mine_tab_content_view_(?!new_course_setting|global_setting)/);
});

test('T10 binds both settings and the local log entry while cutting login, Compose, banner, and remote Flow setup', async (t) => {
  const root = await patchedFixture(t);
  const bind = await readSmaliMethod(root, fragmentPath, fragmentClass, 'private final oo000o()V');
  assert.equal((bind.match(/setOnClickListener\(/g) ?? []).length, 2);
  assert.match(bind, /OoooOo0\(\)Landroid\/view\/View;/);
  assert.match(bind, /OoooOoO\(\)Landroid\/view\/View;/);
  assert.match(bind, /OooO0o\(\)Landroid\/view\/View;[\s\S]*?LogPage;->bind\(Ljava\/lang\/Object;Ljava\/lang\/Object;\)V/);
  assert.doesNotMatch(bind, /MineNewUserLoginView|ComposeView|setContent|Banner|updateData/);

  const create = await readSmaliMethod(root, fragmentPath, fragmentClass, 'public onCreateView(Landroid/view/LayoutInflater;Landroid/view/ViewGroup;Landroid/os/Bundle;)Landroid/view/View;');
  assert.match(create, /inflate\(ILandroid\/view\/ViewGroup;Z\)Landroid\/view\/View;/);
  assert.match(create, /oo000o\(\)V/);
  assert.match(create, /ViewCompat;->setOnApplyWindowInsetsListener\(Landroid\/view\/View;Landroidx\/core\/view\/OnApplyWindowInsetsListener;\)V/);
  assert.doesNotMatch(create, /o00O0O\(|o0OO00O\(|o00Oo0\(\)V/);

  for (const [signature, forbidden] of [
    ['public onResume()V', /MineViewModel|OooooO0/],
    ['public OooOoo()V', /MineViewModel|Banner|Ooooo00/],
    ['public OooOoo0()V', /Banner/],
    ['public onActivityResult(IILandroid/content/Intent;)V', /o0OO00O|o0ooOOo|QRScanActivity/],
  ]) {
    assert.doesNotMatch(await readSmaliMethod(root, fragmentPath, fragmentClass, signature), forbidden, signature);
  }
  const result = await readSmaliMethod(root, fragmentPath, fragmentClass, 'public onActivityResult(IILandroid/content/Intent;)V');
  assert.match(result, /invoke-super \{p0, p1, p2, p3\}, Landroidx\/fragment\/app\/Fragment;->onActivityResult\(IILandroid\/content\/Intent;\)V[\s\S]*?LogPage;->onActivityResult\(Ljava\/lang\/Object;IILjava\/lang\/Object;\)V/);
  assert.equal((result.match(/LogPage;->onActivityResult/g) ?? []).length, 1);
  const destroy = await readSmaliMethod(root, fragmentPath, fragmentClass, 'public onDestroy()V');
  assert.match(destroy, /LogPage;->close\(Ljava\/lang\/Object;\)V[\s\S]*?invoke-super \{p0\}, Lo000O00O\/OooO00o;->onDestroy\(\)V[\s\S]*?sput-object v0, Lcom\/suda\/yzune\/wakeupschedule\/aaa\/utils\/o000OOo0;->OooO00o/);
  assert.equal((destroy.match(/LogPage;->close\(Ljava\/lang\/Object;\)V/g) ?? []).length, 1);
  const bridge = await readFile('runtime/src/com/suda/yzune/wakeupschedule/slim/LogPage.java', 'utf8');
  for (const signature of [
    /public static void bind\(Object fragment, Object rootView\)/,
    /public static void show\(Object fragment\)/,
    /public static void onActivityResult\(Object fragment, int requestCode, int resultCode, Object intent\)/,
    /public static void close\(Object fragment\)/,
  ]) assert.match(bridge, signature, 'public Java method matches the Smali bridge ABI');
  assert.match(await readSmaliMethod(root, fragmentPath, fragmentClass, 'private final o00ooo()V'), /OoooooO\(\)Landroidx\/core\/widget\/NestedScrollView;/);
});

test('T35 SettingsActivity runs the true log branch and keeps ordinary initialization and lifecycle', async (t) => {
  const root = await patchedFixture(t);
  const settingsSource = await readFile(path.join(root, 'smali_classes6/com/suda/yzune/wakeupschedule/settings/SettingsActivity.smali'), 'utf8');
  for (const signature of [
    '.method public onBackPressed()V',
    '.method public onActivityResult(IILandroid/content/Intent;)V',
    '.method public onDestroy()V',
  ]) assert.equal(settingsSource.split(/\r?\n/).filter((line) => line.trim() === signature).length, 1,
    `the patched SettingsActivity contains one ${signature} override`);
  const create = await readSmaliMethod(root, 'smali_classes6/com/suda/yzune/wakeupschedule/settings/SettingsActivity.smali',
    'Lcom/suda/yzune/wakeupschedule/settings/SettingsActivity;', 'public onCreate(Landroid/os/Bundle;)V');
  const runCreate = (logMode) => {
    const activity = { logMode, prepared: 0, attached: 0, backBridge: 0, resultBridge: 0, destroyBridge: 0 };
    const world = {
      trace: [], window: {}, decorView: {}, application: {}, database: {}, dao: {}, recycler: {}, animator: {},
      databaseLookups: 0, databaseInstalled: 0, daoLookups: 0, daoInstalled: 0, settingsDataBuilds: 0,
      adapterCalls: [], recyclerAdapterInstalls: 0,
    };
    const result = executeSettingsSmali(create, 'public onCreate(Landroid/os/Bundle;)V', [activity, { type: 'Bundle' }], world);
    assert.equal(result.returned, true, 'the actual patched method executes through its return');
    return { activity, world };
  };
  const logMode = runCreate(true);
  assert.equal(logMode.activity.prepared, 1);
  assert.equal(logMode.activity.attached, 1);
  assert.ok(logMode.world.trace.indexOf('Lcom/suda/yzune/wakeupschedule/slim/LogPage;->prepareActivity')
    < logMode.world.trace.indexOf('Lcom/suda/yzune/wakeupschedule/base_view/OooOO0;->onCreate'),
  'the log title bridge runs before the base Activity creates its Toolbar');
  const originalSystemBar = 'Landroidx/core/view/WindowInsetsControllerCompat;->setAppearanceLightStatusBars';
  const attachActivity = 'Lcom/suda/yzune/wakeupschedule/slim/LogPage;->attachActivity';
  assert.equal(logMode.world.trace.filter((call) => call === originalSystemBar).length, 1,
    'the original onCreate system-bar appearance call still runs exactly once in log mode');
  assert.ok(logMode.world.trace.indexOf('Lcom/suda/yzune/wakeupschedule/base_view/OooOO0;->onCreate')
    < logMode.world.trace.indexOf(originalSystemBar)
    && logMode.world.trace.indexOf(originalSystemBar) < logMode.world.trace.indexOf(attachActivity),
  'the true log branch preserves prepare, base onCreate, original system-bar setup, then native log attachment');
  assert.equal(logMode.world.databaseLookups + logMode.world.daoLookups + logMode.world.settingsDataBuilds
    + logMode.world.adapterCalls.length + logMode.world.recyclerAdapterInstalls, 0,
  'the true log branch returns before database, DAO, settings rows, adapter listeners, and Recycler installation');

  const ordinary = runCreate(false);
  assert.equal(ordinary.activity.attached, 0);
  assert.equal(ordinary.world.databaseLookups, 1);
  assert.equal(ordinary.world.daoLookups, 1);
  assert.equal(ordinary.world.settingsDataBuilds, 1);
  assert.equal(ordinary.world.recyclerAdapterInstalls, 1);
  assert.ok(ordinary.world.adapterCalls.length >= 4, 'the original adapter receives its list and three click callbacks');
  const constructor = await readSmaliMethod(root, 'smali_classes6/com/suda/yzune/wakeupschedule/settings/SettingsActivity.smali',
    'Lcom/suda/yzune/wakeupschedule/settings/SettingsActivity;', 'public constructor <init>()V');
  assert.equal((constructor.match(/registerForActivityResult\(/g) ?? []).length, 2, 'constructor keeps both original activity result launchers');
  assert.match(constructor, /new-instance v0, Lcom\/suda\/yzune\/wakeupschedule\/settings\/o00O000o;[\s\S]*?iput-object v0, p0, Lcom\/suda\/yzune\/wakeupschedule\/settings\/SettingsActivity;->o00OOOO:/,
    'constructor still creates and stores the ordinary settings adapter');

  const menu = await readSmaliMethod(root, 'smali_classes6/com/suda/yzune/wakeupschedule/settings/SettingsActivity.smali',
    'Lcom/suda/yzune/wakeupschedule/settings/SettingsActivity;', 'public ooOO()Ljava/lang/Integer;');
  const menuWorld = (logModeValue) => {
    const activity = { logMode: logModeValue };
    const world = { trace: [] };
    executeSettingsSmali(menu, 'public ooOO()Ljava/lang/Integer;', [activity], world);
    return world.returnValue;
  };
  assert.equal(menuWorld(true), null, 'the real log menu method returns null in log mode');
  assert.equal(menuWorld(false), 0x7f0e0002, 'the normal settings menu resource is unchanged');

  const back = await readSmaliMethod(root, 'smali_classes6/com/suda/yzune/wakeupschedule/settings/SettingsActivity.smali',
    'Lcom/suda/yzune/wakeupschedule/settings/SettingsActivity;', 'public onBackPressed()V');
  const runBack = (logModeValue) => {
    const activity = { logMode: logModeValue, prepared: 0, attached: 0, backBridge: 0, resultBridge: 0, destroyBridge: 0 };
    const world = { trace: [], setResult: 0 };
    executeSettingsSmali(back, 'public onBackPressed()V', [activity], world);
    return { activity, world };
  };
  const logBack = runBack(true);
  assert.equal(logBack.world.setResult, 0, 'log return is consumed without changing the ordinary settings result');
  assert.equal(logBack.world.trace.some((call) => call === 'Landroidx/activity/ComponentActivity;->onBackPressed'), false);
  const normalBack = runBack(false);
  assert.equal(normalBack.world.setResult, 1);
  assert.ok(normalBack.world.trace.includes('Landroidx/activity/ComponentActivity;->onBackPressed'));

  const resultMethod = await readSmaliMethod(root, 'smali_classes6/com/suda/yzune/wakeupschedule/settings/SettingsActivity.smali',
    'Lcom/suda/yzune/wakeupschedule/settings/SettingsActivity;', 'public onActivityResult(IILandroid/content/Intent;)V');
  for (const logModeValue of [true, false]) {
    const activity = { logMode: logModeValue, prepared: 0, attached: 0, backBridge: 0, resultBridge: 0, destroyBridge: 0 };
    const world = { trace: [] };
    executeSettingsSmali(resultMethod, 'public onActivityResult(IILandroid/content/Intent;)V', [activity, 0x6c67, -1, {}], world);
    assert.ok(world.trace.indexOf('Landroidx/activity/ComponentActivity;->onActivityResult')
      < (logModeValue ? world.trace.indexOf('Lcom/suda/yzune/wakeupschedule/slim/LogPage;->onActivityResult') : Infinity),
    'Activity super receives the result before the optional log bridge');
    assert.equal(activity.resultBridge, logModeValue ? 1 : 0);
  }
  const destroy = await readSmaliMethod(root, 'smali_classes6/com/suda/yzune/wakeupschedule/settings/SettingsActivity.smali',
    'Lcom/suda/yzune/wakeupschedule/settings/SettingsActivity;', 'public onDestroy()V');
  const destroyWorld = { logMode: true, prepared: 0, attached: 0, backBridge: 0, resultBridge: 0, destroyBridge: 0 };
  const destroyExecution = { trace: [] };
  executeSettingsSmali(destroy, 'public onDestroy()V', [destroyWorld], destroyExecution);
  assert.ok(destroyExecution.trace.indexOf('Lcom/suda/yzune/wakeupschedule/slim/LogPage;->onDestroy')
    < destroyExecution.trace.indexOf('Landroidx/appcompat/app/AppCompatActivity;->onDestroy'));
});

test('T10 click routing preserves both host callbacks and ends every removed menu route', async (t) => {
  const root = await patchedFixture(t);
  const click = await readSmaliMethod(root, fragmentPath, fragmentClass, 'public onClick(Landroid/view/View;)V');
  assert.match(click, /const v1, 0x7f0906e6\s+if-ne v0, v1, :cond_1/);
  assert.match(click, /const v1, 0x7f0906e2\s+if-ne v0, v1, :cond_0/);
  assert.equal((click.match(/ScheduleActivity;->o0000O0O\(\)/g) ?? []).length, 2);
  for (const call of [
    'ScheduleFragment;->o00oOOO0()Lkotlin/jvm/functions/Function0;',
    'ScheduleFragment;->o00OOOo0()Lkotlin/jvm/functions/Function0;',
    'MineActivity;->o00Oo0()V',
    'MineActivity;->ooOO()V',
  ]) assert.equal((click.match(new RegExp(call.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length, 1, call);
  assert.doesNotMatch(click, /CommonCacheHybridActivity|VipExclusiveActivity|QRScanActivity|startActivity|o0ooOOo\(/);
});

test('LogPage replaces only the settings list body with themed native content and readable actions', async () => {
  const source = await readFile('runtime/src/com/suda/yzune/wakeupschedule/slim/LogPage.java', 'utf8');
  const pageOpen = source.slice(source.indexOf('static NativePage openPage('), source.indexOf('static void renderPage('));
  const renderPage = source.slice(source.indexOf('static void renderPage('), source.indexOf('private static Object findDescendant('));
  const actionButton = source.slice(source.indexOf('private static Object button('), source.indexOf('@Override public int sdkInt()'));
  assert.match(pageOpen, /invoke\(ui, activity, "o00O0O"\)[\s\S]*?invoke\(ui, activity, "o0OoOo0"\)/,
    'the existing Coordinator and Recycler are read from the Activity');
  assert.match(pageOpen, /getChildCount[\s\S]*?APP_BAR[\s\S]*?findDescendant\(appBar, TOOLBAR, ui\)/,
    'the attached AppBar and Toolbar are found in the existing Coordinator tree');
  assert.doesNotMatch(pageOpen, /Oooooo0|AppBarLayout.{0,40}construct|MaterialToolbar.{0,40}construct|setSupportActionBar/,
    'the existing AppBar and Toolbar are reused without calling the factory or rebuilding the action bar');
  assert.match(pageOpen, /getLayoutParams[\s\S]*?getBehavior[\s\S]*?NestedScrollView[\s\S]*?removeView[\s\S]*?addView/);
  assert.match(actionButton, /MaterialButton[\s\S]*?"setMinimumHeight"[\s\S]*?dp\(context, 48, ui\)/);
  assert.match(actionButton, /setTextSize[\s\S]*?new Object\[\] \{ 2, 16\.0f \}/, 'native action text uses SP');
  assert.match(renderPage, /MaterialCardView[\s\S]*?setCardBackgroundColor/);
  assert.match(renderPage, /state\.detail && state\.selected != null \? "日志详情" : "本地日志"/,
    'the native Toolbar has the two fixed list and detail titles');
  assert.match(renderPage, /state\.selected\.fileName/);
  assert.match(renderPage, /add\(ui, page\.body, refreshButton, linearParams\(ui, -2, -2, 0\)\)/, 'refresh height wraps its SP text');
  assert.match(renderPage, /add\(ui, actions, copyButton, linearParams\(ui, -2, -2, 0\)\)[\s\S]*?add\(ui, actions, exportButton, linearParams\(ui, -2, -2, 0\)\)/,
    'copy and export heights wrap their SP text');
  assert.doesNotMatch(source, /buildDialog|android\.app\.Dialog|setStatusBarColor|setNavigationBarColor|mine_page_background|mine_text_primary|mine_divider|"‹"/,
    'the production page path has no dialog, forced system bar colors, mine color resources, or text back arrow');
  assert.doesNotMatch(renderPage, /setSingleLine|setMaxLines|setLines\(/, 'file names and text have no fixed line count');
});

test('production T35 and revised T34 apply on LF and CRLF and reject bad anchors atomically', async (t) => {
  const spec = JSON.parse(await readFile('patches/slim-v1/patch-spec.json', 'utf8'));
  const ids = [
    'T35-E05-initial-tab-style',
    'T35-E55-log-title-before-create',
    'T35-E55-log-content-mode',
    'T35-E55-log-menu-mode',
    'T35-E55-log-back-and-lifecycle',
    'T34-E55-settings-viewport-clip',
  ];
  const operations = ids.map((id) => {
    const operation = spec.operations.find((candidate) => candidate.id === id);
    assert.ok(operation, `the production spec contains ${id}`);
    return operation;
  });
  for (const lineEnding of ['\n', '\r\n']) {
    const { root, specPath } = await productionPatchFixture(t, operations, lineEnding);
    const result = await applyPatchSpec({ root, specPath });
    assert.deepEqual(result.operations.map((operation) => operation.id), ids,
      `${lineEnding === '\n' ? 'LF' : 'CRLF'} actual baseline fixture completes all five T35 operations and revised T34`);
    assert.equal(result.operations.length, 6);
    for (const relative of new Set(operations.map((operation) => operation.relativePath))) {
      const output = await readFile(path.join(root, relative), 'utf8');
      assert.equal(output.includes('\r\n'), lineEnding === '\r\n', 'production replacements preserve the fixture line ending');
      assert.equal((output.match(/(?<!\r)\n/g) ?? []).length, lineEnding === '\n' ? (output.match(/\n/g) ?? []).length : 0,
        'the applied official Smali has no mixed line endings');
    }
  }

  const initial = operations[0];
  const title = operations[1];
  for (const kind of ['duplicate', 'wrong']) {
    const { root, specPath } = await productionPatchFixture(t, [title, initial], '\r\n');
    const tabsFile = path.join(root, initial.relativePath);
    const beforeTabs = await readFile(tabsFile, 'utf8');
    const settingsFile = path.join(root, title.relativePath);
    const beforeSettings = await readFile(settingsFile, 'utf8');
    const anchor = initial.expectedOriginal;
    let changedTabs;
    if (kind === 'duplicate') {
      changedTabs = beforeTabs.replace(anchor, `${anchor}\r\n${anchor}`);
    } else {
      changedTabs = beforeTabs.replace(anchor, anchor.replace('addOnPageChangeListener', 'addOnPageChangeListenerChanged'));
    }
    assert.notEqual(changedTabs, beforeTabs, `${kind} fixture changes the real official setViewPager anchor`);
    await writeFile(tabsFile, changedTabs);
    await assert.rejects(applyPatchSpec({ root, specPath }), kind === 'duplicate'
      ? /expected 1 original fragment\(s\), found 2/
      : /expected 1 original fragment\(s\), found 0/);
    assert.equal(await readFile(tabsFile, 'utf8'), changedTabs, `${kind} failure leaves its source fixture unchanged`);
    assert.equal(await readFile(settingsFile, 'utf8'), beforeSettings,
      `${kind} failure leaves the earlier staged SettingsActivity operation unwritten`);
  }

  const viewport = operations[5];
  const { root, specPath } = await productionPatchFixture(t, [title, viewport], '\n');
  const viewportFile = path.join(root, viewport.relativePath);
  const settingsFile = path.join(root, title.relativePath);
  const beforeViewport = await readFile(viewportFile, 'utf8');
  const beforeSettings = await readFile(settingsFile, 'utf8');
  const wrongMethod = beforeViewport.replace(
    'invoke-static {}, Landroidx/core/view/WindowInsetsCompat$Type;->systemBars()I',
    'invoke-static {}, Landroidx/core/view/WindowInsetsCompat$Type;->ime()I'
  );
  assert.notEqual(wrongMethod, beforeViewport, 'the T34 official method fixture contains a unique, deliberately wrong anchor');
  await writeFile(viewportFile, wrongMethod);
  await assert.rejects(applyPatchSpec({ root, specPath }), /method SHA-256 changed/);
  assert.equal(await readFile(viewportFile, 'utf8'), wrongMethod, 'the rejected T34 fixture remains untouched');
  assert.equal(await readFile(settingsFile, 'utf8'), beforeSettings, 'the prior valid method plan is not partially written');
});
