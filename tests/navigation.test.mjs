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
const listenerPath = 'smali_classes6/com/suda/yzune/wakeupschedule/widget/MainAiTitleTabView$OooO0o.smali';
const adapterPath = 'smali_classes6/o0OO00Oo.1/OooOOO0.smali';
const switchesPath = 'smali_classes6/o0OO0oOo.3/o000oOoO.smali';
const activityClass = 'Lcom/suda/yzune/wakeupschedule/schedule/ScheduleActivity;';
const tabsClass = 'Lcom/suda/yzune/wakeupschedule/widget/MainAiTitleTabView;';
const adapterClass = 'Lo0OO00Oo/OooOOO0;';
const switchesClass = 'Lo0OO0oOo/o000oOoO;';
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
      || operation.id === 'T34-E05-hide-calendar-tab' || operation.id === 'T35-E05-initial-tab-style'
      || (layout && operation.id.startsWith('T34-E05-pager-')));
  } else {
    operations = spec.operations.filter((operation) => operation.id.startsWith('T07-E05-')
      || operation.id === 'T34-E05-hide-calendar-tab' || operation.id === 'T35-E05-initial-tab-style');
  }
  if (!joint) {
    assert.equal(operations.length, 8, 'ordinary mode selects the six retained T07 operations, hide-calendar, and initial-style operations');
    assert.equal(operations.some((operation) => operation.id === 'T34-E05-hide-calendar-tab'), true);
    assert.equal(operations.some((operation) => operation.id === 'T35-E05-initial-tab-style'), true);
    assert.equal(operations.some((operation) => operation.id === 'T07-E05-enable-local-calendar-tab'), false);
  }
  const targets = new Set(operations.map((operation) => operation.relativePath));
  if (!joint) for (const relative of [tabsPath, adapterPath, listenerPath]) targets.add(relative);
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

function tabMethodBlock(source, descriptor) {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim().startsWith('.method ') && line.trim().endsWith(descriptor));
  assert.notEqual(start, -1, `official tab method exists: ${descriptor}`);
  const end = lines.findIndex((line, index) => index > start && line.trim() === '.end method');
  assert.notEqual(end, -1, `official tab method closes: ${descriptor}`);
  return lines.slice(start, end + 1).join('\n');
}

function tabParseMethod(source, descriptor) {
  const block = tabMethodBlock(source, descriptor);
  const localCount = Number(block.match(/^\s*\.locals\s+(\d+)/m)?.[1]);
  const instructions = [];
  const labels = new Map();
  for (const raw of block.split('\n').slice(1, -1)) {
    const line = raw.trim();
    if (!line || line.startsWith('.')) continue;
    if (line.startsWith(':')) { labels.set(line, instructions.length); continue; }
    instructions.push(line);
  }
  return { descriptor, localCount, instructions, labels };
}

function tabInt(value) {
  if (String(value).startsWith('-0x')) return -Number.parseInt(String(value).slice(3), 16);
  if (String(value).startsWith('0x')) return Number.parseInt(String(value).slice(2), 16);
  return Number(value);
}

function tabFloatBits(value) {
  const buffer = new ArrayBuffer(4);
  new DataView(buffer).setUint32(0, tabInt(value) >>> 0, true);
  return new DataView(buffer).getFloat32(0, true);
}

function tabExecuteMethod(source, callbackSource, descriptor, args, world) {
  const methodSource = source.split(/\r?\n/).some((line) => line.trim().startsWith('.method ') && line.trim().endsWith(descriptor))
    ? source : callbackSource;
  const method = tabParseMethod(methodSource, descriptor);
  const registers = Array(method.localCount + args.length + 2).fill(null);
  args.forEach((value, index) => { registers[method.localCount + index] = value; });
  const previousRegisters = world.registers;
  const previousLocalCount = world.localCount;
  world.registers = registers;
  world.localCount = method.localCount;
  const indexOf = (name) => name[0] === 'v' ? Number(name.slice(1)) : method.localCount + Number(name.slice(1));
  const read = (name) => /^[vp]\d+$/.test(name) ? registers[indexOf(name)] : tabInt(name);
  const write = (name, value) => { registers[indexOf(name)] = value; };
  const fieldName = (text) => /;->([^:]+):/.exec(text)?.[1];
  const invoke = (instruction) => {
    const match = /^(invoke-(?:static|virtual|direct|super|interface)(?:\/range)?)\s+\{([^}]*)\},\s+(.+);->([^ (]+)(\(.*)$/.exec(instruction);
    assert.ok(match, `supported official tab invocation: ${instruction}`);
    const kind = match[1].replace('/range', '');
    const registerRange = /^\s*([vp]\d+)\s+\.\.\s+([vp]\d+)\s*$/.exec(match[2]);
    const rawRegisters = registerRange
      ? Array.from({ length: Number(registerRange[2].slice(1)) - Number(registerRange[1].slice(1)) + 1 },
        (_, offset) => registerRange[1][0] + (Number(registerRange[1].slice(1)) + offset))
      : match[2].split(',').map((value) => value.trim()).filter(Boolean);
    const values = rawRegisters.map(read);
    const owner = `${match[3]};`;
    const name = match[4];
    const targetDescriptor = match[5];
    const receiver = kind === 'invoke-static' ? null : values[0];
    const callArgs = kind === 'invoke-static' ? values : values.slice(1);
    if (owner === 'Lcom/meituan/robust/PatchProxy;' && name === 'proxy') return { isSupported: false, result: null };
    if (owner === tabsClass) {
      const callDescriptor = `${name}${targetDescriptor}`;
      if (name === 'loadTabs') {
        assert.deepEqual(callArgs[0].map((entry) => entry.id), world.adapter.tabs.map((entry) => entry.id));
        world.tabsBound = true;
        world.events.push('tabs-bound');
        return undefined;
      }
      if (name === 'loadBackground' && targetDescriptor === '()V' && world.inSetViewPager) {
        world.initialRefreshCalls += 1;
        world.events.push('initial-loadBackground');
        assert.deepEqual([world.modelBound, world.tabsBound, world.pagerBound, world.listenerAdded], [true, true, true, true],
          'the production initial refresh runs after model, tabs, pager and listener are ready');
      }
      world.methodCalls.push(name);
      return tabExecuteMethod(source, callbackSource,
        tabMethodBlock(source, callDescriptor).split('\n')[0].trim().replace(/^\.method\s+/, '').split(/\s+/).slice(0, -1).join(' ') + ` ${callDescriptor}`,
        kind === 'invoke-static' ? callArgs : [receiver, ...callArgs], world);
    }
    if (owner === 'Lcom/suda/yzune/wakeupschedule/widget/MainAiTitleTabView$OooO0o;') {
      const callDescriptor = `${name}${targetDescriptor}`;
      if (name === '<init>') {
        receiver.o00OOOO = callArgs[0]; receiver.o00OOOOo = callArgs[1];
        return undefined;
      }
      return tabExecuteMethod(source, callbackSource, callDescriptor, [receiver, ...callArgs], world);
    }
    if (owner === 'Lo0OO00Oo/OooOOO0;') {
      if (name === 'OooO0O0') return receiver.tabs;
      if (name === 'getCount') return receiver.tabs.length;
    }
    if (owner === 'Lo0OO00Oo/OooOOO;' && name === 'OooO0O0') return receiver.id;
    if (owner === 'Landroidx/viewpager/widget/ViewPager;') {
      if (name === 'getAdapter') return receiver.adapter;
      if (name === 'getCurrentItem') return receiver.currentItem;
      if (name === 'setOffscreenPageLimit') { receiver.offscreenLimit = callArgs[0]; world.events.push('pager-configured'); return undefined; }
      if (name === 'addOnPageChangeListener') {
        receiver.listeners.push(callArgs[0]); world.listenerAdded = true; world.events.push('listener-added'); return undefined;
      }
    }
    if (owner === 'Lcom/suda/yzune/wakeupschedule/schedule/ScheduleViewModel;' && name === 'Oooo0o') return receiver.night;
    if (owner === 'Lcom/suda/yzune/wakeupschedule/utils/ScheduleSpUtils;' && name === 'OooO0Oo') return world.preferenceNight;
    if (owner === 'Lo0o0OO0/o000oOoO;' && name === 'getValue') return receiver.value;
    if (owner === 'Landroidx/core/view/ViewGroupKt;' && name === 'getChildren') return { items: callArgs[0].children };
    if (owner === 'Lkotlin/sequences/OooOo00;' && name === 'iterator') return { items: receiver.items, index: 0 };
    if (owner === 'Ljava/util/List;' && name === 'iterator') return { items: receiver, index: 0 };
    if (owner === 'Ljava/util/Iterator;' && name === 'hasNext') return receiver.index < receiver.items.length;
    if (owner === 'Ljava/util/Iterator;' && name === 'next') return receiver.items[receiver.index++];
    if (owner === 'Ljava/util/List;' && name === 'get') return receiver[callArgs[0]] ?? null;
    if (owner === 'Lkotlin/collections/o00000O0;' && name === 'o0Oo0oo') return callArgs[0][callArgs[1]] ?? null;
    if (owner === 'Ljava/lang/String;' && name === 'hashCode') {
      let result = 0; for (const character of receiver) result = (Math.imul(result, 31) + character.charCodeAt(0)) | 0; return result;
    }
    if (owner === 'Ljava/lang/String;' && name === 'equals') return receiver === callArgs[0];
    if (owner === 'Ljava/lang/CharSequence;' && name === 'length') return receiver.length;
    if (owner === 'Ljava/lang/Boolean;' && name === 'booleanValue') return Boolean(receiver);
    if (owner === 'Ljava/lang/Integer;' && name === 'valueOf') return callArgs[0];
    if (owner === 'Ljava/lang/Integer;' && name === 'parseInt') return Number.parseInt(callArgs[0], 10);
    if (owner === 'Landroid/graphics/Color;' && name === 'parseColor') {
      const text = callArgs[0].toLowerCase();
      if (text === 'white') return 0xffffffff | 0;
      if (text === 'transparent') return 0;
      assert.match(text, /^#[0-9a-f]{6}([0-9a-f]{2})?$/);
      const hex = Number.parseInt(text.slice(1), 16);
      return (text.length === 7 ? (0xff000000 | hex) : ((hex & 0xff) << 24) | (hex >>> 8)) | 0;
    }
    if (owner === 'Landroidx/core/graphics/ColorUtils;' && name === 'setAlphaComponent') {
      assert.ok(callArgs[1] >= 0 && callArgs[1] <= 255, 'production ColorUtils receives an 8-bit alpha');
      return ((callArgs[0] & 0x00ffffff) | (callArgs[1] << 24)) | 0;
    }
    if (owner === 'Lkotlin/text/o000000O;' && name === 'OoooOoo') {
      const value = callArgs[2] ? callArgs[0].toLowerCase() : callArgs[0];
      const prefix = callArgs[2] ? callArgs[1].toLowerCase() : callArgs[1];
      return value.startsWith(prefix);
    }
    if (owner === 'Lkotlin/text/o00000OO;' && name === 'o0000') return callArgs[0].startsWith(callArgs[1]) ? callArgs[0].slice(callArgs[1].length) : callArgs[0];
    if (owner === 'Landroid/view/View;' && name === 'setBackgroundColor') { receiver.backgroundColor = callArgs[0] | 0; return undefined; }
    if (owner === 'Landroid/view/View;' && name === 'setVisibility') { receiver.visibility = callArgs[0]; return undefined; }
    if (owner === 'Landroid/view/View;' && name === 'findViewById') return receiver.views.get(callArgs[0]) ?? null;
    if (owner === 'Landroid/view/View;' && name === 'setAlpha') { receiver.alpha = callArgs[0]; return undefined; }
    if (owner === 'Landroid/view/View;' && name === 'setTranslationX') { receiver.translationX = callArgs[0]; return undefined; }
    if (owner === 'Landroid/view/ViewGroup;' && name === 'getChildAt') return receiver.children[callArgs[0]] ?? null;
    if (owner === 'Landroid/widget/ImageView;' && name === 'setImageResource') { receiver.imageResource = callArgs[0]; return undefined; }
    if (owner === 'Landroidx/appcompat/widget/AppCompatImageView;' && name === 'setImageDrawable') { receiver.drawable = callArgs[0]; return undefined; }
    if (owner === 'Landroid/widget/TextView;' && name === 'setTextSize') { receiver.textSizeUnit = callArgs[0]; receiver.textSize = callArgs[1]; return undefined; }
    if (owner === 'Landroid/widget/TextView;' && name === 'setTextColor') { receiver.textColor = callArgs[0] | 0; return undefined; }
    if (owner === 'Landroidx/appcompat/widget/AppCompatImageView;' && name === 'setImageResource') { receiver.imageResource = callArgs[0]; return undefined; }
    if (owner === 'Ljava/lang/Math;' && name === 'rint') return Math.round(callArgs[0]);
    if (owner === 'Lo000ooO0/OooOo;' && name === 'OooO0o') return world.density;
    if (owner === 'Lo000oo0o/OooOo00;' && name === 'OooOOOo') return undefined;
    if (owner === 'Lkotlin/jvm/internal/o00oO0o;' && name === 'OooO0Oo') return callArgs[0] === callArgs[1];
    if (owner === 'Lkotlin/jvm/internal/o00oO0o;' && ['OooO', 'OooO0o', 'OooO0o0', 'OooO0oO', 'OooO0oo'].includes(name)) return undefined;
    if (owner === 'Lkotlin/jvm/internal/o00oO0o;' && name === 'OooOoO0') throw new Error('unexpected null check failure in official tab code');
    if (owner === 'Lkotlin/jvm/functions/Function2;' && name === 'invoke') {
      const emitted = [callArgs[0], callArgs[1]];
      world.pageStyle.push(emitted);
      return undefined;
    }
    if (owner === 'Ljava/lang/Throwable;' && name === 'printStackTrace') return undefined;
    if (kind === 'invoke-direct' && name === '<init>' && receiver?.kind === 'listener') {
      receiver.tab = callArgs[0]; receiver.adapter = callArgs[1];
      receiver.o00OOO0O = callArgs[0]; receiver.o0o0Oo = callArgs[1]; return undefined;
    }
    throw new Error(`unsupported production tab call ${kind} ${owner}->${name}${targetDescriptor}`);
  };
  try {
    let pc = 0; let steps = 0; let lastResult;
    while (pc < method.instructions.length) {
      assert.ok(++steps < 5000, `official tab method returns within the restricted instruction limit: ${descriptor}`);
      const instruction = method.instructions[pc];
      const op = instruction.split(/\s+/)[0];
      const tail = instruction.slice(op.length).trim().split(/\s+#/, 1)[0].trim();
      const parts = tail.split(',').map((part) => part.trim());
      let jump = null;
      if (op === 'const-class') write(parts[0], { kind: 'class', descriptor: parts[1] });
      else if (op === 'const-string') {
        const comma = tail.indexOf(','); write(parts[0], JSON.parse(tail.slice(comma + 1).trim()));
      } else if (op === 'const/high16') write(parts[0], tabFloatBits(parts[1]));
      else if (/^const(?:\/4|\/16)?$/.test(op)) write(parts[0], tabInt(parts[1]));
      else if (op === 'new-instance') write(parts[0], { kind: 'listener' });
      else if (op === 'new-array') write(parts[0], Array.from({ length: read(parts[1]) }, () => null));
      else if (op === 'aput-object' || op === 'aput') read(parts[1])[read(parts[2])] = read(parts[0]);
      else if (op === 'aget-object' || op === 'aget') write(parts[0], read(parts[1])[read(parts[2])]);
      else if (op === 'array-length') write(parts[0], read(parts[1]).length);
      else if (op === 'move' || op === 'move-object') write(parts[0], read(parts[1]));
      else if (op === 'move-result' || op === 'move-result-object' || op === 'move-result-wide') { write(parts[0], lastResult); lastResult = undefined; }
      else if (op === 'move-exception') write(parts[0], { kind: 'ignored-exception' });
      else if (op === 'filled-new-array' || op === 'filled-new-array/range') {
        const registersInArray = /\{([^}]*)\}/.exec(tail)?.[1] ?? '';
        lastResult = registersInArray.split(',').map((register) => register.trim()).filter(Boolean).map(read);
      }
      else if (op.startsWith('invoke-')) lastResult = invoke(instruction);
      else if (op === 'sget-object') write(parts[0], world.scheduleSpUtils);
      else if (op === 'iget' || op === 'iget-object' || op === 'iget-boolean') {
        const field = fieldName(parts[2]); assert.ok(field, `production tab field is recognized: ${instruction}`); write(parts[0], read(parts[1])[field]);
      } else if (op === 'iput' || op === 'iput-object' || op === 'iput-boolean') {
        const field = fieldName(parts[2]); assert.ok(field, `production tab field is recognized: ${instruction}`); read(parts[1])[field] = read(parts[0]);
        if (field === 'scheduleViewModel') world.modelBound = true;
        if (field === 'viewPager') { world.pagerBound = true; world.events.push('pager-bound'); }
      } else if (op === 'check-cast') { /* reference-preserving Android cast */ }
      else if (op === 'instance-of') write(parts[0], read(parts[1])?.kind === 'adapter');
      else if (op === 'if-eqz' || op === 'if-nez') {
        const value = read(parts[0]); const zero = value == null || value === false || value === 0;
        if (op === 'if-eqz' ? zero : !zero) jump = parts[1];
      } else if (op === 'if-eq' || op === 'if-ne') {
        const equal = read(parts[0]) === read(parts[1]); if (op === 'if-eq' ? equal : !equal) jump = parts[2];
      } else if (op === 'if-lez') { if (read(parts[0]) <= 0) jump = parts[1]; }
      else if (op === 'goto' || op === 'goto/16') jump = tail;
      else if (op === 'add-int/lit8') write(parts[0], read(parts[1]) + tabInt(parts[2]));
      else if (op === 'mul-float/2addr') write(parts[0], read(parts[0]) * read(parts[1]));
      else if (op === 'float-to-double' || op === 'double-to-float') write(parts[0], read(parts[1]));
      else if (op === 'return-void') return undefined;
      else if (op === 'return-object' || op === 'return') return read(tail);
      else throw new Error(`unsupported production tab instruction ${descriptor}: ${instruction}`);
      if (jump) { assert.ok(method.labels.has(jump), `official tab label exists: ${jump}`); pc = method.labels.get(jump); }
      else pc += 1;
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
    match = line.match(/^\s*invoke-direct\s+\{([^}]+)\},\s*Lo0OO00Oo\/OooOOO;-><init>/);
    if (match) {
      const registers = match[1].split(',').map((value) => value.trim());
      const objectRegister = registers[0];
      const stringArgs = registers.slice(1).filter((register) => strings.has(register));
      const fragmentRegister = registers.slice(1).find((register) => types.has(register) && types.get(register) !== 'Lo0OO00Oo/OooOOO;');
      if (types.get(objectRegister) === 'Lo0OO00Oo/OooOOO;' && stringArgs.length >= 2 && fragmentRegister) {
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

function tabUiSnapshot(tab) {
  return {
    backgroundColor: tab.backgroundColor,
    selectedColor: tab.selectTextColor,
    unselectedColor: tab.unselectTextColor,
    backgroundImage: { visibility: tab.backgroundImage.visibility, drawable: tab.backgroundImage.drawable, imageResource: tab.backgroundImage.imageResource },
    tabs: tab.tabViews.map((view) => ({
      text: { size: view.title.textSize, color: view.title.textColor, alpha: tabAlphaValue(view.title.alpha), translationX: view.title.translationX },
      icon: { imageResource: view.icon.imageResource, visibility: view.icon.visibility },
    })),
    pageStyle: tab.pageStyle.at(-1),
  };
}

function tabAlphaValue(value) {
  if (Number.isInteger(value) && value > 1) {
    const buffer = new ArrayBuffer(4);
    new DataView(buffer).setUint32(0, value >>> 0, true);
    const decoded = new DataView(buffer).getFloat32(0, true);
    if (decoded >= 0 && decoded <= 1) return Math.round(decoded * 10) / 10;
  }
  return value;
}

function makeTabBinding(input) {
  const adapter = { kind: 'adapter', tabs: [{ id: 'schedule' }, { id: 'mine' }] };
  const pager = { adapter, currentItem: input.pageIndex, listeners: [], offscreenLimit: 0 };
  const pageStyle = [];
  const tabViews = adapter.tabs.map(() => {
    const title = { textSize: 14, textColor: 0, alpha: 0, translationX: -1 };
    const icon = { imageResource: 0, visibility: 0 };
    return { title, icon, views: new Map([[0x7f090abb, title], [0x7f0903cf, icon]]) };
  });
  const backgroundImage = { visibility: 0, drawable: input.drawable, imageResource: 0 };
  const tab = {
    kind: 'MainAiTitleTabView', adapter, viewPager: null, scheduleViewModel: null,
    llTab: { children: tabViews }, tabViews,
    llTab$delegate: { value: { children: tabViews } },
    tabDrawableImageView$delegate: { value: backgroundImage }, backgroundImage,
    tabDrawable: input.drawable, tabBackGround: input.background,
    titleTextColor: 0xff102030 | 0, mineTabItemColor: 0xff556677 | 0,
    nightTabItemColor: 0xff778899 | 0, nightTabColor: 0xff202830 | 0,
    defaultTabBg: 0xff345678 | 0, selectTextColor: 0, unselectTextColor: 0,
    onPageStyleChanged: { kind: 'Function2' }, backgroundColor: 0, pageStyle,
  };
  const world = {
    adapter, pager, tab, tabViews, preferenceNight: input.night, density: 1,
    scheduleSpUtils: {}, events: [], methodCalls: [], pageStyle, initialRefreshCalls: 0,
    modelBound: false, tabsBound: false, pagerBound: false, listenerAdded: false,
    inSetViewPager: true,
  };
  return world;
}

function expectedTabPalette(page, night, backgroundName, pageIndex) {
  let backgroundColor;
  let selectedColor;
  let unselectedColor;
  let pageStyleColor;
  if (page === 'schedule') {
    backgroundColor = backgroundName === 'existing color' ? (0xe001b669 | 0)
      : backgroundName === 'existing drawable' ? 0 : (0xff345678 | 0);
    selectedColor = 0xff102030 | 0;
    unselectedColor = 0x7a102030 | 0;
    pageStyleColor = 0xfff8f8fa | 0;
  } else if (night) {
    backgroundColor = 0xff202830 | 0;
    selectedColor = 0xff778899 | 0;
    unselectedColor = 0x7a778899 | 0;
    pageStyleColor = 0xff202830 | 0;
  } else {
    backgroundColor = 0xfff8f8fa | 0;
    selectedColor = 0xff556677 | 0;
    unselectedColor = 0x7a556677 | 0;
    pageStyleColor = 0xfff8f8fa | 0;
  }
  const drawable = backgroundName === 'existing drawable' ? { marker: 'existing schedule drawable' } : null;
  const tabText = (selected) => ({
    size: 16,
    color: selected ? selectedColor : unselectedColor,
    alpha: selected ? 1 : 0.8,
    translationX: 0,
  });
  return {
    backgroundColor,
    selectedColor,
    unselectedColor,
    backgroundImage: { visibility: page === 'schedule' && backgroundName === 'existing drawable' ? 0 : 8, drawable, imageResource: 0 },
    tabs: [
      { text: tabText(pageIndex === 0), icon: { imageResource: 0, visibility: 0 } },
      { text: tabText(pageIndex === 1), icon: { imageResource: 0, visibility: 0 } },
    ],
    pageStyle: [page, pageStyleColor],
  };
}

async function executeInitialTabBinding(root, source, input, expectedPalette) {
  const callbackSource = await readFile(path.join(root, listenerPath), 'utf8');
  const world = makeTabBinding(input);
  const descriptor = 'public final setViewPager(Landroidx/viewpager/widget/ViewPager;Lcom/suda/yzune/wakeupschedule/schedule/ScheduleViewModel;)V';
  const returned = tabExecuteMethod(source, callbackSource, descriptor, [world.tab, world.pager, { night: input.night }], world);
  assert.equal(returned, undefined, 'the real patched setViewPager reaches its return');
  assert.equal(world.initialRefreshCalls, 1, 'the production initial refresh runs exactly once');
  assert.deepEqual(world.events, ['tabs-bound', 'pager-bound', 'pager-configured', 'listener-added', 'initial-loadBackground']);
  assert.equal(world.pager.currentItem, input.pageIndex, 'initial refresh leaves the current page unchanged');
  assert.equal(world.pager.listeners.length, 1, 'initial refresh does not add a second listener');
  assert.equal(world.pager.offscreenLimit, world.adapter.tabs.length, 'the original pager limit remains based on adapter count');
  assert.ok(world.methodCalls.includes('updateTabItem') && world.methodCalls.includes('setSelectedTabUI'),
    'the official color update and selected-tab methods executed');
  if (input.pageIndex === 0) assert.ok(world.methodCalls.includes('updateTabBackGround'), 'schedule uses the official background path');
  const initial = tabUiSnapshot(world.tab);
  if (expectedPalette) assert.deepEqual(initial, expectedPalette, 'first setViewPager binding equals the independent literal palette');
  world.inSetViewPager = false;
  tabExecuteMethod(source, callbackSource, 'onPageSelected(I)V', [world.pager.listeners[0], input.pageIndex], world);
  const afterPageSelected = tabUiSnapshot(world.tab);
  assert.deepEqual(afterPageSelected, initial, 'the official onPageSelected callback yields the same output for the same page and inputs');
  if (expectedPalette) assert.deepEqual(afterPageSelected, expectedPalette, 'onPageSelected equals the same independent literal palette');
  assert.equal(world.pager.currentItem, input.pageIndex);
  assert.equal(world.pager.listeners.length, 1);
  tabExecuteMethod(source, callbackSource, 'public final loadBackground(Ljava/lang/String;I)V',
    [world.tab, '#112233', 0xffabcdef | 0], world);
  assert.equal(world.tab.tabBackGround, '#112233', 'the existing public loadBackground(String,int) method remains executable');
  assert.equal(world.tab.titleTextColor, 0xffabcdef | 0, 'the existing public refresh method retains its title color argument');
  return { world, initial, afterPageSelected };
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
  const calendarConstructor = onCreate.indexOf('invoke-direct {v5, v7, v8, v6}, Lo0OO00Oo/OooOOO;-><init>');
  const hiddenCalendarAdd = onCreate.indexOf('\n    nop\n', calendarConstructor);
  const calendarFragmentRead = onCreate.indexOf('invoke-virtual {v5}, Lo0OO00Oo/OooOOO;->OooO00o()', calendarConstructor);
  assert.ok(calendarConstructor >= 0 && hiddenCalendarAdd > calendarConstructor && calendarFragmentRead > hiddenCalendarAdd,
    'the calendar tab list insertion is replaced by nop while upstream fragment bookkeeping remains');
  assert.equal((onCreate.match(/const-string v7, "calendar"/g) ?? []).length, 1,
    'the upstream calendar metadata remains, while its list insertion is disabled');
  assert.doesNotMatch(onCreate, /invoke-virtual \{p1, v5\}, Ljava\/util\/ArrayList;->add\(Ljava\/lang\/Object;\)Z/,
    'the calendar object is not added to the home adapter');
  assert.equal((await readFile(path.join(baseline, 'smali_classes6/com/suda/yzune/wakeupschedule/aaa/calendar/ui/CalendarFragment.smali'), 'utf8')).includes('.class '), true,
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
  assert.doesNotMatch(onCreate, /invoke-virtual \{p1, v5\}, Ljava\/util\/ArrayList;->add\(Ljava\/lang\/Object;\)Z/);
  assert.doesNotMatch(onCreate, /OooOOo0\(\)Z/);
});

test('restored bottom_banner cannot select the HomeBannerController branch', async (t) => {
  const root = await patchedFixture(t);
  const onCreate = await readSmaliMethod(root, activityPath, activityClass, 'public onCreate(Landroid/os/Bundle;)V');
  const assignedFalse = onCreate.indexOf('iput-boolean v0, v1, Lcom/suda/yzune/wakeupschedule/schedule/ScheduleActivity;->o00OOOo:Z');
  const bannerBranch = onCreate.indexOf('iget-boolean v2, v1, Lcom/suda/yzune/wakeupschedule/schedule/ScheduleActivity;->o00OOOo:Z');
  const skipBanner = onCreate.indexOf('if-eqz v2, :cond_9', bannerBranch);
  const bannerCreate = onCreate.indexOf('new-instance p1, Lcom/suda/yzune/wakeupschedule/schedule/home/HomeBannerController;', skipBanner);
  const skipTarget = onCreate.indexOf('\n    :cond_9', skipBanner);
  assert.ok(assignedFalse >= 0 && bannerBranch > assignedFalse && skipBanner > bannerBranch && bannerCreate > skipBanner && skipTarget > bannerCreate);
  assert.match(onCreate, /invoke-virtual \{p1\}, Lcom\/suda\/yzune\/wakeupschedule\/schedule\/home\/HomeBannerController;->OooOOOO\(\)Landroid\/widget\/FrameLayout;/);
});

test('schedule and mine IDs resolve against the actual two tabs; all other IDs fall back to schedule', async (t) => {
  const root = await patchedFixture(t);
  const onCreate = await readSmaliMethod(root, activityPath, activityClass, 'public onCreate(Landroid/os/Bundle;)V');
  const tabs = extractTabAdditions(onCreate);
  const adapter = await readSmaliMethod(root, adapterPath, adapterClass, 'public final OooO00o(Ljava/lang/String;)I');
  const route = await readSmaliMethod(root, activityPath, activityClass, 'public final o0000oO0(Ljava/lang/String;)V');
  assert.match(adapter, /Iterable;->iterator\(\)[\s\S]*?const\/4 v2, -0x1[\s\S]*?const\/4 v3, 0x0/);
  assert.match(adapter, /OooOOO;->OooO0O0\(\)Ljava\/lang\/String;[\s\S]*?if-eqz v4, :cond_2[\s\S]*?return v3[\s\S]*?:cond_3[\s\S]*?return v2/);
  assert.match(route, /OooOOO0;->OooO00o\(Ljava\/lang\/String;\)I[\s\S]*?if-gez p1, :slim_v1_schedule_tab_resolved[\s\S]*?const-string p1, "schedule"[\s\S]*?setCurrentItem\(I\)V/);
  const resolve = (id) => {
    const found = tabs.findIndex((tab) => tab.id === id);
    return found >= 0 ? found : tabs.findIndex((tab) => tab.id === 'schedule');
  };
  for (const id of ['schedule', 'mine']) assert.equal(tabs[resolve(id)].id, id);
  for (const id of ['calendar', 'learn', 'assistant', 'unknown', '']) assert.equal(tabs[resolve(id)].id, 'schedule');
  assert.match(route, /const-string p1, "schedule"/);

  const initial = await readSmaliMethod(root, activityPath, activityClass, 'public final o0000OOo()V');
  const newIntent = await readSmaliMethod(root, activityPath, activityClass, 'public onNewIntent(Landroid/content/Intent;)V');
  assert.match(initial, /getIntent\(\)[\s\S]*?const-string v3, "select_tab_id"[\s\S]*?hasExtra\(Ljava\/lang\/String;\)Z[\s\S]*?getStringExtra\(Ljava\/lang\/String;\)/);
  assert.match(initial, /const-string v0, "schedule"[\s\S]*?o0000oO0\(Ljava\/lang\/String;\)V/);
  assert.match(newIntent, /getStringExtra\(Ljava\/lang\/String;\)[\s\S]*?if-nez p1, :cond_2[\s\S]*?const-string p1, "schedule"[\s\S]*?o0000oO0\(Ljava\/lang\/String;\)V/);
  assert.match(newIntent, /const-string v0, "only_select_tab"[\s\S]*?setIntent\(Landroid\/content\/Intent;\)V[\s\S]*?o0000OOo\(\)V/);
  assert.equal(/const-string v3, "select_tab_id"[\s\S]*?hasExtra\(Ljava\/lang\/String;\)Z[\s\S]*?getStringExtra\(Ljava\/lang\/String;\)/.test(initial), true,
    'the initial request key is prepared, checked for presence, then read');
  assert.equal(/getStringExtra[\s\S]*?if-nez p1, :cond_2[\s\S]*?const-string p1, "schedule"/.test(newIntent), true,
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
    const setter = /invoke-virtual \{p1, (v\d+)\}, Lcom\/baidu\/homework\/common\/ui\/widget\/NoScrollViewPager;->setNoScroll\(Z\)V/.exec(body);
    assert.ok(setter, 'production onCreate contains its NoScrollViewPager setter');
    const call = body.indexOf(setter[0]);
    const assignment = body.lastIndexOf('const/4 ' + setter[1] + ', 0x1', call);
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
  assert.match(loadTabs, /List;->size\(\)I[\s\S]*?move-result v0[\s\S]*?div-int\/2addr v2, v0[\s\S]*?Iterable;->iterator\(\)/);
  assert.match(loadTabs, /add-int\/lit8 v5, v4, 0x1[\s\S]*?OooOOO;->OooO0OO\(\)Ljava\/lang\/String;[\s\S]*?MainAiTitleTabView\$OooO0O0;-><init>\(Lcom\/suda\/yzune\/wakeupschedule\/widget\/MainAiTitleTabView;ILjava\/lang\/String;\)V/);
  assert.match(setViewPager, /OooOOO0;->OooO0O0\(\)Ljava\/util\/List;[\s\S]*?loadTabs\(Ljava\/util\/List;\)V[\s\S]*?getCount\(\)I/);
});

test('production initial tab refresh uses the official palette for every current page and later refresh path', async (t) => {
  const root = await patchedFixture(t);
  const source = await readFile(path.join(root, tabsPath), 'utf8');
  const backgrounds = [
    { name: 'default', background: '', drawable: null },
    { name: 'existing color', background: '#112233', drawable: null },
    { name: 'existing drawable', background: 'schedule-image', drawable: { marker: 'existing schedule drawable' } },
  ];
  for (const page of [{ id: 'schedule', pageIndex: 0 }, { id: 'mine', pageIndex: 1 }]) {
    for (const night of [false, true]) {
      for (const background of backgrounds) {
        const input = { ...page, night, ...background };
        const { world } = await executeInitialTabBinding(root, source, input,
          expectedTabPalette(page.id, night, background.name, page.pageIndex));
        assert.ok(world.methodCalls.includes('loadBackground') && world.methodCalls.includes('updateTabItem')
          && world.methodCalls.includes('setSelectedTabUI'), `${page.id}/${night}/${background.name} executes the official chain`);
      }
    }
  }
  const refreshCall = '    invoke-direct {p0}, Lcom/suda/yzune/wakeupschedule/widget/MainAiTitleTabView;->loadBackground()V\n';
  assert.equal((source.match(/invoke-direct \{p0\}, Lcom\/suda\/yzune\/wakeupschedule\/widget\/MainAiTitleTabView;->loadBackground\(\)V/g) ?? []).length, 4,
    'the patched binding adds one call while all three official refresh calls remain');
  const initialCallIndex = source.indexOf('invoke-virtual {p1, p2}, Landroidx/viewpager/widget/ViewPager;->addOnPageChangeListener');
  const insertedCallIndex = source.indexOf(refreshCall.trim(), initialCallIndex);
  assert.ok(initialCallIndex >= 0 && insertedCallIndex > initialCallIndex, 'the new production call follows listener registration');
  const mutantStart = source.indexOf(refreshCall.trim(), initialCallIndex);
  assert.ok(mutantStart > initialCallIndex, 'the inserted call is found after the listener anchor');
  const mutant = source.slice(0, mutantStart) + source.slice(mutantStart + refreshCall.trim().length);
  assert.notEqual(mutant, source, 'the isolated no-initial-refresh mutant removes the production invocation');
  const callbackSource = await readFile(path.join(root, listenerPath), 'utf8');
  const mutantWorld = makeTabBinding({ pageIndex: 0, night: false, background: '', drawable: null });
  assert.throws(() => {
    tabExecuteMethod(mutant, callbackSource,
      'public final setViewPager(Landroidx/viewpager/widget/ViewPager;Lcom/suda/yzune/wakeupschedule/schedule/ScheduleViewModel;)V',
      [mutantWorld.tab, mutantWorld.pager, { night: false }], mutantWorld);
    assert.equal(mutantWorld.initialRefreshCalls, 1, 'production initial refresh runs exactly once');
  }, /production initial refresh runs exactly once/, 'removing the initial refresh is detected by the real setViewPager execution');
});

test('joint offline/network patch keeps the two-tab home local and preserves only intended delayed work', async (t) => {
  const root = await patchedFixture(t, { joint: true });
  const onCreate = await readSmaliMethod(root, activityPath, activityClass, 'public onCreate(Landroid/os/Bundle;)V');
  const tabs = extractTabAdditions(onCreate);
  assert.equal(hasTwoHomeTabContract(onCreate, tabs), true, 'the joint patch retains only schedule and mine');
  const switches = await readSmaliMethod(root, switchesPath, switchesClass, 'public static final OooOOOO()Z');
  const callback = await readSmaliMethod(root, switchesPath, switchesClass, 'public static final OooOo0o(Landroid/content/Context;Lo000o0OO/OooO;)V');
  assert.match(switches, /const\/4 v0, 0x0\s+return v0/);
  assert.match(callback, /OooO00o\(Ljava\/lang\/Object;\)V[\s\S]*?return-void/);
  assert.doesNotMatch(callback, /enqueue|execute|startActivity|Http|Request|OooO0OO\(/);

  const localTasks = await readSmaliMethod(root, activityPath, activityClass, 'public final oo0o0Oo()V');
  assert.match(localTasks, /ScheduleActivity\$OooO0o;-><init>/);
  assert.match(localTasks, /ScheduleActivity\$OooO;-><init>/);
  assert.match(localTasks, /iget-object v4, p0, Lcom\/suda\/yzune\/wakeupschedule\/schedule\/ScheduleActivity;->o00Oo00:Lo0O0oO\/OooO0o;[\s\S]*?invoke-virtual \{v4, v2\}, Lo0O0oO\/OooO0o;->OooO0o\(\[Lcom\/homework\/launchmanager\/task\/OooO00o;\)/);
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
  assert.equal((onDestroy.match(/slimRemovePagerBounds\(\)V/g) ?? []).length, 1);
  const destroySuper = onDestroy.indexOf('invoke-super {p0}, Landroidx/appcompat/app/AppCompatActivity;->onDestroy()V');
  assert.ok(destroySuper >= 0);
  assert.ok(onDestroy.indexOf('slimRemovePagerBounds()V') < destroySuper);
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
