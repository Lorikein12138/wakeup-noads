import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { applyPatchSpec } from '../scripts/patch.mjs';
import { readSmaliMethod } from './smali-helpers.mjs';

const decoded = path.resolve(process.env.SLIM_BASELINE_DECODED_ROOT ?? 'tools/_cache/slim-v1-decoded');
const cache = path.resolve('tools/_cache/slim-v1-review/fixtures/round-3');
const getterPath = 'smali_classes6/com/suda/yzune/wakeupschedule/BaseApplication$OooO00o.smali';
const settingsPath = 'smali_classes6/com/suda/yzune/wakeupschedule/settings/SettingsActivity.smali';
const adapterPath = 'smali_classes6/com/suda/yzune/wakeupschedule/settings/o00O000o.smali';
const providerPath = 'smali_classes6/o0OOOoo.3/o0Oo0oo.smali';
const blankProviderPath = 'smali_classes6/o0OOOoo.3/o00000O0.smali';
const basePath = 'smali_classes6/com/suda/yzune/wakeupschedule/base_view/OooOO0.smali';
const scheduleSettingsPath = 'smali_classes6/com/suda/yzune/wakeupschedule/schedule_settings/ScheduleSettingsFragment.smali';
const getterClass = 'Lcom/suda/yzune/wakeupschedule/BaseApplication$OooO00o;';
const settingsClass = 'Lcom/suda/yzune/wakeupschedule/settings/SettingsActivity;';
const adapterClass = 'Lcom/suda/yzune/wakeupschedule/settings/o00O000o;';
const blankProviderBindDescriptor = 'public OooOO0O(Lcom/chad/library/adapter/base/viewholder/BaseViewHolder;Lcom/suda/yzune/wakeupschedule/settings/items/OooO00o;)V';
const baseClass = 'Lcom/suda/yzune/wakeupschedule/base_view/OooOO0;';
const bindDescriptor = 'public o0ooOoO(Lcom/chad/library/adapter/base/viewholder/BaseViewHolder;Lcom/suda/yzune/wakeupschedule/settings/items/OooO00o;)V';
const providerBindDescriptor = 'public OooOO0O(Lcom/chad/library/adapter/base/viewholder/BaseViewHolder;Lcom/suda/yzune/wakeupschedule/settings/items/OooO00o;)V';
const tagId = 0x7f130021;
const versionTitleId = 0x7f130021;

async function patchedFixture(t) {
  await mkdir(cache, { recursive: true });
  const root = await mkdtemp(path.join(cache, 'version-display-simulation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const relative of [getterPath, settingsPath, adapterPath, providerPath, blankProviderPath, basePath]) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(decoded, relative), target);
  }
  const scheduleSettingsTarget = path.join(root, scheduleSettingsPath);
  await mkdir(path.dirname(scheduleSettingsTarget), { recursive: true });
  await copyFile(path.join(decoded, scheduleSettingsPath), scheduleSettingsTarget);
  const fullSpec = JSON.parse(await readFile('patches/slim-v1/patch-spec.json', 'utf8'));
  const operations = fullSpec.operations.filter((operation) =>
    operation.id.startsWith('T23-E37-') || operation.id.startsWith('T23-E38-') || operation.id.startsWith('T32-E55-')
    || operation.id === 'T34-E55-collapse-empty-settings-row' || operation.id === 'T34-E55-settings-viewport-clip');
  assert.equal(operations.length, 8, 'the four version-display, two T32 style, and two T34 settings operations are present');
  const specPath = path.join(root, 'fixture-spec.json');
  await writeFile(specPath, JSON.stringify({ schemaVersion: 1, applicationId: 'io.github.wakeupnoads', operations }));
  const result = await applyPatchSpec({ root, specPath, releaseName: 'wakeup-noads-v6.6.0-r1' });
  assert.equal(result.operations.length, 8);
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
  const match = /^(invoke-(?:static|virtual|direct|super|interface)(?:\/range)?)\s+\{[^}]*\},\s+(.+);->([^ (]+)(\(.*)$/.exec(text);
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
    layoutParams: { width: -1, height: -2, margins: { start: margin, end: margin, top: 0, bottom: 0 }, gravity: -1, layoutParamsClass: 'frame' },
    background: 'baseline-' + theme + '-' + group,
    divider: { id: 0x7f0900af, marker: 'provider-divider' },
    eventState: { clickListener: 'ordinary-listener', longClickListener: 'ordinary-long-listener', clickable: true, longClickable: true, enabled: true },
    minimumHeight: 0,
    padding: [0, 0, 0, 0]
  };
  const context = { resources: { displayMetrics: { density } } };
  const inner = {
    id: 0x7f09009d, kind: 'linear', context, orientation: innerOrientation,
    layoutParams: { width: -1, height: Math.trunc(64 * density), weight: 0, margins: { start: 0, end: 0, top: 0, bottom: 0 }, gravity: -1, layoutParamsClass: 'compat' },
    minimumHeight: 0, padding: [...padding], tags: new Map()
  };
  const title = {
    id: 0x7f0900b2, kind: 'text', context, text: '', textSize: 16, typeface: 'default-bold-' + theme,
    textColor: 'theme-title-' + theme, gravity: 16,
    layoutParams: { width: 0, height: -2, weight: 1, margins: { start: margin, end: margin, top: 0, bottom: 0 }, gravity: -1, layoutParamsClass: 'compat' },
    minLines: 1, maxLines: 1, maxWidth: 2147483647, ellipsize: null
  };
  const value = {
    id: 0x7f0900dd, kind: 'text', context, text: '', textSize: 14, typeface: 'default-' + theme,
    textColor: 'theme-value-' + theme, gravity: 16,
    layoutParams: { width: -2, height: -2, weight: 0, margins: { start: margin, end: margin, top: 0, bottom: 0 }, gravity: -1, layoutParamsClass: 'compat' },
    minLines: 1, maxLines: 1, maxWidth: Math.trunc(200 * density), ellipsize: null
  };
  const description = {
    id: 0x7f0900b3, kind: 'text', context, text: '', visibility: 0,
    layoutParams: { width: -2, height: -2, margins: { start: margin, end: margin, top: 0, bottom: 0 }, gravity: -1, layoutParamsClass: 'compat' }
  };
  const holder = { itemView: outer, views: new Map([[0x7f09009d, inner], [0x7f0900b2, title], [0x7f0900b3, description], [0x7f0900dd, value]]), lookupCount: 0 };
  outer.children = [inner, outer.divider];
  return holder;
}

function viewStyle(holder) {
  const inner = holder.views.get(0x7f09009d);
  const title = holder.views.get(0x7f0900b2);
  const value = holder.views.get(0x7f0900dd);
  return {
    outer: { orientation: holder.itemView.orientation, layoutParams: lpCopy(holder.itemView.layoutParams), background: holder.itemView.background, divider: holder.itemView.divider, eventState: { ...holder.itemView.eventState } },
    inner: { orientation: inner.orientation, layoutParams: lpCopy(inner.layoutParams), minimumHeight: inner.minimumHeight, padding: [...inner.padding] },
    title: { layoutParams: lpCopy(title.layoutParams), minLines: title.minLines, maxLines: title.maxLines, maxWidth: title.maxWidth, ellipsize: title.ellipsize, textSize: title.textSize, typeface: title.typeface, textColor: title.textColor, gravity: title.gravity },
    value: { layoutParams: lpCopy(value.layoutParams), minLines: value.minLines, maxLines: value.maxLines, maxWidth: value.maxWidth, ellipsize: value.ellipsize, textSize: value.textSize, typeface: value.typeface, textColor: value.textColor, gravity: value.gravity }
  };
}

function makeItem({ type = 1, titleId = 0x7f130020, title = 'Ordinary', value = 'Setting value', visible = true, group = 'middle' } = {}) {
  return { type, titleId, title, value, visible, group, richText: false, settingSubtype: type === 4 ? 'blank-setting-row' : 'ordinary' };
}

function isBlankSettingPlaceholder(item) {
  return item?.type === 4 && item.titleId === 0x7f130354 && String(item.value ?? '').trim().length === 0;
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
  if (owner === 'Lcom/meituan/robust/PatchProxy;' && method === 'proxy') return { isSupported: false, result: null };
  if (owner === 'Lcom/suda/yzune/wakeupschedule/settings/items/OooO00o;' && method === 'OooO') return args[0].group === 'first';
  if (owner === 'Lcom/suda/yzune/wakeupschedule/settings/items/OooO00o;' && method === 'OooOO0O') return args[0].group === 'last';
  if (target.kind === 'invoke-super' && method === 'OooOoO' && owner === 'Lcom/chad/library/adapter/base/BaseProviderMultiAdapter;') {
    if (args[2].type === 1) {
      return executeMethod(sources.provider, providerBindDescriptor, [{ provider: true }, args[1], args[2]], world);
    }
    if (args[2].type === 4) {
      assertBlankProviderFixture(sources.blankProvider);
      return executeMethod(sources.blankProvider, blankProviderBindDescriptor, [{ provider: true }, args[1], args[2]], world);
    }
    return undefined;
  }
  if (owner === 'Lkotlin/jvm/internal/o00oO0o;' && ['OooO', 'OooO0oO'].includes(method)) return undefined;
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
      if (view) view.text = view.id === 0x7f0900b2 ? holder.currentItem.title : String(args[2]);
      return holder;
    }
    if (method === 'setText' && target.descriptor === '(ILjava/lang/CharSequence;)Lcom/chad/library/adapter/base/viewholder/BaseViewHolder;') {
      const view = holder.views.get(Number(args[1]));
      if (view) view.text = String(args[2]);
      return holder;
    }
    if (method === 'setGone') {
      const view = Number(args[1]) === 0x7f0900af ? holder.itemView.divider : holder.views.get(Number(args[1]));
      if (view) view.visibility = args[2] ? 8 : 0;
      return holder;
    }
  }
  if (owner === 'Lcom/suda/yzune/wakeupschedule/settings/items/OooO00o;') {
    const item = args[0];
    if (method === 'OooO0oO') return item.type;
    if (method === 'OooO0Oo') return item.titleId;
    if (method === 'OooO0O0') return item.visible;
    if (method === 'OooOOoo') return item.value;
    if (method === 'OooOO0') return item.group === 'first' || item.group === 'single';
    if (method === 'OooOO0O') return item.group === 'last' || item.group === 'single';
  }
  if (owner === 'Lcom/suda/yzune/wakeupschedule/settings/items/OooOOO;') {
    const item = args[0];
    if (method === 'OooOOoo') return item.value;
    if (method === 'OooOo0') return item.titleId;
    if (method === 'OooOoO0') return item.richText ?? false;
  }
  if (owner === 'Ljava/lang/CharSequence;' && method === 'length') return String(args[0] ?? '').length;
  if (owner === 'Lcom/suda/yzune/wakeupschedule/settings/items/OooO0o;' && method === 'OooOOoo') return args[0].value;
  if (method === '<init>' && owner === 'Landroidx/appcompat/widget/LinearLayoutCompat$LayoutParams;') {
    const source = args[1];
    Object.assign(args[0], {
      width: source.width,
      height: source.height,
      margins: source.margins ? { ...source.margins } : undefined,
      weight: 0,
      gravity: -1,
      layoutParamsClass: 'compat'
    });
    return undefined;
  }
  if (method === '<init>' && owner === 'Landroid/graphics/drawable/StateListDrawable;') {
    args[0].type = 'StateListDrawable'; args[0].states = [];
    return undefined;
  }
  if (method === '<init>' && owner === 'Landroid/graphics/drawable/GradientDrawable;') {
    args[0].type = 'GradientDrawable'; args[0].cornerRadii = [];
    return undefined;
  }
  if (method === '<init>' && owner === 'Landroid/graphics/drawable/RippleDrawable;') {
    Object.assign(args[0], { type: 'RippleDrawable', color: args[1], content: args[2], mask: args[3] });
    return undefined;
  }
  if (owner === 'Landroid/content/res/ColorStateList;' && method === 'valueOf') return { type: 'ColorStateList', color: Number(args[0]) };
  if (owner === 'Landroid/graphics/drawable/GradientDrawable;') {
    if (method === 'setCornerRadii') { args[0].cornerRadii = [...args[1]]; return undefined; }
    if (method === 'setColor') { args[0].color = Number(args[1]); return undefined; }
  }
  if (owner === 'Landroid/graphics/drawable/StateListDrawable;' && method === 'addState') {
    args[0].states.push({ state: [...args[1]], drawable: args[2] });
    return undefined;
  }
  if (owner === 'Lkotlin/text/o00000OO;' && method === 'o0OOO0o') return String(args[0] ?? '').trim().length === 0;
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
    if (method === 'setVisibility') {
      view.visibility = Number(args[1]);
      return undefined;
    }
    if (method === 'getVisibility') return view.visibility ?? 0;
    if (method === 'setBackgroundColor') {
      view.backgroundColor = Number(args[1]);
      return undefined;
    }
    if (method === 'setBackground') {
      view.background = args[1];
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
  if (owner === 'Lcom/chad/library/adapter/base/BaseQuickAdapter;' && method === 'Oooo000') return args[0].context;
  if (owner === 'Lcom/google/android/material/elevation/SurfaceColors;' && method === 'getColor') return 0xfffafafa;
  throw new Error('unsupported invoke in restricted Smali fixture: ' + target.kind + ' ' + owner + '->' + method + target.descriptor);
}

function invokeSmali(sources, instruction, world) {
  const target = parseInvocation(instruction);
  const registers = invocationRegisters(instruction, world.currentLocalCount);
  const args = registers.map((index) => world.registers[index]);
  world.trace.push(`${target.kind} ${target.owner}->${target.method}`);
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
        const supported = new Set([
          'Landroidx/appcompat/widget/LinearLayoutCompat$LayoutParams;',
          'Landroid/graphics/drawable/StateListDrawable;',
          'Landroid/graphics/drawable/GradientDrawable;',
          'Landroid/graphics/drawable/RippleDrawable;'
        ]);
        if (!match || !supported.has(match[2])) throw new Error('unsupported new-instance: ' + instruction);
        write(match[1], {});
      } else if (op === 'move' || op === 'move-object' || op === 'move/from16' || op === 'move-object/from16') {
        const [dest, sourceRegister] = commaParts;
        write(dest, read(sourceRegister));
      } else if (op === 'move-result' || op === 'move-result-object') {
        write(commaParts[0], world.lastResult);
        world.lastResult = undefined;
      } else if (op.startsWith('invoke-')) {
        world.lastResult = invokeSmali(world.sources, instruction, world);
      } else if (op === 'check-cast') {
        // Explicitly modeled as a reference-preserving cast in this restricted fixture.
      } else if (op === 'const-class') {
        const [dest, type] = commaParts;
        write(dest, { type });
      } else if (op === 'instance-of') {
        const [dest, objectRegister, className] = commaParts;
        const object = read(objectRegister);
        const isCompat = className === 'Landroidx/appcompat/widget/LinearLayoutCompat$LayoutParams;' && object?.layoutParamsClass === 'compat';
        const isAndroidLinear = className === 'Landroid/widget/LinearLayout$LayoutParams;' && object?.layoutParamsClass === 'android';
        const isBlankRow = className === 'Lcom/suda/yzune/wakeupschedule/settings/items/OooOOO;' && object?.settingSubtype === 'blank-setting-row';
        write(dest, Boolean(isCompat || isAndroidLinear || isBlankRow));
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
      } else if (op === 'iget' || op === 'iget-object' || op === 'iget-boolean') {
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
      } else if (op === 'aput') {
        const [sourceRegister, arrayRegister, indexRegister] = commaParts;
        read(arrayRegister)[Number(read(indexRegister))] = read(sourceRegister);
      } else if (op === 'aget-object') {
        const [dest, arrayRegister, indexRegister] = commaParts;
        write(dest, read(arrayRegister)[Number(read(indexRegister))]);
      } else if (op === 'filled-new-array' || op === 'filled-new-array/range') {
        world.lastResult = invocationRegisters(instruction, method.localCount).map((index) => registers[index]);
      } else if (op === 'fill-array-data') {
        const [arrayRegister] = commaParts;
        read(arrayRegister).fill(0);
      } else if (op === 'sget-object') {
        const [dest, fieldRef] = commaParts;
        write(dest, { smaliField: fieldRef });
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
      if (!world.completeVisibleBind && descriptor === bindDescriptor && world.styleApplied && !isBlankSettingPlaceholder(world.currentItem)
        && op === 'iput' && instruction.includes('ViewGroup$LayoutParams;->height:I')) {
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

function executeInsetsCallback(source, descriptor, args) {
  const method = parseMethod(source, descriptor);
  const registers = Array(method.localCount + args.length + 2).fill(null);
  args.forEach((value, index) => { registers[method.localCount + index] = value; });
  const read = (operand) => /^[vp]\d+$/.test(operand) ? registers[registerIndex(operand, method.localCount)] : labelValue(operand);
  const write = (operand, value) => { registers[registerIndex(operand, method.localCount)] = value; };
  const world = { currentLocalCount: method.localCount, lastResult: undefined };
  const invoke = (instruction) => {
    const target = parseInvocation(instruction);
    const registerBody = instruction.slice(instruction.indexOf('{') + 1, instruction.indexOf('}')).trim();
    const values = registerBody ? invocationRegisters(instruction, method.localCount).map((index) => registers[index]) : [];
    if (target.owner === 'Lcom/meituan/robust/PatchProxy;' && target.method === 'proxy') return { isSupported: false, result: null };
    if (target.kind === 'invoke-static' && target.owner === 'Landroidx/core/view/WindowInsetsCompat$Type;') {
      if (target.method === 'systemBars') return 1;
      if (target.method === 'ime') return 2;
    }
    if (target.kind === 'invoke-static' && target.owner === 'Lkotlin/jvm/internal/o00oO0o;') return undefined;
    if (target.kind === 'invoke-static' && target.owner === 'Lcom/suda/yzune/wakeupschedule/slim/LogPage;') {
      if (target.method === 'isLogActivity') {
        const activity = values[0];
        return activity.className === settingsClass && activity.logMode === true;
      }
      if (target.method === 'applyPageInsets') {
        const activity = values[0];
        activity.pageInsetsCalls.push({ view: values[1], insets: values[2] });
        return undefined;
      }
    }
    if (target.owner === 'Landroidx/core/view/WindowInsetsCompat;' && target.method === 'getInsets') {
      return values[0][values[1] === 1 ? 'systemBars' : 'ime'];
    }
    if (target.owner === baseClass && target.method === 'o0OoOo0') return values[0].list;
    if (target.owner === 'Landroidx/recyclerview/widget/RecyclerView;' && target.method === 'setClipToPadding') {
      values[0].clipToPadding = Boolean(values[1]);
      values[0].clipCalls.push(Boolean(values[1]));
      return undefined;
    }
    if (target.owner === 'Landroid/view/View;') {
      const view = values[0];
      const paddingMethods = { getPaddingLeft: 0, getPaddingTop: 1, getPaddingRight: 2, getPaddingBottom: 3 };
      if (Object.hasOwn(paddingMethods, target.method)) return view.padding[paddingMethods[target.method]];
      if (target.method === 'setPadding') {
        const padding = values.slice(1, 5).map(Number);
        view.paddingCalls.push(padding);
        view.padding = padding;
        return undefined;
      }
    }
    throw new Error('unsupported invoke in production inset callback: ' + target.kind + ' ' + target.owner + '->' + target.method + target.descriptor);
  };
  let pc = 0;
  let steps = 0;
  while (pc < method.instructions.length) {
    if (++steps > 500) throw new Error('production inset callback exceeded its instruction bound');
    const instruction = method.instructions[pc];
    const op = instruction.split(/\s+/)[0];
    const tail = instruction.slice(op.length).trim();
    const parts = tail.split(',').map((part) => part.trim());
    let jump = null;
    if (/^const(?:\/4|\/16)?$/.test(op)) write(parts[0], read(parts[1]));
    else if (op === 'const-class') write(parts[0], { type: parts[1] });
    else if (op === 'const-string') write(parts[0], tail.slice(tail.indexOf(',') + 1).trim().replace(/^"|"$/g, ''));
    else if (op === 'move' || op === 'move-object' || op === 'move/from16' || op === 'move-object/from16') write(parts[0], read(parts[1]));
    else if (op === 'move-result' || op === 'move-result-object') { write(parts[0], world.lastResult); world.lastResult = undefined; }
    else if (op === 'filled-new-array' || op === 'filled-new-array/range') world.lastResult = invocationRegisters(instruction, method.localCount).map((index) => registers[index]);
    else if (op.startsWith('invoke-')) world.lastResult = invoke(instruction);
    else if (op === 'sget-object') write(parts[0], { smaliField: parts[1] });
    else if (op === 'check-cast') { /* reference-preserving fixture cast */ }
    else if (op === 'instance-of') {
      const object = read(parts[1]);
      write(parts[0], object.className === parts[2]);
    }
    else if (op === 'iget' || op === 'iget-object' || op === 'iget-boolean') {
      const field = /;->([^:]+):/.exec(parts[2])?.[1];
      if (!field) throw new Error('invalid production inset field: ' + instruction);
      write(parts[0], read(parts[1])[field]);
    }
    else if (op === 'if-eqz' || op === 'if-nez') {
      const value = read(parts[0]);
      const zero = value === null || value === undefined || value === false || value === 0;
      if (op === 'if-eqz' ? zero : !zero) jump = parts[1];
    }
    else if (op === 'goto') jump = tail;
    else if (op === 'return-object' || op === 'return') return read(tail);
    else throw new Error('unsupported production inset instruction: ' + instruction);
    if (jump) {
      assert.ok(method.labels.has(jump), 'production inset branch target exists: ' + jump);
      pc = method.labels.get(jump);
    } else pc++;
  }
  return undefined;
}

async function readFixtureSources(root) {
  return {
    getter: await readFile(path.join(root, getterPath), 'utf8'),
    settings: await readFile(path.join(root, settingsPath), 'utf8'),
    adapter: await readFile(path.join(root, adapterPath), 'utf8'),
    provider: await readFile(path.join(root, providerPath), 'utf8'),
    blankProvider: await readFile(path.join(root, blankProviderPath), 'utf8'),
    base: await readFile(path.join(root, basePath), 'utf8')
  };
}

function makeWorld(sources, holder, item, { completeVisibleBind = false } = {}) {
  holder.currentItem = item;
  return { sources, currentItem: item, registers: [], currentLocalCount: 0, lastResult: undefined, styleApplied: false,
    inAdapterBind: true, completeVisibleBind, trace: [] };
}

async function bind(root, holder, item, adapterOverride = null, options = {}) {
  const sources = await readFixtureSources(root);
  if (adapterOverride) sources.adapter = adapterOverride;
  const world = makeWorld(sources, holder, item, options);
  const output = executeMethod(sources.adapter, bindDescriptor, [{ adapter: true, o00OoO0: 12 }, holder, item], world);
  return { world, output, sources };
}

function assertProviderFixture(providerSource) {
  const type = methodBlock(providerSource, 'public OooO0Oo()I');
  const create = methodBlock(providerSource, 'public OooO0o0(Landroid/view/ViewGroup;I)Lcom/chad/library/adapter/base/viewholder/BaseViewHolder;');
  const bindMethod = methodBlock(providerSource, providerBindDescriptor);
  assert.match(type, /const\/4 v0, 0x1/);
  assert.match(create, /0x7f09009d[\s\S]*?0x7f0900b2[\s\S]*?0x7f0900dd/);
  assert.match(create, /LinearLayoutCompat;->setOrientation\(I\)V/);
  assert.match(create, /const\/16 v\d+, 0x40[\s\S]*?float-to-int[\s\S]*?LayoutParams;-><init>\(II\)V/);
  assert.match(create, /setLines\(I\)V/);
  assert.match(create, /setMaxWidth\(I\)V/);
  assert.match(bindMethod, /BaseViewHolder;->setText\(II\)/);
  assert.match(bindMethod, /BaseViewHolder;->setText\(ILjava\/lang\/CharSequence;\)/);
}

function assertBlankProviderFixture(providerSource) {
  const type = methodBlock(providerSource, 'public OooO0Oo()I');
  const create = methodBlock(providerSource, 'public OooO0o0(Landroid/view/ViewGroup;I)Lcom/chad/library/adapter/base/viewholder/BaseViewHolder;');
  const bindMethod = methodBlock(providerSource, blankProviderBindDescriptor);
  assert.match(type, /const\/4 v0, 0x4/);
  assert.match(create, /0x7f0900b2[\s\S]*?0x7f0900b3/);
  assert.match(bindMethod, /OooOOoo\(\)Ljava\/lang\/String;[\s\S]*?CharSequence;->length\(\)I/);
  assert.match(bindMethod, /const\/16 p2, 0x8[\s\S]*?setVisibility\(I\)V/);
  assert.match(bindMethod, /setVisibility\(I\)V[\s\S]*?return-void/);
}

function assertT32Contract(adapterSource, providerSource) {
  assertProviderFixture(providerSource);
  const binder = methodBlock(adapterSource, bindDescriptor);
  assert.match(binder, /\.locals 16/);
  const visible = binder.indexOf(':cond_1');
  const styleCall = binder.indexOf('->slimApplyType1Style(');
  const outerSetup = binder.indexOf('iget-object v0, v7, Landroidx/recyclerview/widget/RecyclerView$ViewHolder;->itemView', styleCall);
  assert.ok(visible >= 0 && visible < styleCall && styleCall < outerSetup, 'visible style helper runs before original outer/background logic');
  assert.match(binder, /if-nez v0, :cond_1[\s\S]*?iget-object v0, v7, Landroidx\/recyclerview\/widget\/RecyclerView\$ViewHolder;->itemView[\s\S]*?iput v2, v0, Landroid\/view\/ViewGroup\$LayoutParams;->height:I[\s\S]*?return-void/);
  const styleMethod = methodBlock(adapterSource, 'private static slimApplyType1Style(Lcom/chad/library/adapter/base/viewholder/BaseViewHolder;Lcom/suda/yzune/wakeupschedule/settings/items/OooO00o;)V');
  assert.ok(styleMethod.indexOf('OooO0oO()I') < styleMethod.indexOf('BaseViewHolder;->getView(I)'), 'type is checked before child lookup');
  assert.ok(styleMethod.indexOf('slimRestoreType1Style') < styleMethod.indexOf('OooO0Oo()I'), 'every visible type1 bind restores before checking the version title');
  for (const id of ['0x7f09009d', '0x7f0900b2', '0x7f0900dd']) assert.ok(styleMethod.includes(id));
  assert.match(adapterSource, /getTag\(I\)Ljava\/lang\/Object;/);
  assert.match(adapterSource, /setTag\(ILjava\/lang\/Object;\)V/);
  const helperEnd = methodBlock(adapterSource, 'private static slimApplyType1Style(Lcom/chad/library/adapter/base/viewholder/BaseViewHolder;Lcom/suda/yzune/wakeupschedule/settings/items/OooO00o;)V');
  assert.doesNotMatch(helperEnd, /setOnClickListener\(Landroid\/view\/View\$OnClickListener;\)V|setClickable\(Z\)V|setLongClickable\(Z\)V|setEnabled\(Z\)V/);
  assert.doesNotMatch(helperEnd, /->setText\(|->setVisibility\(|->setBackground\(|itemView/);
  const versionStyle = methodBlock(adapterSource, 'private static slimApplyVersionStyle(Landroidx/appcompat/widget/LinearLayoutCompat;Landroid/widget/TextView;Landroid/widget/TextView;)V');
  assert.match(versionStyle, /setMinLines\(I\)V/);
  assert.match(versionStyle, /setMaxLines\(I\)V/);
  assert.match(versionStyle, /setMaxWidth\(I\)V/);
  assert.match(versionStyle, /setEllipsize\(Landroid\/text\/TextUtils\$TruncateAt;\)V/);
  assert.match(versionStyle, /0x42800000/);
  assert.match(versionStyle, /0x41800000/);
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
  assert.equal((patched.match(/wakeup-noads-v6\.6\.0-r1/g) ?? []).length, 2);
  assert.doesNotMatch(patched, /6\.5\.1/);
});

test('four global and course setting titles remain bound to their public IDs and provider values', async (t) => {
  const root = await patchedFixture(t);
  const publicXml = await readFile(path.join(decoded, 'res/values/public.xml'), 'utf8');
  const stringsXml = await readFile(path.join(decoded, 'res/values/strings.xml'), 'utf8');
  const titleCases = [
    ['setting_schedule_name', 0x7f13038c, '课表名称'],
    ['setting_class_time', 0x7f130356, '上课时间'],
    ['setting_term_start_date', 0x7f1303a0, '开学时间'],
    ['setting_week_start_day', 0x7f1303a4, '每周起始日'],
  ];
  for (const [name, id, title] of titleCases) {
    assert.match(publicXml, new RegExp(`<public type="string" name="${name}" id="0x${id.toString(16)}"`));
    assert.match(stringsXml, new RegExp(`<string name="${name}">${title}</string>`));
    const holder = createInitialItem(1.25, 0, [1, 2, 3, 4], 'light', 'middle');
    const value = `synthetic current value for ${name}`;
    await bind(root, holder, makeItem({ titleId: id, title, value }));
    assert.equal(holder.views.get(0x7f0900b2).text, title);
    assert.equal(holder.views.get(0x7f0900dd).text, value);
  }
  const actionCases = [
    ['setting_notify', 0x7f13037b, '上课提醒'],
    ['setting_current_schedule', 0x7f13035f, '设置当前课表'],
    ['setting_clear_webview_cache', 0x7f130359, '清除内置浏览器缓存'],
  ];
  for (const [name, id, title] of actionCases) {
    assert.match(publicXml, new RegExp(`<public type="string" name="${name}" id="0x${id.toString(16)}"`));
    assert.match(stringsXml, new RegExp(`<string name="${name}">${title}</string>`));
    const holder = createInitialItem(1, 0, [0, 0, 0, 0], 'light', 'middle');
    await bind(root, holder, makeItem({ titleId: id, title, value: '' }));
    assert.equal(holder.views.get(0x7f0900b2).text, title, `${name} retains its title when its value is empty`);
    assert.equal(holder.itemView.visibility ?? 0, 0, `${name} remains visible`);
  }
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
  assert.equal(holder.views.get(0x7f0900b2).text, 'Ordinary row');
  assert.equal(holder.views.get(0x7f0900dd).text, 'old value');
  assert.deepEqual(holder.itemView.eventState, baseline.outer.eventState);
  assert.equal(holder.itemView.orientation, 1);

  await bind(root, holder, makeItem({ titleId: versionTitleId, title: 'Current version', value: 'wakeup-noads-v6.6.0-r1' }));
  const inner = holder.views.get(0x7f09009d);
  const title = holder.views.get(0x7f0900b2);
  const value = holder.views.get(0x7f0900dd);
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
  assert.equal(value.text, 'wakeup-noads-v6.6.0-r1');

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
  assert.notEqual(holderA.views.get(0x7f09009d).tags.get(tagId), holderB.views.get(0x7f09009d).tags.get(tagId));
  assert.equal(holderA.itemView.orientation, 1);
  assert.equal(holderB.itemView.orientation, 1);
  await bind(root, holderA, makeItem({ title: 'middle ordinary', group: 'middle' }));
  await bind(root, holderB, makeItem({ title: 'last ordinary', group: 'last' }));
  assert.deepEqual(viewStyle(holderA), baseA);
  assert.deepEqual(viewStyle(holderB), baseB);

  const hiddenHolder = createInitialItem(2, 0, [0, 0, 0, 0], 'light', 'middle');
  const hiddenBaseline = viewStyle(hiddenHolder);
  await bind(root, hiddenHolder, makeItem({ titleId: versionTitleId, value: 'version before hidden' }));
  const versionPadding = [...hiddenHolder.views.get(0x7f09009d).padding];
  await bind(root, hiddenHolder, makeItem({ title: 'hidden ordinary', visible: false }));
  assert.equal(hiddenHolder.itemView.layoutParams.height, 0);
  assert.deepEqual(hiddenHolder.views.get(0x7f09009d).padding, versionPadding);
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

test('type1 restore copies real LinearLayout weight/gravity, preserves margins, and allocates fresh parameters', async (t) => {
  const root = await patchedFixture(t);
  for (const layoutParamsClass of ['compat', 'android']) {
    const holder = createInitialItem(1.3, 0, [2, 4, 6, 8], 'dark', 'middle');
    const title = holder.views.get(0x7f0900b2);
    const value = holder.views.get(0x7f0900dd);
    title.layoutParams = { ...title.layoutParams, layoutParamsClass, weight: 2.75, gravity: 17, margins: { start: 11, end: 13, top: 5, bottom: 7 } };
    value.layoutParams = { ...value.layoutParams, layoutParamsClass, weight: 0.5, gravity: 80, margins: { start: 17, end: 19, top: 3, bottom: 9 } };
    const expected = viewStyle(holder);
    expected.title.layoutParams.layoutParamsClass = 'compat';
    expected.value.layoutParams.layoutParamsClass = 'compat';
    await bind(root, holder, makeItem({ titleId: versionTitleId, title: 'Version', value: 'release' }));
    const snapshot = holder.views.get(0x7f09009d).tags.get(tagId);
    assert.notEqual(snapshot[7], title.layoutParams, 'title snapshot owns a separate LayoutParams object');
    assert.notEqual(snapshot[12], value.layoutParams, 'value snapshot owns a separate LayoutParams object');
    await bind(root, holder, makeItem({ title: 'ordinary row', value: 'ordinary value' }));
    assert.deepEqual(viewStyle(holder), expected, `${layoutParamsClass} weight, gravity, and margins restore`);
  }

  const marginOnly = createInitialItem(1, 0, [0, 0, 0, 0], 'light', 'middle');
  marginOnly.views.get(0x7f0900b2).layoutParams = { width: 0, height: -2, margins: { start: 23, end: 29, top: 2, bottom: 3 }, layoutParamsClass: 'margin' };
  await bind(root, marginOnly, makeItem({ titleId: versionTitleId, value: 'release' }));
  await bind(root, marginOnly, makeItem({ title: 'ordinary' }));
  assert.equal(marginOnly.views.get(0x7f0900b2).layoutParams.weight, 0, 'MarginLayoutParams gets the constructor default weight');
  assert.equal(marginOnly.views.get(0x7f0900b2).layoutParams.gravity, -1, 'MarginLayoutParams gets the constructor default gravity');
  assert.deepEqual(marginOnly.views.get(0x7f0900b2).layoutParams.margins, { start: 23, end: 29, top: 2, bottom: 3 });
});

test('actual settings adapter collapses blank rows and restores recycled visible rows', async (t) => {
  const root = await patchedFixture(t);
  const source = await readFile(path.join(root, adapterPath), 'utf8');
  const binder = methodBlock(source, bindDescriptor);
  const prepareCall = '->slimPrepareSettingRow(Lcom/chad/library/adapter/base/viewholder/BaseViewHolder;Lcom/suda/yzune/wakeupschedule/settings/items/OooO00o;)V';
  const prepareCalls = [...binder.matchAll(/->slimPrepareSettingRow\(/g)].map((match) => match.index);
  assert.equal(prepareCalls.length, 2);
  const originalBind = binder.indexOf('invoke-super/range {p0 .. p2}, Lcom/chad/library/adapter/base/BaseProviderMultiAdapter;->OooOoO');
  const restoredHeight = binder.indexOf('iput v3, v0, Landroid/view/ViewGroup$LayoutParams;->height:I');
  assert.ok(originalBind >= 0 && prepareCalls[0] > originalBind,
    'the first blank-row decision runs after the original provider bind restores its row');
  assert.ok(restoredHeight >= 0 && prepareCalls[1] > restoredHeight,
    'the second blank-row decision runs after the visible-row height is restored');
  const helper = methodBlock(source, 'private static slimPrepareSettingRow(Lcom/chad/library/adapter/base/viewholder/BaseViewHolder;Lcom/suda/yzune/wakeupschedule/settings/items/OooO00o;)V');
  assert.match(helper, /OooO0O0\(\)Z[\s\S]*?if-nez v1, :slim_setting_check_blank/);
  assert.match(helper, /OooO0oO\(\)I[\s\S]*?const\/4 v2, 0x4[\s\S]*?setting_blank|const v2, 0x7f130354/);
  assert.match(helper, /getLayoutParams\(\)Landroid\/view\/ViewGroup\$LayoutParams;[\s\S]*?const\/4 v2, 0x0[\s\S]*?iput v2, v1, Landroid\/view\/ViewGroup\$LayoutParams;->height:I[\s\S]*?setVisibility\(I\)V/);
  assert.match(helper, /const\/4 v2, -0x2[\s\S]*?setLayoutParams\(Landroid\/view\/ViewGroup\$LayoutParams;\)V[\s\S]*?setVisibility\(I\)V/);

  const blank = createInitialItem(1, 0, [0, 0, 0, 0], 'light', 'middle');
  const blankBind = await bind(root, blank, makeItem({ type: 4, titleId: 0x7f130354, title: 'setting_blank', value: '  \t\n' }));
  assert.equal(blankBind.output, undefined, 'the production adapter completes the type4 blank-provider branch');
  assert.equal(blank.itemView.layoutParams.height, 0, JSON.stringify({ trace: blankBind.world.trace, output: blankBind.output, item: blankBind.world.currentItem }));
  assert.equal(blank.itemView.visibility, 8);
  assert.equal(blank.itemView.divider.visibility, 8, 'original divider hiding branch still runs');
  assert.equal(blank.views.get(0x7f0900b2).text, 'setting_blank', 'the real type4 provider still supplies the original title');
  assert.equal(blank.views.get(0x7f0900b3).visibility, 0, 'whitespace description reaches the real provider before the row is collapsed');

  const secondBlank = createInitialItem(1, 0, [0, 0, 0, 0], 'dark', 'first');
  await bind(root, secondBlank, makeItem({ type: 4, titleId: 0x7f130354, title: 'setting_blank', value: '\t\n' }));
  assert.equal(secondBlank.itemView.layoutParams.height, 0);
  assert.equal(secondBlank.itemView.visibility, 8);
  assert.equal(blank.itemView.layoutParams.height, 0, 'collapsing another holder does not mutate the first holder');

  const recycled = createInitialItem(1, 0, [0, 0, 0, 0], 'light', 'middle');
  await bind(root, recycled, makeItem({ type: 4, titleId: 0x7f130354, title: 'setting_blank', value: '' }));
  await bind(root, recycled, makeItem({ type: 1, titleId: 0x7f13037b, title: '上课提醒', value: '' }));
  assert.equal(recycled.itemView.layoutParams.height, -2);
  assert.equal(recycled.itemView.visibility, 0);
  assert.equal(recycled.views.get(0x7f0900b2).text, '上课提醒');

  const nonempty = createInitialItem(1, 0, [0, 0, 0, 0], 'light', 'middle');
  const nonemptyBind = await bind(root, nonempty,
    makeItem({ type: 4, titleId: 0x7f130354, title: 'setting_blank', value: 'section description', group: 'first' }),
    null, { completeVisibleBind: true });
  assert.equal(nonemptyBind.output, undefined, 'the production binder executes the nonempty-description row through return-void');
  assert.equal(nonempty.itemView.layoutParams.height, -2);
  assert.equal(nonempty.itemView.visibility, 0);
  assert.equal(nonempty.views.get(0x7f0900b3).visibility, 0, 'nonempty type4 descriptions remain visible');
  assert.equal(nonempty.itemView.divider.visibility, 8, 'the completed visible-row path applies the production divider result');
  assert.equal(nonempty.itemView.background.type, 'StateListDrawable', 'the completed type4 path installs its production background');
  assert.deepEqual(nonempty.itemView.background.states[1].drawable.cornerRadii.map(asFloat), [12, 12, 12, 12, 0, 0, 0, 0],
    'the completed first-row path applies top corner radii and square bottom corners');

  const ordinaryVisible = createInitialItem(1, 0, [0, 0, 0, 0], 'dark', 'middle');
  const ordinaryBind = await bind(root, ordinaryVisible,
    makeItem({ type: 1, titleId: 0x7f13037b, title: '上课提醒', value: '', group: 'last' }),
    null, { completeVisibleBind: true });
  assert.equal(ordinaryBind.output, undefined, 'ordinary visible production bind reaches method return');
  assert.equal(ordinaryVisible.itemView.visibility, 0);
  assert.equal(ordinaryVisible.itemView.layoutParams.height, -2);
  assert.equal(ordinaryVisible.itemView.background.type, 'StateListDrawable');
  assert.deepEqual(ordinaryVisible.itemView.background.states[1].drawable.cornerRadii.map(asFloat), [0, 0, 0, 0, 12, 12, 12, 12],
    'the completed last-row path applies bottom corner radii and square top corners');
  assert.equal(ordinaryVisible.itemView.divider.visibility, 8);

  const originallyHidden = createInitialItem(1, 0, [0, 0, 0, 0], 'light', 'last');
  await bind(root, originallyHidden, makeItem({ type: 1, titleId: 0x7f13037b, title: '上课提醒', value: '', visible: false }));
  assert.equal(originallyHidden.itemView.layoutParams.height, 0);
  assert.equal(originallyHidden.itemView.visibility, 8);
  await bind(root, originallyHidden, makeItem({ type: 1, titleId: 0x7f13037b, title: '上课提醒', value: '', visible: true }));
  assert.equal(originallyHidden.itemView.layoutParams.height, -2);
  assert.equal(originallyHidden.itemView.visibility, 0);
  assert.equal(originallyHidden.views.get(0x7f0900b2).text, '上课提醒');

  const feature = createInitialItem(1, 0, [0, 0, 0, 0], 'light', 'middle');
  await bind(root, feature, makeItem({ type: 1, titleId: 0x7f13037b, title: '上课提醒', value: '' }));
  assert.equal(feature.itemView.visibility, 0);
  assert.equal(feature.itemView.layoutParams.height, -2);
  assert.equal(feature.views.get(0x7f0900b2).text, '上课提醒', 'a functional row with an empty value retains its title');

  const courseClass = 'Lcom/suda/yzune/wakeupschedule/schedule_settings/ScheduleSettingsFragment;';
  const courseBefore = await readSmaliMethod(decoded, scheduleSettingsPath, courseClass, 'private final o00o0O(Ljava/util/List;)V');
  const courseAfter = await readSmaliMethod(root, scheduleSettingsPath, courseClass, 'private final o00o0O(Ljava/util/List;)V');
  assert.equal(courseAfter, courseBefore, 'course-setting entries remain byte-for-byte at the v6.6.0 baseline');
  const settingsBefore = await readSmaliMethod(decoded, settingsPath, settingsClass, 'private final oo0o0Oo(Ljava/util/List;)V');
  const settingsAfter = await readSmaliMethod(root, settingsPath, settingsClass, 'private final oo0o0Oo(Ljava/util/List;)V');
  const spec = JSON.parse(await readFile('patches/slim-v1/patch-spec.json', 'utf8'));
  const listOp = spec.operations.find((operation) => operation.id === 'T23-E38-current-version-row');
  assert.ok(listOp);
  assert.equal(settingsAfter.replace(listOp.replacement, listOp.expectedOriginal), settingsBefore,
    'the only global-list difference remains the current-version addition');
  const clickBefore = await readSmaliMethod(decoded, settingsPath, settingsClass,
    'private final o0OO00O(Lcom/suda/yzune/wakeupschedule/settings/items/OooO0o;I)V');
  const clickAfter = await readSmaliMethod(root, settingsPath, settingsClass,
    'private final o0OO00O(Lcom/suda/yzune/wakeupschedule/settings/items/OooO0o;I)V');
  const clickOp = spec.operations.find((operation) => operation.id === 'T23-E38-version-read-only');
  assert.ok(clickOp);
  assert.equal(clickAfter.replace(clickOp.replacement, clickOp.expectedOriginal), clickBefore,
    'the only click-handler difference remains the read-only version guard');
});

test('insets callback dispatches only the true log mode and preserves the migrated ordinary branch', async (t) => {
  const root = await patchedFixture(t);
  const descriptor = 'public static final Ooooooo(Lcom/suda/yzune/wakeupschedule/base_view/OooOO0;Landroid/view/View;Landroidx/core/view/WindowInsetsCompat;)Landroidx/core/view/WindowInsetsCompat;';
  const before = await readSmaliMethod(decoded, basePath, baseClass, descriptor);
  const after = await readSmaliMethod(root, basePath, baseClass, descriptor);
  const match = /instance-of (v\d+), p0, (L[^;]+;)/.exec(after);
  assert.ok(match, 'the callback saves the host class before p0 becomes the RecyclerView');
  const clip = new RegExp(`invoke-virtual \\{p0, ${match[1]}\\}, Landroidx/recyclerview/widget/RecyclerView;->setClipToPadding\\(Z\\)V`);
  assert.match(after, clip, 'the saved SettingsActivity result controls the actual RecyclerView call');
  const clipRegister = /invoke-virtual \{p0, (v\d+)\}, Landroidx\/recyclerview\/widget\/RecyclerView;->setClipToPadding\(Z\)V/.exec(after);
  assert.ok(clipRegister && clipRegister[1] === match[1], 'the captured instance-of register feeds the real clip call');
  const executeHostBranch = (className) => Number(className === match[2]);
  const settingsClipValue = executeHostBranch('Lcom/suda/yzune/wakeupschedule/settings/SettingsActivity;');
  const otherHostClipValue = executeHostBranch('Lcom/suda/yzune/wakeupschedule/schedule/ScheduleActivity;');
  assert.equal(match[2], 'Lcom/suda/yzune/wakeupschedule/settings/SettingsActivity;');
  assert.equal(settingsClipValue, 1, 'the parsed production instance-of sets true for SettingsActivity');
  assert.equal(otherHostClipValue, 0, 'the parsed production instance-of keeps other base hosts false');
  assert.match(after, /WindowInsetsCompat\$Type;->systemBars\(\)I[\s\S]*?WindowInsetsCompat\$Type;->ime\(\)I[\s\S]*?getInsets\(I\)Landroidx\/core\/graphics\/Insets;[\s\S]*?setPadding\(IIII\)V/);
  assert.match(after, /return-object p2/);
  const currentSpec = JSON.parse(await readFile('patches/slim-v1/patch-spec.json', 'utf8'));
  const currentClip = currentSpec.operations.find((operation) => operation.id === 'T34-E55-settings-viewport-clip');
  assert.ok(currentClip, 'the migrated T34 replacement is the ordinary-mode reference');
  const guardLabel = ':slim_settings_clip_ordinary';
  const falseBranchStart = after.lastIndexOf(guardLabel) + guardLabel.length;
  assert.ok(falseBranchStart > guardLabel.length, 'the new exact log-mode branch has an ordinary fallthrough label');
  const actualFalseBody = after.slice(falseBranchStart, after.lastIndexOf('.end method')).trim();
  const expectedFalseStart = currentClip.replacementMethod.lastIndexOf(guardLabel) + guardLabel.length;
  assert.ok(expectedFalseStart > guardLabel.length, 'the migrated T34 replacement includes an ordinary fallthrough label');
  const expectedFalseBody = currentClip.replacementMethod.slice(expectedFalseStart,
    currentClip.replacementMethod.lastIndexOf('\n.end method')).trim();
  assert.equal(actualFalseBody, expectedFalseBody, 'false log guard keeps the migrated T34 body byte-for-byte, including R312');

  const execute = (className, systemBars, ime, rootPadding, listPadding, logMode = false) => {
    const list = { padding: [...listPadding], paddingCalls: [], clipCalls: [] };
    const rootView = { padding: [...rootPadding], paddingCalls: [] };
    const host = { className, list, logMode, pageInsetsCalls: [] };
    const insets = { systemBars, ime };
    const returned = executeInsetsCallback(after, descriptor, [host, rootView, insets]);
    return { host, list, rootView, insets, returned };
  };
  const barsOnly = execute(settingsClass,
    { left: 10, right: 12, bottom: 24 }, { left: 0, right: 0, bottom: 0 }, [1, 7, 2, 15], [3, 4, 5, 9]);
  assert.strictEqual(barsOnly.returned, barsOnly.insets, 'real callback returns the exact WindowInsetsCompat argument');
  assert.deepEqual(barsOnly.rootView.paddingCalls, [[10, 7, 12, 15], [10, 7, 12, 0]],
    'system bars update root horizontal padding, then the IME bottom replaces only root bottom padding');
  assert.deepEqual(barsOnly.list.paddingCalls, [[3, 4, 5, 24]], 'without IME the list receives the system-bars bottom inset');
  assert.deepEqual(barsOnly.list.clipCalls, [true], 'SettingsActivity clips the RecyclerView padding in the executed callback');
  const repeatedResult = executeInsetsCallback(after, descriptor, [barsOnly.host, barsOnly.rootView, barsOnly.insets]);
  assert.strictEqual(repeatedResult, barsOnly.insets, 'repeated callback still returns the same Insets object');
  assert.deepEqual(barsOnly.rootView.padding, [10, 7, 12, 0], 'repeating the same input does not accumulate root padding');
  assert.deepEqual(barsOnly.list.padding, [3, 4, 5, 24], 'repeating the same input does not accumulate list padding');
  assert.deepEqual(barsOnly.rootView.paddingCalls.slice(2), [[10, 7, 12, 0], [10, 7, 12, 0]]);
  assert.deepEqual(barsOnly.list.paddingCalls, [[3, 4, 5, 24], [3, 4, 5, 24]]);

  const withIme = execute(settingsClass,
    { left: 14, right: 16, bottom: 28 }, { left: 0, right: 0, bottom: 280 }, [3, 8, 5, 11], [2, 4, 6, 23]);
  assert.strictEqual(withIme.returned, withIme.insets);
  assert.deepEqual(withIme.rootView.paddingCalls, [[14, 8, 16, 11], [14, 8, 16, 280]]);
  assert.deepEqual(withIme.list.paddingCalls, [[2, 4, 6, 0]], 'a visible IME removes the list bottom inset while preserving other padding');
  const otherHost = execute('Lcom/suda/yzune/wakeupschedule/schedule/ScheduleActivity;',
    { left: 0, right: 0, bottom: 12 }, { left: 0, right: 0, bottom: 0 }, [0, 2, 0, 4], [0, 0, 0, 0]);
  assert.deepEqual(otherHost.list.clipCalls, [false], 'other base hosts retain the original unclipped list behavior');
  const logActivity = execute(settingsClass,
    { left: 10, right: 12, bottom: 24 }, { left: 0, right: 0, bottom: 280 }, [1, 7, 2, 15], [3, 4, 5, 9], true);
  assert.strictEqual(logActivity.returned, logActivity.insets, 'log dispatch returns the same WindowInsetsCompat object');
  assert.deepEqual(logActivity.host.pageInsetsCalls, [{ view: logActivity.rootView, insets: logActivity.insets }],
    'true log mode dispatches the existing callback view and Insets to the Activity-owned page bridge');
  assert.deepEqual(logActivity.rootView.paddingCalls, [], 'the log branch does not apply the removed RecyclerView callback padding');
  assert.deepEqual(logActivity.list.clipCalls, [], 'the log branch returns before touching the removed RecyclerView');
  const missingExtra = execute(settingsClass,
    { left: 4, right: 5, bottom: 9 }, { left: 0, right: 0, bottom: 0 }, [1, 2, 3, 4], [5, 6, 7, 8], false);
  assert.deepEqual(missingExtra.list.clipCalls, [true], 'ordinary SettingsActivity with a missing/false log extra follows the prior path');
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

  for (const [field, expectedValue] of [['weight', 2.25], ['gravity', 17]]) {
    const copyDescriptor = 'private static slimCopyType1Params(Landroid/view/ViewGroup$MarginLayoutParams;)Landroidx/appcompat/widget/LinearLayoutCompat$LayoutParams;';
    const copy = methodBlock(original, copyDescriptor);
    const copyInstruction = new RegExp(`    iput v1, v0, Landroidx/appcompat/widget/LinearLayoutCompat\\$LayoutParams;->${field}:${field === 'weight' ? 'F' : 'I'}\\r?\\n`, 'g');
    assert.ok((copy.match(new RegExp(copyInstruction.source, 'g')) ?? []).length >= 2, `both ${field} copies are present in the production helper before mutation`);
    const mutant = original.replace(/(\.method private static slimCopyType1Params\([\s\S]*?\.end method)/, (block) => block.replace(copyInstruction, ''));
    assert.notEqual(mutant, original, `the ${field} copy mutant changes the production helper`);
    const holder = createInitialItem(1.25, 0, [3, 5, 7, 9], 'dark', 'middle');
    const title = holder.views.get(0x7f0900b2);
    title.layoutParams = { ...title.layoutParams, weight: 2.25, gravity: 17, margins: { start: 31, end: 37, top: 2, bottom: 4 } };
    const baselineStyle = viewStyle(holder);
    await bind(root, holder, makeItem({ titleId: versionTitleId, title: 'Current version', value: 'synthetic' }), mutant);
    await bind(root, holder, makeItem({ title: 'ordinary row', value: 'ordinary' }), mutant);
    assert.throws(() => assert.deepEqual(viewStyle(holder), baselineStyle), `deleting ${field} copying must break actual version-to-ordinary restoration`);
    assert.notEqual(title.layoutParams[field], expectedValue);
  }

  const titleNoWeightReset = original.replace(/    iput v2, v1, Landroidx\/appcompat\/widget\/LinearLayoutCompat\$LayoutParams;->weight:F\r?\n/, '');
  await versionMutationFails(root, titleNoWeightReset, (holder) => assert.equal(holder.views.get(0x7f0900b2).layoutParams.weight, 0));

  const valueNoMaxWidth = original.replace(/    invoke-virtual \{p2, v3\}, Landroid\/widget\/TextView;->setMaxWidth\(I\)V\r?\n/, '');
  await versionMutationFails(root, valueNoMaxWidth, (holder) => assert.equal(holder.views.get(0x7f0900dd).maxWidth, 2147483647));

  const titleNoMultiline = original.replace(/    invoke-virtual \{p1, v3\}, Landroid\/widget\/TextView;->setMaxLines\(I\)V\r?\n/, '');
  await versionMutationFails(root, titleNoMultiline, (holder) => assert.equal(holder.views.get(0x7f0900b2).maxLines, 2147483647));

  const wrongOuterDirection = original.replace(/(    invoke-static \{v7, v8\}, Lcom\/suda\/yzune\/wakeupschedule\/settings\/o00O000o;->slimApplyType1Style[^\r\n]*\r?\n)/, '$1    iget-object v0, v7, Landroidx/recyclerview/widget/RecyclerView$ViewHolder;->itemView:Landroid/view/View;\n    const/4 v1, 0x0\n    invoke-virtual {v0, v1}, Landroidx/appcompat/widget/LinearLayoutCompat;->setOrientation(I)V\n');
  assert.notEqual(wrongOuterDirection, original, 'the outer-orientation mutant changes the actual 6.6.0 bind call');
  await versionMutationFails(root, wrongOuterDirection, (holder) => assert.equal(holder.itemView.orientation, 1));

  const binder = methodBlock(original, bindDescriptor);
  const hiddenHeight = '    iput v2, v0, Landroid/view/ViewGroup$LayoutParams;->height:I';
  assert.equal((binder.match(/iput v2, v0, Landroid\/view\/ViewGroup\$LayoutParams;->height:I/g) ?? []).length, 1,
    'the production hidden-row branch has one zero-height write');
  const hiddenBinder = binder.replace(hiddenHeight, '    const/4 v2, -0x2\n' + hiddenHeight);
  assert.notEqual(hiddenBinder, binder, 'the hidden-row mutant changes the actual 6.6.0 early return');
  const binderStart = original.indexOf('.method ' + bindDescriptor);
  const binderEnd = original.indexOf('.end method', binderStart) + '.end method'.length;
  assert.ok(binderStart >= 0 && binderEnd > binderStart, 'the raw provider method is present for the hidden-row mutant');
  const rawBinder = original.slice(binderStart, binderEnd);
  const lineBreak = rawBinder.includes('\r\n') ? '\r\n' : '\n';
  assert.equal((rawBinder.match(/iput v2, v0, Landroid\/view\/ViewGroup\$LayoutParams;->height:I/g) ?? []).length, 1,
    'the raw provider method contains the same unique hidden-row write');
  const rawHiddenBinder = rawBinder.replace(hiddenHeight, '    const/4 v2, -0x2' + lineBreak + hiddenHeight);
  const hiddenForcedVisible = original.slice(0, binderStart) + rawHiddenBinder + original.slice(binderEnd);
  assert.notEqual(hiddenForcedVisible, original, 'the raw CRLF provider method receives the hidden-row mutation');
  const hiddenHolder = createInitialItem(2, 0, [0, 0, 0, 0], 'light', 'middle');
  await bind(root, hiddenHolder, makeItem({ visible: false }), hiddenForcedVisible);
  assert.throws(() => assert.equal(hiddenHolder.itemView.layoutParams.height, 0));

  const textMutant = original.replace(/    :slim_type1_return\r?\n/, '    invoke-virtual {p1}, Landroid/widget/TextView;->setText(Ljava/lang/CharSequence;)V\n    :slim_type1_return\n');
  assert.throws(() => assertT32Contract(textMutant, providerSource), /setText/i);
  const eventMutant = original.replace(/    :slim_type1_return\r?\n/, '    const/4 v0, 0x0\n    invoke-virtual {p1, v0}, Landroid/view/View;->setClickable(Z)V\n    :slim_type1_return\n');
  assert.throws(() => assertT32Contract(eventMutant, providerSource), /clickable/i);

  const wrongDp = original.replace(/(\.method private static slimApplyVersionStyle[\s\S]*?const\/high16 v5, )0x42800000/, '$10x41800000');
  assert.notEqual(wrongDp, original, 'the wrong-dp mutant changes the actual 6.6.0 minimum-height constant');
  await versionMutationFails(root, wrongDp, (holder) => assert.equal(holder.views.get(0x7f09009d).minimumHeight, Math.trunc(64 * 1.25)));
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

