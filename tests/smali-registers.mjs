// Conservative ART-style verification for one Smali method. Registers carry a category
// (undefined, zero, int, wide, reference, uninitialized) and, for references, a class when it is
// certain. Every use is checked against the type its instruction requires; reference classes are
// only compared when the hierarchy proves they are incompatible, so unknown classes never fail.
import { closeSync, openSync, readdirSync, readFileSync, readSync } from 'node:fs';
import path from 'node:path';

const FINAL_CLASSES = new Set(['Ljava/lang/String;', 'Ljava/lang/Integer;', 'Ljava/lang/Long;', 'Ljava/lang/Boolean;', 'Ljava/lang/Double;',
  'Ljava/lang/Float;', 'Ljava/lang/Short;', 'Ljava/lang/Byte;', 'Ljava/lang/Character;', 'Ljava/lang/Class;']);

export function splitSmaliMethods(source) {
  const methods = new Map();
  const pattern = /^\.method (.+)$([\s\S]*?)^\.end method$/gm;
  let match;
  while ((match = pattern.exec(source))) methods.set(match[1].trim(), match[2]);
  return methods;
}

function parseTypes(list) {
  return list.match(/\[*(?:L[^;]+;|[ZBSCIJFDV])/g) ?? [];
}

function parseMethodRef(text) {
  const match = /(\[*L[^;]+;|\[+[ZBSCIJFD])->([^(]+)\(([^)]*)\)(\S+)/.exec(text);
  return match ? { owner: match[1], name: match[2], params: parseTypes(match[3]), returns: match[4] } : null;
}

function parseFieldRef(text) {
  const match = /(L[^;]+;)->[^:]+:(\S+)/.exec(text);
  return match ? { owner: match[1], type: match[2] } : null;
}

const isWideType = (type) => type === 'J' || type === 'D';
const isRefType = (type) => type.startsWith('L') || type.startsWith('[');

// Class bodies are read lazily from the decoded trees so only referenced classes are parsed.
// apktool renames case-colliding paths on case-insensitive file systems (o000O0o0.1/), so classes are
// indexed by their `.class` line rather than by path. Each root is scanned once per process.
const rootIndexes = new Map();

function indexRoot(root) {
  const key = path.resolve(root);
  if (rootIndexes.has(key)) return rootIndexes.get(key);
  const files = new Map();
  const head = Buffer.alloc(512);
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.smali')) {
        const fd = openSync(full, 'r');
        let length;
        try { length = readSync(fd, head, 0, head.length, 0); } finally { closeSync(fd); }
        const descriptor = /^\.class [^\n]*?(L[^;\s]+;)/m.exec(head.toString('utf8', 0, length))?.[1];
        if (descriptor && !files.has(descriptor)) files.set(descriptor, full);
      }
    }
  };
  let names = [];
  try { names = readdirSync(key).filter((name) => name.startsWith('smali')); } catch {}
  for (const name of names) walk(path.join(key, name));
  rootIndexes.set(key, files);
  return files;
}

// Earlier roots win over later ones, so a patched tree can shadow its baseline.
export function classHierarchy(roots) {
  const files = new Map();
  for (const root of roots) for (const [descriptor, file] of indexRoot(root)) if (!files.has(descriptor)) files.set(descriptor, file);
  const packages = new Set([...files.keys()].map((descriptor) => descriptor.slice(0, descriptor.lastIndexOf('/') + 1)));
  const cache = new Map();
  const lookup = (type) => {
    if (cache.has(type)) return cache.get(type);
    let info = null;
    const file = files.get(type);
    if (file) {
      const source = readFileSync(file, 'utf8');
      const header = /^\.class ([^\n]*?)(L[^;]+;)\s*$/m.exec(source);
      info = {
        interface: /\binterface\b/.test(header?.[1] ?? ''),
        final: /\bfinal\b/.test(header?.[1] ?? ''),
        super: /^\.super (L[^;]+;)/m.exec(source)?.[1] ?? null,
        interfaces: [...source.matchAll(/^\.implements (L[^;]+;)/gm)].map((match) => match[1]),
        methods: new Set([...source.matchAll(/^\.method [^\n]*?([^\s(]+\([^)]*\)\S+)\s*$/gm)].map((match) => match[1])),
        fields: new Set([...source.matchAll(/^\.field [^\n]*?([^\s:]+:[^\s=]+)/gm)].map((match) => match[1])),
      };
    }
    cache.set(type, info);
    return info;
  };
  // A member resolves unless every class it could be inherited from is an app class that lacks it.
  const resolves = (owner, member, kind) => {
    const seen = new Set();
    const pending = [owner];
    while (pending.length) {
      const current = pending.pop();
      if (seen.has(current)) continue;
      seen.add(current);
      const info = lookup(current);
      // An unknown class outside the app's packages is a framework class; one inside them is missing.
      if (!info) {
        if (current === 'Ljava/lang/Object;') {
          if (kind === 'methods' && OBJECT_METHODS.has(member)) return true;
          continue;
        }
        if (FRAMEWORK.test(current) || !packages.has(current.slice(0, current.lastIndexOf('/') + 1))) return true;
        continue;
      }
      if (info[kind].has(member)) return true;
      if (info.super) pending.push(info.super);
      pending.push(...info.interfaces);
    }
    return false;
  };
  return { lookup, resolves };
}

// Returns false only when the hierarchy proves `actual` can never be assigned to `expected`.
function mayAssign(actual, expected, hierarchy) {
  if (!actual || !expected || actual === expected || expected === 'Ljava/lang/Object;') return true;
  if (actual.startsWith('[') || expected.startsWith('[')) {
    if (expected.startsWith('[') && !actual.startsWith('[')) return false;
    if (!expected.startsWith('[')) return ['Ljava/lang/Cloneable;', 'Ljava/io/Serializable;'].includes(expected) || !hierarchy;
    return mayAssign(actual.slice(1), expected.slice(1), hierarchy) || !isRefType(actual.slice(1)) === !isRefType(expected.slice(1)) && actual.slice(1) === expected.slice(1);
  }
  if (FINAL_CLASSES.has(expected)) return false;
  if (FINAL_CLASSES.has(actual)) {
    const supers = { 'Ljava/lang/String;': ['Ljava/lang/CharSequence;', 'Ljava/io/Serializable;', 'Ljava/lang/Comparable;'] };
    const numberLike = ['Ljava/lang/Integer;', 'Ljava/lang/Long;', 'Ljava/lang/Double;', 'Ljava/lang/Float;', 'Ljava/lang/Short;', 'Ljava/lang/Byte;'];
    const allowed = new Set([...(supers[actual] ?? []), 'Ljava/io/Serializable;', 'Ljava/lang/Comparable;', ...(numberLike.includes(actual) ? ['Ljava/lang/Number;'] : []),
      ...(actual === 'Ljava/lang/Class;' ? ['Ljava/lang/reflect/Type;', 'Ljava/lang/reflect/GenericDeclaration;', 'Ljava/lang/reflect/AnnotatedElement;'] : [])]);
    return allowed.has(expected);
  }
  if (!hierarchy) return true;
  const expectedInfo = hierarchy.lookup(expected);
  if (!expectedInfo || expectedInfo.interface) return true;
  // expected is an app class: actual must reach it through its known superclass chain.
  for (let current = actual, depth = 0; current && depth < 64; depth++) {
    if (current === expected) return true;
    const info = hierarchy.lookup(current);
    // Framework classes never extend app classes; an unknown app-side link is not provable.
    if (!info) return !FRAMEWORK.test(current);
    current = info.super;
  }
  return false;
}

const OBJECT_METHODS = new Set(['<init>()V', 'equals(Ljava/lang/Object;)Z', 'hashCode()I', 'toString()Ljava/lang/String;', 'getClass()Ljava/lang/Class;',
  'notify()V', 'notifyAll()V', 'wait()V', 'wait(J)V', 'wait(JI)V', 'clone()Ljava/lang/Object;', 'finalize()V']);
const FRAMEWORK = /^L(?:java|javax|android|dalvik)\//;

const UNDEF = { kind: 'undef' };
const ZERO = { kind: 'zero' };
const INT = { kind: 'int' };
const WIDE = { kind: 'wide' };
const ref = (type) => ({ kind: 'ref', type: type ?? null });
const fromDescriptor = (type) => (isWideType(type) ? WIDE : isRefType(type) ? ref(type) : INT);

// A merged reference keeps the alternative types it came from, so later checks can reason about each of them.
const refTypes = (value) => value.alts ?? [value.type];

function join(a, b) {
  if (a === b) return a;
  if (!a || !b || a.kind === 'undef' || b.kind === 'undef') return UNDEF;
  if (a.kind === 'conflict' || b.kind === 'conflict') return { kind: 'conflict' };
  if (a.kind === 'zero') return b.kind === 'uninit' ? { kind: 'conflict' } : b;
  if (b.kind === 'zero') return a.kind === 'uninit' ? { kind: 'conflict' } : a;
  if (a.kind !== b.kind) return { kind: 'conflict' };
  if (a.kind === 'ref') {
    const types = [...new Set([...refTypes(a), ...refTypes(b)])].sort((x, y) => String(x).localeCompare(String(y)));
    const merged = types.length === 1 ? ref(types[0]) : { ...ref(null), ...(types.length <= 16 ? { alts: types } : {}) };
    // A register keeps its monitor only when every incoming path holds the same locked object.
    if (a.lock !== undefined && a.lock === b.lock) merged.lock = a.lock;
    if (a.id !== undefined && a.id === b.id) merged.id = a.id;
    return same(merged, a) ? a : merged;
  }
  if (a.kind === 'uninit') return a.site === b.site ? a : { kind: 'conflict' };
  return a;
}

const same = (a, b) => a === b || (a && b && a.kind === b.kind && a.type === b.type && a.site === b.site
  && a.lock === b.lock && a.id === b.id && String(a.alts) === String(b.alts));

// True only when the hierarchy proves `type` is not a Throwable.
function notThrowable(type, hierarchy) {
  if (!type) return false;
  if (type.startsWith('[') || FINAL_CLASSES.has(type)) return true;
  if (!hierarchy) return false;
  for (let current = type, depth = 0; current && depth < 64; depth++) {
    if (current === 'Ljava/lang/Throwable;') return false;
    const info = hierarchy.lookup(current);
    if (!info) return current === 'Ljava/lang/Object;';
    if (info.interface) return false;
    current = info.super;
  }
  return false;
}

export function registerErrors(header, body, hierarchy = null) {
  const lines = body.split(/\r?\n/).map((line) => line.trim());
  let locals = null;
  let registers = null;
  for (const line of lines) {
    const localsMatch = /^\.locals (\d+)/.exec(line);
    if (localsMatch) locals = Number(localsMatch[1]);
    const registersMatch = /^\.registers (\d+)/.exec(line);
    if (registersMatch) registers = Number(registersMatch[1]);
  }
  if (/\b(abstract|native)\b/.test(header) || (locals === null && registers === null)) return [];
  const isStatic = /\bstatic\b/.test(header);
  const isConstructor = /\bconstructor\b/.test(header) || /\s<init>\(/.test(` ${header}`);
  const signature = parseMethodRef(`Lself;->${header.split(/\s+/).pop()}`);
  const declaredReturn = signature?.returns ?? 'V';
  const paramTypes = signature?.params ?? [];
  const params = (isStatic ? 0 : 1) + paramTypes.reduce((sum, type) => sum + (isWideType(type) ? 2 : 1), 0);
  if (locals === null) locals = registers - params;
  const total = locals + params;
  const register = (token) => (token[0] === 'p' ? locals : 0) + Number(token.slice(1));

  const instructions = [];
  const labels = new Map();
  const tries = [];
  const switches = new Map();
  let pending = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith(':')) { pending.push(line); continue; }
    if (/^\.(packed|sparse)-switch/.test(line)) {
      const targets = [];
      for (index++; !/^\.end (packed|sparse)-switch/.test(lines[index]); index++) {
        const target = /(:\S+)\s*$/.exec(lines[index]);
        if (target) targets.push(target[1]);
      }
      for (const label of pending) switches.set(label, targets);
      pending = [];
      continue;
    }
    if (/^\.array-data/.test(line)) {
      for (index++; !/^\.end array-data/.test(lines[index]); index++);
      pending = [];
      continue;
    }
    const handler = /^\.catch(all)?\s*(\S*)\s*\{(:\S+) \.\. (:\S+)\}\s+(:\S+)/.exec(line);
    if (handler) { tries.push({ type: handler[1] ? 'Ljava/lang/Throwable;' : handler[2], start: handler[3], end: handler[4], handler: handler[5] }); continue; }
    if (line.startsWith('.')) continue;
    for (const label of pending) labels.set(label, instructions.length);
    pending = [];
    instructions.push(line);
  }
  for (const label of pending) labels.set(label, instructions.length);

  const parsed = instructions.map((text) => {
    const op = text.split(/\s+/)[0];
    const rest = text.slice(op.length).replace(/"(?:[^"\\]|\\.)*"/g, '""');
    const memberless = rest.replace(/(\[*L[^;\s]*;|\[+[ZBSCIJFD])->\S+/g, '');
    const registerText = memberless.replace(/\[*L[^;]*;/g, '').replace(/:\S+/g, '');
    let regs = [];
    const range = /\{([vp]\d+) \.\. ([vp]\d+)\}/.exec(registerText);
    if (range) for (let value = register(range[1]); value <= register(range[2]); value++) regs.push(value);
    else regs = (registerText.match(/\b[vp]\d+\b/g) ?? []).map(register);
    const literal = /,\s*(-?0x[0-9a-fA-F]+|-?\d+)L?\s*$/.exec(rest);
    const typeOperand = /(\[*L[^;]+;|\[+[ZBSCIJFD])\s*$/.exec(memberless);
    return { op, text, regs, rest, labels: memberless.match(/:\S+/g) ?? [], literal: literal ? Number(literal[1]) : null, typeOperand: typeOperand?.[1] ?? null };
  });

  const successors = parsed.map((instruction, index) => {
    const next = [];
    if (/^goto/.test(instruction.op)) next.push(labels.get(instruction.labels[0]));
    else if (/^if-/.test(instruction.op)) next.push(labels.get(instruction.labels[0]), index + 1);
    else if (/^(packed|sparse)-switch$/.test(instruction.op)) {
      next.push(index + 1);
      for (const target of switches.get(instruction.labels[0]) ?? []) next.push(labels.get(target));
    } else if (!/^(return|throw)/.test(instruction.op)) next.push(index + 1);
    return next.filter((value) => value !== undefined && value < parsed.length);
  });
  const handlers = parsed.map(() => []);
  for (const range of tries) {
    for (let index = labels.get(range.start); index < labels.get(range.end); index++) handlers[index].push({ target: labels.get(range.handler), type: range.type });
  }

  const entry = Array.from({ length: total }, () => UNDEF);
  let slot = locals;
  if (!isStatic) entry[slot++] = isConstructor ? { kind: 'this-uninit' } : { ...ref(null), id: 'this' };
  for (const type of paramTypes) {
    if (isWideType(type)) { entry[slot++] = WIDE; entry[slot++] = { kind: 'wide-hi' }; } else {
      const value = fromDescriptor(type);
      entry[slot] = value.kind === 'ref' ? { ...value, id: `p${slot}` } : value;
      slot++;
    }
  }

  const errors = new Set();
  const report = (message, instruction) => errors.add(`${message}: ${instruction.text}`);
  const checkField = (instruction) => {
    const match = /(L[^;]+;)->(\S+)/.exec(instruction.rest);
    if (hierarchy && match && !hierarchy.resolves(match[1], match[2], 'fields')) report(`unresolved field ${match[1]}->${match[2]}`, instruction);
  };
  const expect = (state, value, type, instruction) => {
    const actual = state[value];
    if (!actual || actual.kind === 'undef') return report(`undefined v${value}`, instruction);
    if (actual.kind === 'conflict') return report(`conflicting types in v${value}`, instruction);
    if (actual.kind === 'this-uninit') return;
    if (isWideType(type)) {
      if (actual.kind !== 'wide') report(`v${value} is not a wide value`, instruction);
      return;
    }
    if (isRefType(type)) {
      if (actual.kind === 'zero') return;
      if (actual.kind === 'uninit') return report(`uninitialized v${value} used as ${type}`, instruction);
      if (actual.kind !== 'ref') return report(`v${value} is ${actual.kind}, expected reference ${type}`, instruction);
      if (!mayAssign(actual.type, type, hierarchy)) report(`v${value} is ${actual.type}, expected ${type}`, instruction);
      return;
    }
    if (actual.kind !== 'int' && actual.kind !== 'zero') report(`v${value} is ${actual.kind}${actual.type ? ` ${actual.type}` : ''}, expected ${type}`, instruction);
  };
  const expectRef = (state, value, instruction) => {
    const actual = state[value];
    if (!actual || actual.kind === 'undef') return report(`undefined v${value}`, instruction);
    if (!['ref', 'zero', 'this-uninit'].includes(actual.kind)) report(`v${value} is ${actual.kind}, expected reference`, instruction);
  };
  const expectAny = (state, value, instruction) => {
    const actual = state[value];
    if (!actual || actual.kind === 'undef') report(`undefined v${value}`, instruction);
    else if (actual.kind === 'conflict') report(`conflicting types in v${value}`, instruction);
  };
  const setWide = (state, value) => { state[value] = WIDE; state[value + 1] = { kind: 'wide-hi' }; };

  function step(index, state) {
    const instruction = parsed[index];
    const { op, regs } = instruction;
    const out = state.slice();
    const previous = parsed[index - 1];
    const write = (value, type) => {
      if (out[value - 1]?.kind === 'wide') out[value - 1] = UNDEF;
      // Each newly produced reference gets an identity; move-object copies it, so aliases of a locked object stay locked.
      out[value] = type.kind === 'ref' && type.id === undefined ? { ...type, id: index } : type;
    };
    if (/^nop$/.test(op)) return out;
    if (/^const(\/4|\/16|\/high16)?$/.test(op)) { write(regs[0], instruction.literal === 0 ? ZERO : INT); return out; }
    if (/^const-wide/.test(op)) { setWide(out, regs[0]); return out; }
    if (/^const-string/.test(op)) { write(regs[0], ref('Ljava/lang/String;')); return out; }
    if (/^const-class/.test(op)) { write(regs[0], ref('Ljava/lang/Class;')); return out; }
    if (/^const-method-(handle|type)/.test(op)) { write(regs[0], ref(null)); return out; }
    if (/^move-wide/.test(op)) { if (state[regs[1]]?.kind !== 'wide') report(`v${regs[1]} is not a wide value`, instruction); setWide(out, regs[0]); return out; }
    if (/^move-object/.test(op)) {
      if (state[regs[1]]?.kind !== 'uninit') expectRef(state, regs[1], instruction);
      write(regs[0], state[regs[1]] ?? UNDEF);
      return out;
    }
    if (/^move(\/from16|\/16)?$/.test(op)) {
      const kind = state[regs[1]]?.kind;
      if (kind !== 'int' && kind !== 'zero') report(`v${regs[1]} is ${kind}, expected int`, instruction);
      write(regs[0], state[regs[1]] ?? UNDEF);
      return out;
    }
    if (/^move-result/.test(op)) {
      const call = previous && /^(invoke-|filled-new-array)/.test(previous.op) && !labelled.has(index) ? previous : null;
      if (!call) { report('orphan move-result', instruction); write(regs[0], UNDEF); return out; }
      const returns = /^filled-new-array/.test(call.op) ? call.typeOperand : parseMethodRef(call.rest)?.returns;
      const wanted = op === 'move-result-wide' ? 'wide' : op === 'move-result-object' ? 'ref' : 'int';
      const got = !returns || returns === 'V' ? 'void' : isWideType(returns) ? 'wide' : isRefType(returns) ? 'ref' : 'int';
      if (got !== wanted) report(`${op} after a ${got} result`, instruction);
      if (wanted === 'wide') setWide(out, regs[0]); else write(regs[0], wanted === 'ref' ? ref(returns) : INT);
      return out;
    }
    if (/^move-exception/.test(op)) { write(regs[0], ref(null)); return out; }
    if (op === 'return-void') { if (declaredReturn !== 'V') report('return-void from a non-void method', instruction); return out; }
    if (/^return/.test(op)) {
      if (declaredReturn === 'V') report('value returned from a void method', instruction);
      else if (op === 'return-object' && !isRefType(declaredReturn)) report('return-object from a primitive method', instruction);
      else if (op === 'return-wide' && !isWideType(declaredReturn)) report('return-wide from a non-wide method', instruction);
      else if (op === 'return' && (isRefType(declaredReturn) || isWideType(declaredReturn))) report('return from a reference or wide method', instruction);
      else expect(state, regs[0], declaredReturn, instruction);
      return out;
    }
    if (/^(monitor-enter|monitor-exit|throw)$/.test(op)) {
      expectRef(state, regs[0], instruction);
      const actual = state[regs[0]];
      if (actual?.kind !== 'ref') return out;
      if (op === 'monitor-enter') {
        out[regs[0]] = { ...actual, lock: index };
        for (let other = 0; other < total; other++) {
          if (actual.id !== undefined && out[other]?.kind === 'ref' && out[other].id === actual.id) out[other] = { ...out[other], lock: index };
        }
      }
      if (op === 'monitor-exit' && actual.lock === undefined) report(`monitor-exit v${regs[0]} no longer holds the locked object`, instruction);
      const foreign = op === 'throw' ? refTypes(actual).find((type) => notThrowable(type, hierarchy)) : undefined;
      if (foreign) report(`thrown v${regs[0]} may hold non-Throwable ${foreign}`, instruction);
      return out;
    }
    if (op === 'check-cast') { expectRef(state, regs[0], instruction); write(regs[0], ref(instruction.typeOperand)); return out; }
    if (op === 'instance-of') { expectRef(state, regs[1], instruction); write(regs[0], INT); return out; }
    if (op === 'array-length') { expectRef(state, regs[1], instruction); write(regs[0], INT); return out; }
    if (op === 'new-instance') { write(regs[0], { kind: 'uninit', type: instruction.typeOperand, site: index }); return out; }
    if (op === 'new-array') { expect(state, regs[1], 'I', instruction); write(regs[0], ref(instruction.typeOperand)); return out; }
    if (/^filled-new-array/.test(op)) {
      const element = instruction.typeOperand?.slice(1) ?? 'I';
      for (const value of regs) expect(state, value, element, instruction);
      return out;
    }
    if (op === 'fill-array-data') { expectRef(state, regs[0], instruction); return out; }
    if (/^(packed|sparse)-switch$/.test(op)) { expect(state, regs[0], 'I', instruction); return out; }
    if (/^cmp/.test(op)) {
      const operand = /-(long|double)$/.test(op) ? 'J' : 'I';
      expect(state, regs[1], operand, instruction);
      expect(state, regs[2], operand, instruction);
      write(regs[0], INT);
      return out;
    }
    if (/^if-(eq|ne)z$/.test(op)) {
      const kind = state[regs[0]]?.kind;
      if (!kind || kind === 'undef' || kind === 'conflict' || kind === 'wide' || kind === 'wide-hi' || kind === 'uninit') report(`v${regs[0]} cannot be tested against zero`, instruction);
      return out;
    }
    if (/^if-[a-z]+z$/.test(op)) { expect(state, regs[0], 'I', instruction); return out; }
    if (/^if-(eq|ne)$/.test(op)) {
      const kinds = regs.map((value) => state[value]?.kind);
      const category = (kind) => (kind === 'ref' || kind === 'this-uninit' ? 'ref' : kind === 'int' ? 'int' : kind === 'zero' ? 'zero' : 'bad');
      const [a, b] = kinds.map(category);
      if (a === 'bad' || b === 'bad' || (a !== b && a !== 'zero' && b !== 'zero')) report('if-eq/ne compares incompatible values', instruction);
      return out;
    }
    if (/^if-/.test(op)) { expect(state, regs[0], 'I', instruction); expect(state, regs[1], 'I', instruction); return out; }
    if (/^aget/.test(op)) {
      expectRef(state, regs[1], instruction);
      expect(state, regs[2], 'I', instruction);
      if (op === 'aget-wide') setWide(out, regs[0]);
      else if (op === 'aget-object') {
        const array = state[regs[1]]?.type;
        write(regs[0], ref(array?.startsWith('[') && isRefType(array.slice(1)) ? array.slice(1) : null));
      } else write(regs[0], INT);
      return out;
    }
    if (/^aput/.test(op)) {
      expect(state, regs[0], op === 'aput-wide' ? 'J' : op === 'aput-object' ? 'Ljava/lang/Object;' : 'I', instruction);
      expectRef(state, regs[1], instruction);
      expect(state, regs[2], 'I', instruction);
      return out;
    }
    if (/^(iget|sget)/.test(op)) {
      const field = parseFieldRef(instruction.rest);
      if (op.startsWith('iget')) expect(state, regs[1], field?.owner ?? 'Ljava/lang/Object;', instruction);
      checkField(instruction);
      const type = field?.type ?? 'I';
      if (/-wide/.test(op)) setWide(out, regs[0]); else write(regs[0], fromDescriptor(type));
      if (field && (/-wide/.test(op) !== isWideType(type) || /-object/.test(op) !== isRefType(type))) report('field access width does not match field type', instruction);
      return out;
    }
    if (/^(iput|sput)/.test(op)) {
      const field = parseFieldRef(instruction.rest);
      expect(state, regs[0], field?.type ?? 'I', instruction);
      if (op.startsWith('iput')) {
        const owner = state[regs[1]];
        if (!(owner?.kind === 'this-uninit')) expect(state, regs[1], field?.owner ?? 'Ljava/lang/Object;', instruction);
      }
      checkField(instruction);
      if (field && (/-wide/.test(op) !== isWideType(field.type) || /-object/.test(op) !== isRefType(field.type))) report('field access width does not match field type', instruction);
      return out;
    }
    if (/^invoke-/.test(op)) {
      const method = parseMethodRef(instruction.rest);
      if (!method) return out;
      const isStaticCall = /^invoke-static/.test(op);
      const isPolymorphic = /^invoke-(polymorphic|custom)/.test(op);
      if (isPolymorphic) { for (const value of regs) expectAny(state, value, instruction); return out; }
      const expected = [...(isStaticCall ? [] : [method.owner]), ...method.params];
      const width = expected.reduce((sum, type, position) => sum + (position === 0 && !isStaticCall ? 1 : isWideType(type) ? 2 : 1), 0);
      if (width !== regs.length) { report(`invoke passes ${regs.length} registers for ${width} argument slots`, instruction); return out; }
      let cursor = 0;
      expected.forEach((type, position) => {
        const value = regs[cursor];
        if (position === 0 && !isStaticCall) {
          const receiver = state[value];
          if (method.name === '<init>') {
            if (!receiver || !['uninit', 'this-uninit'].includes(receiver.kind)) report(`<init> called on initialized v${value}`, instruction);
            else {
              const initialized = { ...(receiver.kind === 'this-uninit' ? ref(null) : ref(receiver.type)), id: receiver.kind === 'this-uninit' ? 'this' : receiver.site };
              for (let other = 0; other < total; other++) if (same(out[other], receiver)) out[other] = initialized;
            }
          } else if (receiver?.kind !== 'this-uninit') expect(state, value, method.owner.startsWith('[') ? 'Ljava/lang/Object;' : method.owner, instruction);
          cursor += 1;
          return;
        }
        if (isWideType(type)) {
          if (state[value]?.kind !== 'wide') report(`v${value} is not a wide value`, instruction);
          cursor += 2;
        } else { expect(state, value, type, instruction); cursor += 1; }
      });
      if (hierarchy && method.owner.startsWith('L')) {
        const member = /->(\S+)/.exec(instruction.rest)[1];
        if (!hierarchy.resolves(method.owner, member, 'methods')) report(`unresolved method ${method.owner}->${member}`, instruction);
        const info = hierarchy.lookup(method.owner);
        if (info && /^invoke-interface/.test(op) && !info.interface) report('invoke-interface on a class method', instruction);
        if (info && /^invoke-(virtual|super|direct)/.test(op) && info.interface && method.name !== '<init>') {
          if (!/^invoke-(super|direct)/.test(op)) report('invoke-virtual on an interface method', instruction);
        }
      }
      return out;
    }
    if (/^(neg|not)-(long|double)$|^(long|double)-to-(long|double)$/.test(op)) { expect(state, regs[1], 'J', instruction); setWide(out, regs[0]); return out; }
    if (/^(int|float)-to-(long|double)$/.test(op)) { expect(state, regs[1], 'I', instruction); setWide(out, regs[0]); return out; }
    if (/^(long|double)-to-(int|float)$/.test(op)) { expect(state, regs[1], 'J', instruction); write(regs[0], INT); return out; }
    if (/^(neg|not)-(int|float)$|^(int|float)-to-(int|float|byte|char|short)$/.test(op)) { expect(state, regs[1], 'I', instruction); write(regs[0], INT); return out; }
    const arithmetic = /^(add|sub|mul|div|rem|and|or|xor|shl|shr|ushr|rsub)-(int|long|float|double)(\/2addr|\/lit8|\/lit16)?$/.exec(op) ?? /^(rsub)-int(\/lit8)?$/.exec(op);
    if (arithmetic) {
      const wide = arithmetic[2] === 'long' || arithmetic[2] === 'double';
      const shift = /^(shl|shr|ushr)$/.test(arithmetic[1]);
      const operands = arithmetic[3] === '/2addr' ? [regs[0], regs[1]] : /lit/.test(arithmetic[3] ?? '') || arithmetic[1] === 'rsub' ? [regs[1]] : [regs[1], regs[2]];
      operands.forEach((value, position) => expect(state, value, wide && !(shift && position === operands.length - 1 && operands.length === 2) ? 'J' : 'I', instruction));
      if (wide) setWide(out, regs[0]); else write(regs[0], INT);
      return out;
    }
    for (const value of regs) expectAny(state, value, instruction);
    if (regs.length) write(regs[0], ref(null));
    return out;
  }

  const labelled = new Set(labels.values());
  const states = parsed.map(() => null);
  states[0] = entry;
  const work = [0];
  const merge = (index, incoming) => {
    if (index === undefined || index >= parsed.length) return;
    if (!states[index]) { states[index] = incoming.slice(); work.push(index); return; }
    let changed = false;
    for (let value = 0; value < total; value++) {
      const merged = join(states[index][value], incoming[value]);
      if (!same(merged, states[index][value])) { states[index][value] = merged; changed = true; }
    }
    if (changed) work.push(index);
  };
  // Like ART, only instructions that can throw reach their handlers, and monitor-exit reaches them already unlocked.
  const NON_THROWING = /^(nop|goto(\/16|\/32)?|const(\/4|\/16|\/high16)?|const-wide.*|move.*|return.*|if-.*|cmp.*|(neg|not)-.*|(int|long|float|double)-to-.*|(add|sub|mul|and|or|xor|shl|shr|ushr|rsub)-.*|(div|rem)-(float|double).*|packed-switch|sparse-switch)$/;
  while (work.length) {
    const index = work.pop();
    const { op } = parsed[index];
    if (!NON_THROWING.test(op)) {
      const thrown = op === 'monitor-exit' ? step(index, states[index]) : states[index];
      for (const handler of handlers[index]) merge(handler.target, thrown);
    }
    for (const next of successors[index]) merge(next, step(index, states[index]));
  }
  // Re-run once over the fixed point so every reported error reflects the final merged state.
  errors.clear();
  parsed.forEach((_, index) => { if (states[index]) step(index, states[index]); });
  return [...errors];
}

// Errors present in the patched method that the baseline method did not already have.
export function introducedRegisterErrors(header, baselineBody, patchedBody, hierarchy = null) {
  const before = new Set(baselineBody === undefined ? [] : registerErrors(header, baselineBody, hierarchy));
  return registerErrors(header, patchedBody, hierarchy).filter((error) => !before.has(error));
}
