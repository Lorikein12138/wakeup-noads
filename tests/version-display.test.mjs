import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { applyPatchSpec } from '../scripts/patch.mjs';
import { readSmaliMethod } from './smali-helpers.mjs';

const decoded = path.resolve(process.env.SLIM_BASELINE_DECODED_ROOT ?? 'tools/_cache/slim-v1-decoded');
const cache = path.resolve('tools/_cache/slim-v1-review/fixtures/round-3');
const getterPath = 'smali_classes5/com/suda/yzune/wakeupschedule/BaseApplication$OooO00o.smali';
const settingsPath = 'smali_classes6/com/suda/yzune/wakeupschedule/settings/SettingsActivity.smali';
const adapterPath = 'smali_classes6/com/suda/yzune/wakeupschedule/settings/o00O000o.smali';
const providerPath = 'smali_classes6/oo0oO0/OooO0O0.smali';
const getterClass = 'Lcom/suda/yzune/wakeupschedule/BaseApplication$OooO00o;';
const settingsClass = 'Lcom/suda/yzune/wakeupschedule/settings/SettingsActivity;';
const adapterClass = 'Lcom/suda/yzune/wakeupschedule/settings/o00O000o;';
const bindDescriptor = 'public o0OOO0o(Lcom/chad/library/adapter/base/viewholder/BaseViewHolder;Lcom/suda/yzune/wakeupschedule/settings/items/OooO00o;)V';
const providerBindDescriptor = 'public OooOO0O(Lcom/chad/library/adapter/base/viewholder/BaseViewHolder;Lcom/suda/yzune/wakeupschedule/settings/items/OooO00o;)V';
const tagId = 0x7f130021;
const versionTitleId = 0x7f130021;

async function patchedFixture(t) {
  await mkdir(cache, { recursive: true });
  const root = await mkdtemp(path.join(cache, 'version-display-simulation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const relative of [getterPath, settingsPath, adapterPath, providerPath]) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(decoded, relative), target);
  }
  const fullSpec = JSON.parse(await readFile('patches/slim-v1/patch-spec.json', 'utf8'));
  const operations = fullSpec.operations.filter((operation) =>
    operation.id.startsWith('T23-E37-') || operation.id.startsWith('T23-E38-') || operation.id.startsWith('T32-E55-'));
  assert.equal(operations.length, 6, 'the four version-display and two E55 style operations are present');
  const specPath = path.join(root, 'fixture-spec.json');
  await writeFile(specPath, JSON.stringify({ schemaVersion: 1, applicationId: 'io.github.wakeupnoads', operations }));
  const result = await applyPatchSpec({ root, specPath, releaseName: 'wakeup-noads-v6.5.2-r1' });
  assert.equal(result.operations.length, 6);
  return root;
}

function methodBlock(content, descriptor) {
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === '.method ' + descriptor);
  assert.notEqual(start, -1, 'method exists: ' + descriptor);
  const end = lines.findIndex((line, index) => index > start && line.trim() === '.end method');
  assert.notEqual(end, -1, 'method closes: ' + descriptor);
  return lines.slice(start, end + 1).join('\n');
}

function labelValue(text) {
  if (text.startsWith('-0x')) return -Number.parseInt(text.slice(3), 16);
  if (text.startsWith('0x')) return Number.parseInt(text.slice(2), 16);
  return Number(text);
}

function floatFromBits(bits) {
  const buffer = new ArrayBuffer(4);
  new DataView(buffer).setUint32(0, bits >>> 0, true);
  return new DataView(buffer).getFloat32(0, true);
}

function asFloat(value) {
  return value && typeof value === 'object' && Number.isFinite(value.floatValue) ? value.floatValue : Number(value);
}

function registerIndex(register, localCount) {
  if (register[0] === 'v') return Number(register.slice(1));
  if (register[0] === 'p') return localCount + Number(register.slice(1));
  throw new Error('unsupported register name: ' + register);
}

function invocationRegisters(text, locals) {
  const body = text.slice(text.indexOf('{') + 1, text.indexOf('}')).trim();
  const pieces = body.split(',').map((part) => part.trim());
  if (pieces.length === 1 && pieces[0].includes('..')) {
    const [first, last] = pieces[0].split('..').map((part) => part.trim());
    const start = registerIndex(first, locals);
    const finish = registerIndex(last, locals);
    return Array.from({ length: finish - start + 1 }, (_, index) => start + index);
  }
  return pieces.map((register) => registerIndex(register, locals));
}

function parseInvocation(text) {
  const match = /^(invoke-(?:static|virtual|direct|super)(?:\/range)?)\s+\{[^}]*\},\s+(.+);->([^ (]+)(\(.*)$/.exec(text);
  if (!match) throw new Error('unsupported invoke syntax: ' + text);
  return { kind: match[1].replace('/range', ''), owner: match[2] + ';', method: match[3], descriptor: match[4] };
}

function parseMethod(content, descriptor) {
  const block = methodBlock(content, descriptor);
  const localsMatch = /^\s*\.(?:locals|registers)\s+(\d+)/m.exec(block);
  if (!localsMatch) throw new Error('method has no register declaration: ' + descriptor);
  const localCount = Number(localsMatch[1]);
  const instructions = [];
  const labels = new Map();
  let dataBlock = false;
  for (const raw of block.split(/\r?\n/).slice(1, -1)) {
    const line = raw.trim();
    if (!line || line.startsWith('.line ') || line.startsWith('.param ') || line.startsWith('.locals ') || line.startsWith('.registers ') || line.startsWith('.prologue') || line.startsWith('.catch')) continue;
    if (line.startsWith(':')) {
      labels.set(line, instructions.length);
      continue;
    }
    if (line.startsWith('.array-data') || line.startsWith('.packed-switch') || line.startsWith('.sparse-switch')) { dataBlock = true; continue; }
    if (line.startsWith('.end array-data') || line.startsWith('.end packed-switch') || line.startsWith('.end sparse-switch')) { dataBlock = false; continue; }
    if (dataBlock) continue;
    if (line.startsWith('.')) throw new Error('unsupported directive in executed method ' + descriptor + ': ' + line);
    instructions.push(line);
  }
  return { descriptor, localCount, instructions, labels };
}

function lpCopy(value) {
  const copy = { ...value };
  if (value.margins) copy.margins = { ...value.margins };
  return copy;
}

function createProviderHolder({ density = 1, innerOrientation = 0, padding = [0, 0, 0, 0], theme = 'light', group = 'middle' } = {}) {
  const margin = Math.trunc(16 * density);
  const outer = {
    id: 'itemView',
    kind: 'outer',
    orientation: 1,
    layoutParams: { width: -1, height: -2, margins: { start: margin, end: margin, top: 0, bottom: 0 }, gravity: -1 },
    background: 'baseline-' + theme + '-' + group,
    divider: { id: 0x7f0900ab, marker: 'provider-divider' },
    eventState: { clickListener: 'ordinary-listener', longClickListener: 'ordinary-long-listener', clickable: true, longClickable: true, enabled: true },
    minimumHeight: 0,
    padding: [0, 0, 0, 0]
  };
  const context = { resources: { displayMetrics: { density } } };
  const inner = {
    id: 0x7f090099, kind: 'linear', context, orientation: innerOrientation,
    layoutParams: { width: -1, height: Math.trunc(64 * density), weight: 0, margins: { start: 0, end: 0, top: 0, bottom: 0 }, gravity: -1 },
    minimumHeight: 0, padding: [...padding], tags: new Map()
  };
  const title = {
    id: 0x7f0900ae, kind: 'text', context, text: '', textSize: 16, typeface: 'default-bold-' + theme,
    textColor: 'theme-title-' + theme, gravity: 16,
    layoutParams: { width: 0, height: -2, weight: 1, margins: { start: margin, end: margin, top: 0, bottom: 0 }, gravity: -1 },
    minLines: 1, maxLines: 1, maxWidth: 2147483647, ellipsize: null
  };
  const value = {
    id: 0x7f0900d9, kind: 'text', context, text: '', textSize: 14, typeface: 'default-' + theme,
    textColor: 'theme-value-' + theme, gravity: 16,
    layoutParams: { width: -2, height: -2, weight: 0, margins: { start: margin, end: margin, top: 0, bottom: 0 }, gravity: -1 },
    minLines: 1, maxLines: 1, maxWidth: Math.trunc(200 * density), ellipsize: null
  };
  const holder = { itemView: outer, views: new Map([[0x7f090099, inner], [0x7f0900ae, title], [0x7f0900d9, value]]), lookupCount: 0 };
  outer.children = [inner, outer.divider];
  return holder;
}

function viewStyle(holder) {
  const inner = holder.views.get(0x7f090099);
  const title = holder.views.get(0x7f0900ae);
  const value = holder.views.get(0x7f0900d9);
  return {
    outer: { orientation: holder.itemView.orientation, layoutParams: lpCopy(holder.itemView.layoutParams), background: holder.itemView.background, divider: holder.itemView.divider, eventState: { ...holder.itemView.eventState } },
    inner: { orientation: inner.orientation, layoutParams: lpCopy(inner.layoutParams), minimumHeight: inner.minimumHeight, padding: [...inner.padding] },
    title: { layoutParams: lpCopy(title.layoutParams), minLines: title.minLines, maxLines: title.maxLines, maxWidth: title.maxWidth, ellipsize: title.ellipsize, textSize: title.textSize, typeface: title.typeface, textColor: title.textColor, gravity: title.gravity },
    value: { layoutParams: lpCopy(value.layoutParams), minLines: value.minLines, maxLines: value.maxLines, maxWidth: value.maxWidth, ellipsize: value.ellipsize, textSize: value.textSize, typeface: value.typeface, textColor: value.textColor, gravity: value.gravity }
  };
}

function makeItem({ type = 1, titleId = 0x7f130020, title = 'Ordinary', value = 'Setting value', visible = true, group = 'middle' } = {}) {
  return { type, titleId, title, value, visible, group };
}

function methodDescriptorFor(methodName, source) {
  const line = source.split(/\r?\n/).find((candidate) => candidate.startsWith('.method ') && candidate.includes(' ' + methodName + '('));
  if (!line) throw new Error('missing helper method: ' + methodName);
  return line.trim().slice('.method '.length);
}

function readField(owner, field, object) {
  if (field === 'density') return { floatValue: object.density };
  if (field in object) return object[field];
  throw new Error('unsupported iget field ' + owner + '->' + field);
}

function writeField(owner, field, object, value) {
  object[field] = field === 'weight' ? asFloat(value) : Number(value);
}

function dispatchInvocation(sources, target, args, world) {
  const method = target.method;
  const owner = target.owner;
  if (target.kind === 'invoke-super' && method === 'OooOoO' && owner === 'Lcom/chad/library/adapter/base/BaseProviderMultiAdapter;') {
    if (args[2].type === 1) {
      return executeMethod(sources.provider, providerBindDescriptor, [{ provider: true }, args[1], args[2]], world);
    }
    return undefined;
  }
  if (owner === 'Lkotlin/jvm/internal/o00oO0o;' && method === 'OooO0oO') return undefined;
  if (owner === 'Ljava/lang/Integer;' && method === 'valueOf') return Number(args[0]);
  if (owner === 'Ljava/lang/Integer;' && method === 'intValue') return Number(args[0]);
  if (owner === 'Lcom/chad/library/adapter/base/viewholder/BaseViewHolder;') {
    const holder = args[0];
    if (method === 'getView') {
      holder.lookupCount += 1;
      return holder.views.get(Number(args[1])) ?? null;
    }
    if (method === 'setText' && target.descriptor === '(II)Lcom/chad/library/adapter/base/viewholder/BaseViewHolder;') {
      const view = holder.views.get(Number(args[1]));
      if (view) view.text = view.id === 0x7f0900ae ? holder.currentItem.title : String(args[2]);
      return holder;
    }
    if (method === 'setText' && target.descriptor === '(ILjava/lang/CharSequence;)Lcom/chad/library/adapter/base/viewholder/BaseViewHolder;') {
      const view = holder.views.get(Number(args[1]));
      if (view) view.text = String(args[2]);
      return holder;
    }
  }
  if (owner === 'Lcom/suda/yzune/wakeupschedule/settings/items/OooO00o;') {
    const item = args[0];
    if (method === 'OooO0Oo') return item.type;
    if (method === 'OooO0OO') return item.titleId;
    if (method === 'OooO0O0') return item.visible;
    if (method === 'OooOOoo') return item.value;
  }
  if (owner === 'Lcom/suda/yzune/wakeupschedule/settings/items/OooO0o;' && method === 'OooOOoo') return args[0].value;
  if (method === '<init>' && owner === 'Landroidx/appcompat/widget/LinearLayoutCompat$LayoutParams;') {
    Object.assign(args[0], lpCopy(args[1]));
    return undefined;
  }
  if (owner === 'Landroidx/appcompat/widget/LinearLayoutCompat;' && method === 'getOrientation') return args[0].orientation;
  if (owner === 'Landroidx/appcompat/widget/LinearLayoutCompat;' && method === 'setOrientation') {
    args[0].orientation = Number(args[1]);
    return undefined;
  }
  if (owner === 'Landroid/view/View;' || owner === 'Landroidx/appcompat/widget/LinearLayoutCompat;' || owner === 'Landroid/widget/TextView;') {
    const view = args[0];
    if (method === 'getTag') return view.tags?.get(Number(args[1])) ?? null;
    if (method === 'setTag') {
      view.tags.set(Number(args[1]), args[2]);
      return undefined;
    }
    if (method === 'getLayoutParams') return view.layoutParams;
    if (method === 'setLayoutParams') {
      view.layoutParams = args[1];
      return undefined;
    }
    if (method === 'getMinimumHeight') return view.minimumHeight;
    if (method === 'setMinimumHeight') {
      view.minimumHeight = Number(args[1]);
      return undefined;
    }
    if (method === 'getPaddingLeft') return view.padding[0];
    if (method === 'getPaddingTop') return view.padding[1];
    if (method === 'getPaddingRight') return view.padding[2];
    if (method === 'getPaddingBottom') return view.padding[3];
    if (method === 'setPadding') {
      view.padding = args.slice(1, 5).map(Number);
      return undefined;
    }
    if (method === 'getContext') return view.context;
    if (method === 'getMinLines') return view.minLines;
    if (method === 'setMinLines') {
      view.minLines = Number(args[1]);
      return undefined;
    }
    if (method === 'getMaxLines') return view.maxLines;
    if (method === 'setMaxLines') {
      view.maxLines = Number(args[1]);
      return undefined;
    }
    if (method === 'getMaxWidth') return view.maxWidth;
    if (method === 'setMaxWidth') {
      view.maxWidth = Number(args[1]);
      return undefined;
    }
    if (method === 'getEllipsize') return view.ellipsize;
    if (method === 'setEllipsize') {
      view.ellipsize = args[1] === 0 ? null : args[1];
      return undefined;
    }
    if (method === 'setText') {
      view.text = String(args.at(-1));
      return undefined;
    }
  }
  if (owner === 'Landroid/content/Context;' && method === 'getResources') return args[0].resources;
  if (owner === 'Landroid/content/res/Resources;' && method === 'getDisplayMetrics') return args[0].displayMetrics;
  throw new Error('unsupported invoke in restricted Smali fixture: ' + target.kind + ' ' + owner + '->' + method + target.descriptor);
}

function invokeSmali(sources, instruction, world) {
  const target = parseInvocation(instruction);
  const registers = invocationRegisters(instruction, world.currentLocalCount);
  const args = registers.map((index) => world.registers[index]);
  if (target.kind === 'invoke-static' && target.owner === adapterClass) {
    const descriptor = methodDescriptorFor(target.method, sources.adapter);
    const result = executeMethod(sources.adapter, descriptor, args, world);
    if (target.method === 'slimApplyType1Style' && world.inAdapterBind) world.styleApplied = true;
    return result;
  }
  return dispatchInvocation(sources, target, args, world);
}

function executeMethod(source, descriptor, args, world) {
  const method = parseMethod(source, descriptor);
  const registers = Array(method.localCount + args.length + 4).fill(null);
  args.forEach((value, index) => { registers[method.localCount + index] = value; });
  const previousRegisters = world.registers;
  const previousLocalCount = world.currentLocalCount;
  world.registers = registers;
  world.currentLocalCount = method.localCount;
  let pc = 0;
  let steps = 0;
  try {
    while (pc < method.instructions.length) {
      if (++steps > 2000) throw new Error('restricted Smali fixture exceeded its instruction bound in ' + descriptor);
      const instruction = method.instructions[pc];
      const parts = instruction.split(/\s+/);
      const op = parts[0];
      const tail = instruction.slice(op.length).trim();
      const commaParts = tail.split(',').map((part) => part.trim());
      const read = (operand) => {
        if (/^[vp]\d+$/.test(operand)) return registers[registerIndex(operand, method.localCount)];
        return labelValue(operand);
      };
      const write = (register, value) => { registers[registerIndex(register, method.localCount)] = value; };
      let jump = null;
      if (/^const(?:\/4|\/16|\/high16)?$/.test(op)) {
        const [dest, literal] = commaParts;
        const parsed = labelValue(literal);
        write(dest, op === 'const/high16' ? { floatValue: floatFromBits(parsed) } : parsed);
      } else if (op === 'const-string') {
        const match = /^(\S+),\s*"([\s\S]*)"$/.exec(tail);
        if (!match) throw new Error('unsupported const-string: ' + instruction);
        write(match[1], match[2]);
      } else if (op === 'new-array') {
        const [dest, size] = commaParts;
        write(dest, Array(Number(read(size))).fill(null));
      } else if (op === 'new-instance') {
        const match = /^(\S+),\s+(.+)$/.exec(tail);
        if (!match || match[2] !== 'Landroidx/appcompat/widget/LinearLayoutCompat$LayoutParams;') throw new Error('unsupported new-instance: ' + instruction);
        write(match[1], {});
      } else if (op === 'move' || op === 'move-object') {
        const [dest, sourceRegister] = commaParts;
        write(dest, read(sourceRegister));
      } else if (op === 'move-result' || op === 'move-result-object') {
        write(commaParts[0], world.lastResult);
        world.lastResult = undefined;
      } else if (op.startsWith('invoke-')) {
        world.lastResult = invokeSmali(world.sources, instruction, world);
      } else if (op === 'check-cast') {
        // Explicitly modeled as a reference-preserving cast in this restricted fixture.
      } else if (op === 'if-eqz' || op === 'if-nez') {
        const [value, label] = commaParts;
        const v = read(value);
        const isZero = v === null || v === undefined || v === false || v === 0;
        if (op === 'if-eqz' ? isZero : !isZero) jump = label;
      } else if (op === 'if-ne' || op === 'if-eq') {
        const [left, right, label] = commaParts;
        const equal = read(left) === read(right);
        if (op === 'if-ne' ? !equal : equal) jump = label;
      } else if (op === 'goto' || op === 'goto/16' || op === 'goto/32') {
        jump = tail;
      } else if (op === 'iget' || op === 'iget-object') {
        const [dest, objectRegister, fieldRef] = commaParts;
        const match = /^(.+);->([^:]+):(.+)$/.exec(fieldRef);
        if (!match) throw new Error('unsupported iget syntax: ' + instruction);
        write(dest, readField(match[1] + ';', match[2], read(objectRegister)));
      } else if (op === 'iput') {
        const [sourceRegister, objectRegister, fieldRef] = commaParts;
        const match = /^(.+);->([^:]+):(.+)$/.exec(fieldRef);
        if (!match) throw new Error('unsupported iput syntax: ' + instruction);
        writeField(match[1] + ';', match[2], read(objectRegister), read(sourceRegister));
      } else if (op === 'aput-object') {
        const [sourceRegister, arrayRegister, indexRegister] = commaParts;
        read(arrayRegister)[Number(read(indexRegister))] = read(sourceRegister);
      } else if (op === 'aget-object') {
        const [dest, arrayRegister, indexRegister] = commaParts;
        write(dest, read(arrayRegister)[Number(read(indexRegister))]);
      } else if (op === 'mul-float/2addr') {
        const [dest, sourceRegister] = commaParts;
        write(dest, { floatValue: Math.fround(asFloat(read(dest)) * asFloat(read(sourceRegister))) });
      } else if (op === 'float-to-int') {
        const [dest, sourceRegister] = commaParts;
        write(dest, Math.trunc(asFloat(read(sourceRegister))));
      } else if (op === 'return-void') {
        return undefined;
      } else if (op === 'return-object' || op === 'return') {
        return read(tail);
      } else {
        throw new Error('unsupported Smali instruction in restricted fixture: ' + descriptor + ': ' + instruction);
      }
      if (jump) {
        if (!method.labels.has(jump)) throw new Error('unknown label ' + jump + ' in ' + descriptor);
        pc = method.labels.get(jump);
        continue;
      }
      if (descriptor === bindDescriptor && world.styleApplied && op === 'iput' && instruction.includes('ViewGroup$LayoutParams;->height:I')) {
        return { stoppedAt: 'existing visible outer-height update' };
      }
      pc += 1;
    }
    return undefined;
  } finally {
    world.registers = previousRegisters;
    world.currentLocalCount = previousLocalCount;
  }
}

async function readFixtureSources(root) {
  return {
    getter: await readFile(path.join(root, getterPath), 'utf8'),
    settings: await readFile(path.join(root, settingsPath), 'utf8'),
    adapter: await readFile(path.join(root, adapterPath), 'utf8'),
    provider: await readFile(path.join(root, providerPath), 'utf8')
  };
}

function makeWorld(sources, holder, item) {
  holder.currentItem = item;
  return { sources, registers: [], currentLocalCount: 0, lastResult: undefined, styleApplied: false, inAdapterBind: true };
}

async function bind(root, holder, item, adapterOverride = null) {
  const sources = await readFixtureSources(root);
  if (adapterOverride) sources.adapter = adapterOverride;
  const world = makeWorld(sources, holder, item);
  const output = executeMethod(sources.adapter, bindDescriptor, [{ adapter: true }, holder, item], world);
  return { world, output, sources };
}

function assertProviderFixture(providerSource) {
  const type = methodBlock(providerSource, 'public OooO0Oo()I');
  const create = methodBlock(providerSource, 'public OooO0o0(Landroid/view/ViewGroup;I)Lcom/chad/library/adapter/base/viewholder/BaseViewHolder;');
  const bindMethod = methodBlock(providerSource, providerBindDescriptor);
  assert.match(type, /const\/4 v0, 0x1/);
  assert.match(create, /0x7f090099[\s\S]*?0x7f0900ae[\s\S]*?0x7f0900d9/);
  assert.match(create, /LinearLayoutCompat;->setOrientation\(I\)V/);
  assert.match(create, /const\/16 v\d+, 0x40[\s\S]*?float-to-int[\s\S]*?LayoutParams;-><init>\(II\)V/);
  assert.match(create, /setLines\(I\)V/);
  assert.match(create, /setMaxWidth\(I\)V/);
  assert.match(bindMethod, /BaseViewHolder;->setText\(II\)/);
  assert.match(bindMethod, /BaseViewHolder;->setText\(ILjava\/lang\/CharSequence;\)/);
}

function assertT32Contract(adapterSource, providerSource) {
  assertProviderFixture(providerSource);
  const binder = methodBlock(adapterSource, bindDescriptor);
  assert.match(binder, /\.locals 13/);
  const visible = binder.indexOf(':cond_0');
  const styleCall = binder.indexOf('->slimApplyType1Style(');
  const outerSetup = binder.indexOf('iget-object v9, p1, Landroidx/recyclerview/widget/RecyclerView$ViewHolder;->itemView');
  assert.ok(visible >= 0 && visible < styleCall && styleCall < outerSetup, 'visible style helper runs before original outer/background logic');
  assert.match(binder, /if-nez v9, :cond_0[\s\S]*?iput v10, p1, Landroid\/view\/ViewGroup\$LayoutParams;->height:I[\s\S]*?return-void/);
  const styleMethod = methodBlock(adapterSource, 'private static slimApplyType1Style(Lcom/chad/library/adapter/base/viewholder/BaseViewHolder;Lcom/suda/yzune/wakeupschedule/settings/items/OooO00o;)V');
  assert.ok(styleMethod.indexOf('OooO0Oo()I') < styleMethod.indexOf('BaseViewHolder;->getView(I)'), 'type is checked before child lookup');
  assert.ok(styleMethod.indexOf('slimRestoreType1Style') < styleMethod.indexOf('OooO0OO()I'), 'every visible type1 bind restores before checking the version title');
  for (const id of ['0x7f090099', '0x7f0900ae', '0x7f0900d9']) assert.ok(styleMethod.includes(id));
  assert.match(adapterSource, /getTag\(I\)Ljava\/lang\/Object;/);
  assert.match(adapterSource, /setTag\(ILjava\/lang\/Object;\)V/);
  const helperEnd = adapterSource.slice(adapterSource.indexOf('.method private static slimApplyType1Style'));
  assert.doesNotMatch(helperEnd, /setOnClickListener\(Landroid\/view\/View\$OnClickListener;\)V|setClickable\(Z\)V|setLongClickable\(Z\)V|setEnabled\(Z\)V/);
  assert.doesNotMatch(helperEnd, /->setText\(|->setVisibility\(|->setBackground\(|itemView/);
  assert.match(helperEnd, /setMinLines\(I\)V/);
  assert.match(helperEnd, /setMaxLines\(I\)V/);
  assert.match(helperEnd, /setMaxWidth\(I\)V/);
  assert.match(helperEnd, /setEllipsize\(Landroid\/text\/TextUtils\$TruncateAt;\)V/);
  assert.match(helperEnd, /0x42800000/);
  assert.match(helperEnd, /0x41800000/);
  const versionStyle = methodBlock(adapterSource, 'private static slimApplyVersionStyle(Landroidx/appcompat/widget/LinearLayoutCompat;Landroid/widget/TextView;Landroid/widget/TextView;)V');
  assert.equal((versionStyle.match(/->setOrientation\(I\)V/g) ?? []).length, 1);
  assert.match(versionStyle, /setOrientation\(I\)V/);
  assert.match(versionStyle, /->width:I/);
  assert.match(versionStyle, /->height:I/);
  assert.match(versionStyle, /->weight:F/);
  assert.doesNotMatch(helperEnd, /getTag\(\)Ljava\/lang\/Object;|setTag\(Ljava\/lang\/Object;\)V/);
}

function createInitialItem(density, innerOrientation, padding, theme, group) {
  return createProviderHolder({ density, innerOrientation, padding, theme, group });
}

async function versionMutationFails(root, mutant, check) {
  const holder = createInitialItem(1.25, 0, [2, 4, 6, 8], 'dark', 'middle');
  await bind(root, holder, makeItem({ titleId: versionTitleId, value: 'release value' }), mutant);
  assert.throws(() => check(holder));
}

async function recycleMutationFails(root, mutant, check) {
  const holder = createInitialItem(1.25, 0, [2, 4, 6, 8], 'dark', 'middle');
  const baseline = viewStyle(holder);
  await bind(root, holder, makeItem({ titleId: versionTitleId, value: 'release value' }), mutant);
  await bind(root, holder, makeItem({ title: 'ordinary' }), mutant);
  assert.throws(() => check(holder, baseline));
}

test('the version getter keeps PackageInfo reads and uses releaseName for both fallbacks', async (t) => {
  const baseline = await readSmaliMethod(decoded, getterPath, getterClass, 'public final OooO()Ljava/lang/String;');
  const root = await patchedFixture(t);
  const patched = await readSmaliMethod(root, getterPath, getterClass, 'public final OooO()Ljava/lang/String;');
  assert.match(baseline, /getPackageInfo/);
  assert.match(patched, /getPackageInfo/);
  assert.match(patched, /PackageInfo;->versionName:Ljava\/lang\/String;/);
  assert.equal((patched.match(/wakeup-noads-v6\.5\.2-r1/g) ?? []).length, 2);
  assert.doesNotMatch(patched, /6\.5\.1/);
});

test('global settings appends a read-only current-version item that calls the shared getter', async (t) => {
  const root = await patchedFixture(t);
  const list = await readSmaliMethod(root, settingsPath, settingsClass, 'private final oo0o0Oo(Ljava/util/List;)V');
  const click = await readSmaliMethod(root, settingsPath, settingsClass, 'private final o0OO00O(Lcom/suda/yzune/wakeupschedule/settings/items/OooO0o;I)V');
  assert.equal((list.match(/0x7f130021/g) ?? []).length, 1);
  assert.match(list, /settings\/items\/OooO0o;-><init>\(ILjava\/lang\/String;Ljava\/util\/List;\)V/);
  assert.match(list, /BaseApplication\$OooO00o;->OooO\(\)Ljava\/lang\/String;/);
  assert.match(click, /move\/from16 v1, p2\s+if-ne v1, v0, :slim_version_click_continue\s+return-void\s+:slim_version_click_continue/);
  assert.doesNotMatch(click.slice(0, click.indexOf(':slim_version_click_continue')), /startActivity|invoke-interface .*RequestQueue|SharedPreferences;->edit/);
});

test('the existing long-press handler consumes ordinary version items without starting an action', async () => {
  const handler = await readSmaliMethod(decoded, settingsPath, settingsClass, 'public static final o0Oo0oo(Lcom/suda/yzune/wakeupschedule/settings/SettingsActivity;Lcom/chad/library/adapter/base/BaseQuickAdapter;Landroid/view/View;I)Z');
  assert.match(handler, /instance-of p2, p1, Lcom\/suda\/yzune\/wakeupschedule\/settings\/items\/OooOOO;/);
  assert.match(handler, /const\/4 p0, 0x1[\s\S]*?return p0/);
  assert.doesNotMatch(handler, /startActivity|RequestQueue|SharedPreferences;->edit/);
});

test('actual visible E55 binding executes E54 text binding and helper, restoring independent per-holder style', async (t) => {
  const root = await patchedFixture(t);
  const sources = await readFixtureSources(root);
  assertT32Contract(sources.adapter, sources.provider);

  const holder = createInitialItem(1.25, 0, [3, 5, 7, 9], 'dark', 'first');
  const baseline = viewStyle(holder);
  const ordinary = makeItem({ titleId: 0x7f130020, title: 'Ordinary row', value: 'old value', group: 'first' });
  const result = await bind(root, holder, ordinary);
  assert.equal(result.world.styleApplied, true);
  assert.deepEqual(viewStyle(holder), baseline);
  assert.equal(holder.views.get(0x7f0900ae).text, 'Ordinary row');
  assert.equal(holder.views.get(0x7f0900d9).text, 'old value');
  assert.deepEqual(holder.itemView.eventState, baseline.outer.eventState);
  assert.equal(holder.itemView.orientation, 1);

  await bind(root, holder, makeItem({ titleId: versionTitleId, title: 'Current version', value: 'wakeup-noads-v6.5.2-r1' }));
  const inner = holder.views.get(0x7f090099);
  const title = holder.views.get(0x7f0900ae);
  const value = holder.views.get(0x7f0900d9);
  const snapshot = inner.tags.get(tagId);
  assert.ok(Array.isArray(snapshot));
  assert.equal(snapshot.length, 17);
  assert.equal(inner.orientation, 1);
  assert.equal(inner.layoutParams.height, -2);
  assert.equal(inner.minimumHeight, Math.trunc(64 * 1.25));
  assert.deepEqual(inner.padding, [3, Math.trunc(16 * 1.25), 7, Math.trunc(16 * 1.25)]);
  for (const text of [title, value]) {
    assert.equal(text.layoutParams.width, -1);
    assert.equal(text.layoutParams.height, -2);
    assert.equal(text.layoutParams.weight, 0);
    assert.equal(text.minLines, 1);
    assert.equal(text.maxLines, 2147483647);
    assert.equal(text.maxWidth, 2147483647);
    assert.equal(text.ellipsize, null);
  }
  assert.equal(title.layoutParams.margins.start, baseline.title.layoutParams.margins.start);
  assert.equal(value.layoutParams.margins.end, baseline.value.layoutParams.margins.end);
  assert.equal(title.textSize, baseline.title.textSize);
  assert.equal(title.typeface, baseline.title.typeface);
  assert.equal(title.textColor, baseline.title.textColor);
  assert.equal(value.textSize, baseline.value.textSize);
  assert.equal(value.typeface, baseline.value.typeface);
  assert.equal(value.textColor, baseline.value.textColor);
  assert.equal(holder.itemView.orientation, 1);
  assert.equal(holder.itemView.divider.marker, 'provider-divider');
  assert.deepEqual(holder.itemView.eventState, baseline.outer.eventState);
  assert.equal(title.text, 'Current version');
  assert.equal(value.text, 'wakeup-noads-v6.5.2-r1');

  const savedInnerParams = lpCopy(snapshot[1]);
  await bind(root, holder, makeItem({ titleId: versionTitleId, title: 'Current version', value: 'second version text' }));
  assert.equal(inner.tags.get(tagId), snapshot, 'repeated version binds reuse the first snapshot');
  assert.deepEqual(snapshot[1], savedInnerParams, 'version style never mutates the saved LayoutParams copy');
  assert.deepEqual(inner.padding, [3, 20, 7, 20], 'padding is restored before applying dp values, so it does not accumulate');
  assert.equal(value.text, 'second version text');

  await bind(root, holder, makeItem({ titleId: 0x7f130020, title: 'Next ordinary row', value: 'new ordinary value' }));
  assert.deepEqual(viewStyle(holder), baseline, 'ordinary type1 restores all recorded fields');
  assert.equal(title.text, 'Next ordinary row', 'provider text is not restored from the snapshot');
  assert.equal(value.text, 'new ordinary value');
  assert.deepEqual(holder.itemView.eventState, baseline.outer.eventState);
});

test('two holders, first/middle/last groups, hidden recycling, and non-type1 rows stay isolated', async (t) => {
  const root = await patchedFixture(t);
  const holderA = createInitialItem(1, 0, [1, 2, 3, 4], 'light', 'first');
  const holderB = createInitialItem(1.5, 1, [6, 7, 8, 9], 'dark', 'last');
  const baseA = viewStyle(holderA);
  const baseB = viewStyle(holderB);
  await bind(root, holderA, makeItem({ titleId: versionTitleId, value: 'version A', group: 'first' }));
  await bind(root, holderB, makeItem({ titleId: versionTitleId, value: 'version B', group: 'last' }));
  assert.notEqual(holderA.views.get(0x7f090099).tags.get(tagId), holderB.views.get(0x7f090099).tags.get(tagId));
  assert.equal(holderA.itemView.orientation, 1);
  assert.equal(holderB.itemView.orientation, 1);
  await bind(root, holderA, makeItem({ title: 'middle ordinary', group: 'middle' }));
  await bind(root, holderB, makeItem({ title: 'last ordinary', group: 'last' }));
  assert.deepEqual(viewStyle(holderA), baseA);
  assert.deepEqual(viewStyle(holderB), baseB);

  const hiddenHolder = createInitialItem(2, 0, [0, 0, 0, 0], 'light', 'middle');
  const hiddenBaseline = viewStyle(hiddenHolder);
  await bind(root, hiddenHolder, makeItem({ titleId: versionTitleId, value: 'version before hidden' }));
  const versionPadding = [...hiddenHolder.views.get(0x7f090099).padding];
  await bind(root, hiddenHolder, makeItem({ title: 'hidden ordinary', visible: false }));
  assert.equal(hiddenHolder.itemView.layoutParams.height, 0);
  assert.deepEqual(hiddenHolder.views.get(0x7f090099).padding, versionPadding);
  await bind(root, hiddenHolder, makeItem({ title: 'visible ordinary', visible: true }));
  assert.deepEqual(viewStyle(hiddenHolder), hiddenBaseline);

  const other = createInitialItem(1.25, 0, [0, 0, 0, 0], 'dark', 'last');
  const beforeOther = viewStyle(other);
  const otherResult = await bind(root, other, makeItem({ type: 2, titleId: versionTitleId, value: 'not type1' }));
  assert.equal(otherResult.world.styleApplied, true);
  assert.equal(other.lookupCount, 0, 'non-type1 exits before provider-specific child lookup');
  assert.deepEqual(viewStyle(other), beforeOther);
  for (const group of ['first', 'middle', 'last']) {
    const grouped = createInitialItem(1, 0, [0, 0, 0, 0], 'light', group);
    const baseline = viewStyle(grouped);
    await bind(root, grouped, makeItem({ group }));
    assert.deepEqual(viewStyle(grouped), baseline);
  }
});

test('design10 breakage mutants are rejected by the executed fixture and source guards', async (t) => {
  const root = await patchedFixture(t);
  const original = await readFile(path.join(root, adapterPath), 'utf8');
  const providerSource = await readFile(path.join(root, providerPath), 'utf8');

  const noRestore = original.replace(
    /    invoke-static\/range \{v1 \.\. v4\}, Lcom\/suda\/yzune\/wakeupschedule\/settings\/o00O000o;->slimRestoreType1Style[^\r\n]*\r?\n/,
    ''
  );
  await recycleMutationFails(root, noRestore, (holder, baseline) => assert.deepEqual(viewStyle(holder), baseline));

  const wrongSavedOrientation = original.replace(
    /    invoke-virtual \{p0\}, Landroidx\/appcompat\/widget\/LinearLayoutCompat;->getOrientation\(\)I\r?\n    move-result v4/,
    '    const/4 v4, 0x1'
  );
  await recycleMutationFails(root, wrongSavedOrientation, (holder, baseline) => assert.deepEqual(viewStyle(holder), baseline));

  const aliasedSnapshot = original.replace(
    /\.method private static slimCopyType1Params[\s\S]*?\.end method/,
    '.method private static slimCopyType1Params(Landroid/view/ViewGroup$MarginLayoutParams;)Landroidx/appcompat/widget/LinearLayoutCompat$LayoutParams;\n    .locals 0\n    return-object p0\n.end method'
  );
  await recycleMutationFails(root, aliasedSnapshot, (holder, baseline) => assert.deepEqual(viewStyle(holder), baseline));

  const titleNoWeightReset = original.replace(/    iput v2, v1, Landroidx\/appcompat\/widget\/LinearLayoutCompat\$LayoutParams;->weight:F\r?\n/, '');
  await versionMutationFails(root, titleNoWeightReset, (holder) => assert.equal(holder.views.get(0x7f0900ae).layoutParams.weight, 0));

  const valueNoMaxWidth = original.replace(/    invoke-virtual \{p2, v3\}, Landroid\/widget\/TextView;->setMaxWidth\(I\)V\r?\n/, '');
  await versionMutationFails(root, valueNoMaxWidth, (holder) => assert.equal(holder.views.get(0x7f0900d9).maxWidth, 2147483647));

  const titleNoMultiline = original.replace(/    invoke-virtual \{p1, v3\}, Landroid\/widget\/TextView;->setMaxLines\(I\)V\r?\n/, '');
  await versionMutationFails(root, titleNoMultiline, (holder) => assert.equal(holder.views.get(0x7f0900ae).maxLines, 2147483647));

  const wrongOuterDirection = original.replace(/(    invoke-static \{p1, p2\}, Lcom\/suda\/yzune\/wakeupschedule\/settings\/o00O000o;->slimApplyType1Style[^\r\n]*\r?\n)/, '$1    iget-object v8, p1, Landroidx/recyclerview/widget/RecyclerView$ViewHolder;->itemView:Landroid/view/View;\n    const/4 v0, 0x0\n    invoke-virtual {v8, v0}, Landroidx/appcompat/widget/LinearLayoutCompat;->setOrientation(I)V\n');
  await versionMutationFails(root, wrongOuterDirection, (holder) => assert.equal(holder.itemView.orientation, 1));

  const hiddenForcedVisible = original.replace(/    const\/4 v10, 0x0\r?\n/, '    const/4 v10, -0x2\n');
  const hiddenHolder = createInitialItem(2, 0, [0, 0, 0, 0], 'light', 'middle');
  await bind(root, hiddenHolder, makeItem({ visible: false }), hiddenForcedVisible);
  assert.throws(() => assert.equal(hiddenHolder.itemView.layoutParams.height, 0));

  const textMutant = original.replace(/    :slim_type1_return\r?\n/, '    invoke-virtual {p1}, Landroid/widget/TextView;->setText(Ljava/lang/CharSequence;)V\n    :slim_type1_return\n');
  assert.throws(() => assertT32Contract(textMutant, providerSource), /setText/i);
  const eventMutant = original.replace(/    :slim_type1_return\r?\n/, '    const/4 v0, 0x0\n    invoke-virtual {p1, v0}, Landroid/view/View;->setClickable(Z)V\n    :slim_type1_return\n');
  assert.throws(() => assertT32Contract(eventMutant, providerSource), /clickable/i);

  const wrongDp = original.replace(/    mul-float\/2addr v5, v4\r?\n    float-to-int v5, v5\r?\n    invoke-virtual \{p0, v5\}, Landroid\/view\/View;->setMinimumHeight\(I\)V/, '    float-to-int v5, v5\n    invoke-virtual {p0, v5}, Landroid/view/View;->setMinimumHeight(I)V');
  await versionMutationFails(root, wrongDp, (holder) => assert.equal(holder.views.get(0x7f090099).minimumHeight, Math.trunc(64 * 1.25)));
});

test('restricted Smali fixture rejects unsupported instructions and invokes', async (t) => {
  const root = await patchedFixture(t);
  const sources = await readFixtureSources(root);
  const helper = methodBlock(sources.adapter, 'private static slimSnapshotInt([Ljava/lang/Object;I)I');
  const world = makeWorld(sources, createInitialItem(1, 0, [0, 0, 0, 0], 'light', 'middle'), makeItem());
  const unknownInstruction = helper.replace('    return v0\n', '    monitor-enter v0\n    return v0\n');
  assert.throws(() => executeMethod(unknownInstruction, 'private static slimSnapshotInt([Ljava/lang/Object;I)I', [[], 0], world), /unsupported Smali instruction/);
  const unknownInvoke = helper.replace('    invoke-virtual {v0}, Ljava/lang/Integer;->intValue()I', '    invoke-virtual {v0}, Lunknown/Target;->doThing()V');
  assert.throws(() => executeMethod(unknownInvoke, 'private static slimSnapshotInt([Ljava/lang/Object;I)I', [[], 0], world), /unsupported invoke/);
});

