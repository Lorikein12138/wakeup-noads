import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const DEBUG_DIRECTIVE = /^\s*\.(?:line|local|prologue|epilogue|end local|restart local)\b/;
const TYPE_DEFAULT_VALUES = { Z: 'false', B: '0x0t', S: '0x0s', C: "'\\u0000'", I: '0x0', J: '0x0L', F: '0.0f', D: '0.0' };

function withoutDefaultStaticValue(line) {
  const field = line.match(/^(\.field\s+(?:[a-z-]+\s+)*?static\s+.*?:(\S+)) = (.+)$/);
  if (!field) return line;
  const [, declaration, type, value] = field;
  const defaultValue = type.startsWith('L') || type.startsWith('[') ? 'null' : TYPE_DEFAULT_VALUES[type];
  return value === defaultValue ? declaration : line;
}
const LABEL_DECLARATION = /^\s*(:[A-Za-z0-9_$.-]+)\s*$/;

export async function readSmaliMethod(root, relativePath, classDescriptor, methodDescriptor) {
  const file = path.join(root, relativePath);
  const content = await readFile(file, 'utf8');
  const classLine = content.match(/^\.class\s+[^\r\n]*$/m)?.[0] ?? '';
  const actualClassDescriptor = classLine.trim().split(/\s+/).find((token) => /^L[^;\s]+;$/.test(token));
  if (actualClassDescriptor !== classDescriptor) throw new Error(`Class descriptor mismatch in ${relativePath}`);
  const inventory = parseSmaliClassStructure(content, relativePath);
  const requested = parseMethodHeader(`.method ${methodDescriptor}`, relativePath);
  const method = inventory.methods.find(({ methodDescriptor: descriptor, flags }) => descriptor === requested.methodDescriptor
    && JSON.stringify(flags) === JSON.stringify(requested.flags));
  if (!method) throw new Error(`Method descriptor not found in ${relativePath}: ${methodDescriptor}`);
  return method.source;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex').toUpperCase();
}

function stripComment(line) {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (escaped) { escaped = false; continue; }
    if (character === '\\') { escaped = true; continue; }
    if (quote) { if (character === quote) quote = null; continue; }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (character === '#') return line.slice(0, index);
  }
  return line;
}

function normalizeLineWhitespace(line) {
  let output = '';
  let pendingSpace = false;
  const flushSpace = () => {
    if (pendingSpace && output && !output.endsWith(' ')) output += ' ';
    pendingSpace = false;
  };
  const source = line.trim();
  for (let index = 0; index < source.length;) {
    const character = source[index];
    if (character === '"' || character === "'") {
      flushSpace();
      const quote = character;
      let value = '';
      index += 1;
      let closed = false;
      while (index < source.length) {
        const current = source[index++];
        if (current === quote) { closed = true; break; }
        if (current !== '\\') { value += current; continue; }
        if (index >= source.length) throw new Error(`Incomplete escape in Smali literal: ${line.trim()}`);
        const escape = source[index++];
        const simpleEscapes = { t: '\t', b: '\b', n: '\n', r: '\r', f: '\f', '\\': '\\', '"': '"', "'": "'" };
        if (Object.hasOwn(simpleEscapes, escape)) { value += simpleEscapes[escape]; continue; }
        if (escape === 'u') {
          const digits = source.slice(index, index + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(digits)) throw new Error(`Invalid Unicode escape in Smali literal: ${line.trim()}`);
          value += String.fromCharCode(Number.parseInt(digits, 16));
          index += 4;
          continue;
        }
        throw new Error(`Unsupported Smali string escape \\${escape} in ${line.trim()}`);
      }
      if (!closed) throw new Error(`Unterminated quoted literal in Smali: ${line.trim()}`);
      let encoded = '';
      for (const unit of value) {
        if (unit === '\\') encoded += '\\\\';
        else if (unit === quote) encoded += `\\${quote}`;
        else if (unit === '\t') encoded += '\\t';
        else if (unit === '\b') encoded += '\\b';
        else if (unit === '\n') encoded += '\\n';
        else if (unit === '\r') encoded += '\\r';
        else if (unit === '\f') encoded += '\\f';
        else encoded += unit;
      }
      output += `${quote}${encoded}${quote}`;
      continue;
    }
    if (/\s/.test(character)) { pendingSpace = true; index += 1; continue; }
    flushSpace();
    output += character;
    index += 1;
  }
  return output.trim();
}

function replaceLabelsOutsideStrings(line, labelMap) {
  let output = '';
  let quote = null;
  let escaped = false;
  for (let index = 0; index < line.length;) {
    const character = line[index];
    if (escaped) { output += character; escaped = false; index += 1; continue; }
    if (quote) {
      output += character;
      if (character === '\\') escaped = true;
      else if (character === quote) quote = null;
      index += 1;
      continue;
    }
    if (character === '"' || character === "'") { quote = character; output += character; index += 1; continue; }
    if (character === ':') {
      const match = line.slice(index).match(/^:[A-Za-z0-9_$.-]+/);
      if (match) {
        const canonical = labelMap.get(match[0]);
        output += canonical ?? match[0];
        index += match[0].length;
        continue;
      }
    }
    output += character;
    index += 1;
  }
  if (quote) throw new Error(`Unterminated quoted literal in Smali: ${line.trim()}`);
  return output;
}

function parseMethodHeader(header, location) {
  const match = header.trim().match(/^\.method\s+(.+)$/);
  if (!match) throw new Error(`Invalid method header in ${location}: ${header}`);
  const tokens = match[1].split(/\s+/);
  const methodDescriptor = tokens.pop();
  if (!/^[^\s(]+\([^)]*\).+$/.test(methodDescriptor)) throw new Error(`Invalid method descriptor in ${location}: ${methodDescriptor}`);
  const flags = tokens.sort();
  return { methodDescriptor, flags, header: `.method ${[...flags, methodDescriptor].join(' ')}` };
}

function normalizeMethodBody(source, location = '<method>') {
  const rawLines = source.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').split('\n');
  const normalizedLines = rawLines.map(stripComment).map(normalizeLineWhitespace).filter(Boolean).filter((line) => !DEBUG_DIRECTIVE.test(line));
  const payloadAlignmentNops = new Set();
  for (let index = 0; index + 2 < normalizedLines.length; index += 1) {
    if (normalizedLines[index] === 'nop' && LABEL_DECLARATION.test(normalizedLines[index + 1])
      && /^\.(?:packed-switch|sparse-switch|array-data)(?:\s|$)/.test(normalizedLines[index + 2])) {
      // DEX payload alignment can materialize as an otherwise unlabelled no-op only after assembly.
      payloadAlignmentNops.add(index);
    }
  }
  const lines = normalizedLines.filter((_, index) => !payloadAlignmentNops.has(index));
  const labels = new Map();
  const packedPayloadReferences = [];
  let payloadKind = null;
  let instructionOffset = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (/^\.(packed-switch|sparse-switch|array-data)(?:\s|$)/.test(lines[index])) { payloadKind = lines[index].match(/^\.(packed-switch|sparse-switch|array-data)/)[1]; continue; }
    if (payloadKind && lines[index] === `.end ${payloadKind}`) { payloadKind = null; continue; }
    const declaration = lines[index].match(LABEL_DECLARATION);
    if (declaration) {
      if (payloadKind === 'packed-switch') { packedPayloadReferences.push(declaration[1]); continue; }
      if (labels.has(declaration[1])) throw new Error(`Duplicate Smali label ${declaration[1]} in ${location}`);
      labels.set(declaration[1], instructionOffset);
      continue;
    }
    if (payloadKind === 'sparse-switch') {
      const reference = lines[index].match(/\s->\s*(:[A-Za-z0-9_$.-]+)\s*$/);
      if (!reference) throw new Error(`Unsupported sparse-switch entry in ${location}: ${lines[index]}`);
      packedPayloadReferences.push(reference[1]);
      continue;
    }
    if (!payloadKind && !lines[index].startsWith('.')) instructionOffset += 1;
  }
  const labelReferences = [...packedPayloadReferences];
  for (const line of lines) {
    let references = [];
    if (/^\.catch(?:all)?\s/.test(line)) {
      const protectedRange = line.match(/\{\s*(:[A-Za-z0-9_$.-]+)\s+\.\.\s+(:[A-Za-z0-9_$.-]+)\s*\}\s+(:[A-Za-z0-9_$.-]+)\s*$/);
      if (!protectedRange) throw new Error(`Unsupported catch structure in ${location}: ${line}`);
      references = protectedRange.slice(1);
    } else if (/^(?:if-[A-Za-z0-9/-]+|goto(?:\/[A-Za-z0-9]+)?|packed-switch|sparse-switch|fill-array-data)\b/.test(line)) {
      const reference = line.match(/(?:,|\s)(:[A-Za-z0-9_$.-]+)\s*$/);
      if (!reference) throw new Error(`Unsupported branch structure in ${location}: ${line}`);
      references = [reference[1]];
    } else if (/\s->\s*:[A-Za-z0-9_$.-]+\s*$/.test(line)) {
      references = [line.match(/\s->\s*(:[A-Za-z0-9_$.-]+)\s*$/)[1]];
    }
    for (const reference of references) {
      if (!labels.has(reference)) throw new Error(`Unresolved Smali label ${reference} in ${location}: ${line}`);
      labelReferences.push(reference);
    }
  }
  const referencedLabels = new Set(labelReferences);
  const targetName = (instructionIndex) => `:TARGET_${String(instructionIndex).padStart(6, '0')}`;
  const canonicalLabels = new Map([...labels]
    .filter(([label]) => referencedLabels.has(label))
    .map(([label, instructionIndex]) => [label, targetName(instructionIndex)]));
  const directiveStack = [];
  const startEndPairs = new Map([
    ['.annotation', '.end annotation'], ['.subannotation', '.end subannotation'],
    ['.packed-switch', '.end packed-switch'], ['.sparse-switch', '.end sparse-switch'],
    ['.array-data', '.end array-data'],
  ]);
  const endDirectives = new Set(startEndPairs.values());
  const canonicalLines = [];
  let canonicalPayload = null;
  for (const sourceLine of lines) {
    if (/^\.(packed-switch|sparse-switch|array-data)(?:\s|$)/.test(sourceLine)) canonicalPayload = sourceLine.match(/^\.(packed-switch|sparse-switch|array-data)/)[1];
    const declaration = sourceLine.match(LABEL_DECLARATION);
    if (declaration && canonicalPayload !== 'packed-switch') continue;
    const directive = sourceLine.match(/^\.([A-Za-z][A-Za-z0-9-]*)(?:\s|$)/)?.[1];
    const supportedDirectives = new Set(['locals', 'registers', 'catch', 'catchall', 'annotation', 'subannotation', 'end', 'param', 'packed-switch', 'sparse-switch', 'array-data']);
    if (directive && !supportedDirectives.has(directive)) throw new Error(`Unsupported Smali method directive .${directive} in ${location}: ${sourceLine}`);
    const line = replaceLabelsOutsideStrings(sourceLine, canonicalLabels);
    const startDirective = [...startEndPairs.keys()].find((directive) => line.startsWith(`${directive} `) || line === directive);
    if (startDirective) directiveStack.push(startEndPairs.get(startDirective));
    if (endDirectives.has(line)) {
      const expected = directiveStack.pop();
      if (expected !== line) throw new Error(`Unbalanced Smali directive ${line} in ${location}`);
      canonicalPayload = null;
    }
    canonicalLines.push(line);
  }
  if (directiveStack.length) throw new Error(`Unterminated Smali directive ${directiveStack.at(-1)} in ${location}`);
  const canonicalBody = canonicalLines.join('\n');
  const invokeEdges = [];
  const dynamicInvokeInstructions = [];
  const controlFlowEdges = [];
  for (const line of canonicalLines) {
    const match = line.match(/^(invoke-[^\s]+)\s+\{[^}]*\},\s*([^,\s]+)/);
    if (match) {
      const [, kind, target] = match;
      if (/^(?:L[^;]+;->|\[)/.test(target)) invokeEdges.push({ kind, target });
      else dynamicInvokeInstructions.push(line);
    }
    if (/^(?:if-[A-Za-z0-9/-]+|goto(?:\/[A-Za-z0-9]+)?|packed-switch|sparse-switch|fill-array-data)\b/.test(line)) {
      const target = line.match(/(:TARGET_\d+)\s*$/)?.[1];
      if (target) controlFlowEdges.push({ kind: line.split(/\s+/, 1)[0], targets: [target] });
    } else if (/^\.catch(?:all)?\s/.test(line)) {
      const targets = [...line.matchAll(/:TARGET_\d+/g)].map((item) => item[0]);
      controlFlowEdges.push({ kind: line.split(/\s+/, 1)[0], targets });
    } else if (/\s->\s*:TARGET_\d+\s*$/.test(line)) {
      controlFlowEdges.push({ kind: 'switch-case', targets: [line.match(/(:TARGET_\d+)\s*$/)[1]] });
    }
  }
  return { canonicalBody, invokeEdges, dynamicInvokeInstructions, controlFlowEdges };
}

export function executableSmaliMethod(source) {
  return parseSmaliMethodSource(source, '<method>').canonicalBody;
}

function parseSmaliMethodSource(source, location) {
  const lines = source.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((line) => /^\s*\.method\s+/.test(line));
  if (start < 0) {
    const body = normalizeMethodBody(source, location);
    return { methodDescriptor: null, flags: [], annotations: [], canonicalBody: body.canonicalBody, invokeEdges: body.invokeEdges, dynamicInvokeInstructions: body.dynamicInvokeInstructions, controlFlowEdges: body.controlFlowEdges, source: source.replace(/\r\n/g, '\n') };
  }
  const end = lines.findIndex((line, index) => index > start && /^\s*\.end method\s*$/.test(line));
  if (end < 0) throw new Error(`Unterminated Smali method in ${location}`);
  const { methodDescriptor, flags, header } = parseMethodHeader(lines[start], location);
  const bodySource = lines.slice(start + 1, end).join('\n');
  const body = normalizeMethodBody(bodySource, `${location} ${methodDescriptor}`);
  const sourceMethod = lines.slice(start, end + 1).join('\n');
  return {
    methodDescriptor,
    flags,
    header,
    annotations: body.canonicalBody.split('\n').filter((line) => /^\.(?:annotation|subannotation)\b/.test(line)),
    canonicalBody: body.canonicalBody,
    invokeEdges: body.invokeEdges,
    dynamicInvokeInstructions: body.dynamicInvokeInstructions,
    controlFlowEdges: body.controlFlowEdges,
    source: sourceMethod,
  };
}

export function normalizeSmaliMethod(source, location = '<method>') {
  const parsed = parseSmaliMethodSource(source, location);
  if (!parsed.methodDescriptor) return parsed.canonicalBody;
  return `${parsed.header}\n${parsed.canonicalBody}\n.end method`;
}

export function parseSmaliClassStructure(source, location = '<smali>') {
  const sourceForHash = source.replace(/^\uFEFF/, '');
  const normalizedSource = sourceForHash.replace(/\r\n/g, '\n');
  const lines = normalizedSource.split('\n');
  const classLines = lines.filter((line) => /^\s*\.class\s+/.test(line));
  if (classLines.length !== 1) throw new Error(`Expected exactly one .class declaration in ${location}, found ${classLines.length}`);
  const classHeader = normalizeLineWhitespace(stripComment(classLines[0]));
  const classMatch = classHeader.match(/^\.class\s+(.+)$/);
  const classTokens = classMatch?.[1].split(/\s+/) ?? [];
  const classDescriptor = classTokens.find((token) => /^L[^;\s]+;$/.test(token));
  if (!classDescriptor) throw new Error(`Class descriptor is missing in ${location}`);
  const classFlags = classTokens.filter((token) => token !== classDescriptor).sort();
  const methods = [];
  const structureLines = [];
  let cursor = 0;
  while (cursor < lines.length) {
    const line = lines[cursor];
    if (/^\s*\.method\s+/.test(line)) {
      const start = cursor;
      cursor += 1;
      while (cursor < lines.length && !/^\s*\.end method\s*$/.test(lines[cursor])) cursor += 1;
      if (cursor >= lines.length) throw new Error(`Unterminated method in ${location}: ${lines[start]}`);
      const method = parseSmaliMethodSource(lines.slice(start, cursor + 1).join('\n'), location);
      methods.push(method);
      cursor += 1;
      continue;
    }
    const stripped = normalizeLineWhitespace(stripComment(line));
    // DEX assembly drops trailing static initial values equal to the field type default.
    if (stripped && !DEBUG_DIRECTIVE.test(stripped)) structureLines.push(withoutDefaultStaticValue(stripped));
    cursor += 1;
  }
  const descriptors = new Set();
  for (const method of methods) {
    if (descriptors.has(method.methodDescriptor)) throw new Error(`Duplicate Smali method ${method.methodDescriptor} in ${location}`);
    descriptors.add(method.methodDescriptor);
  }
  methods.sort((left, right) => left.methodDescriptor.localeCompare(right.methodDescriptor));
  return { classDescriptor, classFlags, structureLines, methods, sourceSha256: sha256(Buffer.from(sourceForHash)) };
}

export function normalizeSmaliClass(source, location = '<smali>') {
  const parsed = parseSmaliClassStructure(source, location);
  const classLine = `.class ${[...parsed.classFlags, parsed.classDescriptor].join(' ')}`;
  const otherLines = parsed.structureLines.filter((line) => !/^\.class\s+/.test(line));
  const methodLines = parsed.methods.map((method) => `${method.header}\n${method.canonicalBody}\n.end method`);
  return [classLine, ...otherLines, ...methodLines].join('\n');
}

export function sameExecutableSmaliMethod(left, right) {
  return executableSmaliMethod(left) === executableSmaliMethod(right);
}

/** Extracts direct invoke targets from a method body after control-flow-safe label normalization. */
export function smaliInvokeEdges(source) {
  return parseMethodSourceEdges(source);
}

function parseMethodSourceEdges(source) {
  return parseSmaliMethodSource(source, '<method>').invokeEdges;
}

export function hasSmaliInvoke(source, target) {
  return smaliInvokeEdges(source).some((edge) => edge.target.includes(target));
}

function descriptorParameterWords(descriptor) {
  const signature = descriptor.match(/^[^(]+\(([^)]*)\)/)?.[1];
  if (signature === undefined) throw new Error(`Invalid method descriptor: ${descriptor}`);
  let words = 0;
  for (let index = 0; index < signature.length;) {
    const start = index;
    while (signature[index] === '[') index += 1;
    const kind = signature[index];
    if (!kind) throw new Error(`Invalid parameter descriptor: ${descriptor}`);
    if (kind === 'L') {
      const end = signature.indexOf(';', index);
      if (end < 0) throw new Error(`Invalid reference parameter descriptor: ${descriptor}`);
      index = end + 1;
      words += 1;
    } else {
      if (!'ZBCSIFJD'.includes(kind)) throw new Error(`Unsupported parameter kind ${kind} in ${descriptor}`);
      index += 1;
      words += kind === 'J' || kind === 'D' ? 2 : 1;
    }
    if (index === start) throw new Error(`Invalid parameter descriptor: ${descriptor}`);
  }
  return words;
}

function invokeRegisterCount(invokeLine) {
  const registers = invokeLine.match(/\{([^}]*)\}/)?.[1]?.trim();
  if (registers === undefined) throw new Error(`Invalid invoke register list: ${invokeLine}`);
  if (!registers) return 0;
  const range = registers.match(/^(v|p)(\d+)\s+\.\.\s+(v|p)(\d+)$/);
  if (range) {
    if (range[1] !== range[3]) throw new Error(`Invoke range crosses register banks: ${invokeLine}`);
    return Number(range[4]) - Number(range[2]) + 1;
  }
  return registers.split(',').map((register) => register.trim()).filter(Boolean).length;
}

/** Checks a private instance invoke ABI in a single class, including registers and void-result use. */
export function assertPrivateInvokeAbi(source, { classDescriptor, targetMethodDescriptor, callers }, location = '<smali>') {
  const parsed = parseSmaliClassStructure(source, location);
  if (parsed.classDescriptor !== classDescriptor) throw new Error(`ABI owner mismatch in ${location}`);
  const target = parsed.methods.find(({ methodDescriptor }) => methodDescriptor === targetMethodDescriptor);
  if (!target || !target.flags.includes('private') || !target.flags.includes('final')) {
    throw new Error(`Private final target ${targetMethodDescriptor} is missing in ${location}`);
  }
  const targetText = `${classDescriptor}->${targetMethodDescriptor}`;
  for (const callerSpec of callers) {
    const requested = parseMethodHeader(`.method ${callerSpec.methodDescriptor}`, location);
    const caller = parsed.methods.find(({ methodDescriptor, flags }) => methodDescriptor === requested.methodDescriptor
      && JSON.stringify(flags) === JSON.stringify(requested.flags));
    if (!caller) throw new Error(`Caller ${callerSpec.methodDescriptor} is missing in ${location}`);
    const matching = caller.canonicalBody.split('\n').filter((line) => line.includes(targetText));
    if (matching.length !== 1) throw new Error(`Expected one ${targetText} call in ${callerSpec.methodDescriptor}, found ${matching.length}`);
    const line = matching[0];
    if (!/^invoke-direct(?:\/range)?\s/.test(line)) throw new Error(`Private target must use invoke-direct in ${callerSpec.methodDescriptor}: ${line}`);
    const expectedWords = descriptorParameterWords(targetMethodDescriptor) + 1;
    if (invokeRegisterCount(line) !== expectedWords) throw new Error(`Wrong register word count for ${targetMethodDescriptor} in ${callerSpec.methodDescriptor}`);
    const instructions = caller.canonicalBody.split('\n');
    const instructionIndex = instructions.indexOf(line);
    const nextInstruction = instructions.slice(instructionIndex + 1).find((entry) => !entry.startsWith(':') && !entry.startsWith('.'));
    if (nextInstruction?.startsWith('move-result')) throw new Error(`Void private target result is incorrectly consumed in ${callerSpec.methodDescriptor}`);
  }
  return true;
}

export function sameSmaliMethodInventory(left, right) {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.methodDescriptor === right.methodDescriptor
    && JSON.stringify(left.flags) === JSON.stringify(right.flags)
    && JSON.stringify(left.annotations ?? []) === JSON.stringify(right.annotations ?? [])
    && left.native === right.native
    && left.normalizedBodySha256 === right.normalizedBodySha256
    && JSON.stringify(left.invokeEdges) === JSON.stringify(right.invokeEdges)
    && JSON.stringify(left.controlFlowEdges ?? []) === JSON.stringify(right.controlFlowEdges ?? [])
    && JSON.stringify(left.dynamicInvokeInstructions) === JSON.stringify(right.dynamicInvokeInstructions);
}

export function methodInventoryFromSmali(source, location = '<smali>') {
  const hasClass = /^\s*\.class\s/m.test(source);
  const parsed = hasClass ? parseSmaliClassStructure(source, location) : null;
  const standaloneMethod = parsed ? null : parseSmaliMethodSource(source, location);
  const methodSources = parsed ? parsed.methods : [standaloneMethod];
  return {
    classDescriptor: parsed?.classDescriptor ?? null,
    classFlags: parsed?.classFlags ?? [],
    normalizedClassSha256: parsed ? sha256(Buffer.from(normalizeSmaliClass(source, location))) : null,
    sourceSha256: parsed?.sourceSha256 ?? sha256(Buffer.from(source.replace(/^\uFEFF/, ''))),
    methods: methodSources.map(({ methodDescriptor, flags, annotations, canonicalBody, invokeEdges, dynamicInvokeInstructions, controlFlowEdges }) => ({
      methodDescriptor,
      flags,
      annotations,
      native: flags.includes('native'),
      normalizedBodySha256: sha256(Buffer.from(canonicalBody)),
      invokeEdges,
      invokeTargets: invokeEdges.map(({ target }) => target),
      dynamicInvokeInstructions,
      controlFlowEdges,
    })),
  };
}
