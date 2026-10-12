import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultSpecPath = path.resolve(here, '../patches/slim-v1/patch-spec.json');

const sha256 = (value) => createHash('sha256').update(value).digest('hex').toUpperCase();
const asDigest = (text) => sha256(Buffer.from(text, 'utf8'));

export class PatchError extends Error {
  constructor(message, operationId = null) {
    super(operationId ? `${operationId}: ${message}` : message);
    this.name = 'PatchError';
    this.operationId = operationId;
  }
}

function assertRelativePath(relative, operationId) {
  if (typeof relative !== 'string' || relative.length === 0 || path.isAbsolute(relative) || path.win32.isAbsolute(relative) || relative.includes('\0')) {
    throw new PatchError('target path must be a non-empty relative path', operationId);
  }
  const segments = relative.replaceAll('\\', '/').split('/');
  if (segments.some((part) => part === '..' || part === '.' || part.length === 0)) {
    throw new PatchError('target path contains an unsafe segment', operationId);
  }
}

async function resolveSafeTarget(root, relative, operationId) {
  assertRelativePath(relative, operationId);
  const rootReal = await realpath(root);
  const normalized = path.resolve(rootReal, relative);
  const relativeToRoot = path.relative(rootReal, normalized);
  if (!relativeToRoot || relativeToRoot.startsWith(`..${path.sep}`) || relativeToRoot === '..' || path.isAbsolute(relativeToRoot)) {
    throw new PatchError('target must be a file below the decoded root', operationId);
  }
  let cursor = rootReal;
  for (const segment of relativeToRoot.split(path.sep)) {
    cursor = path.join(cursor, segment);
    let info;
    try {
      info = await lstat(cursor);
    } catch (error) {
      if (error.code === 'ENOENT') throw new PatchError(`target does not exist: ${relative}`, operationId);
      throw error;
    }
    if (info.isSymbolicLink()) throw new PatchError('symbolic links are not patch targets', operationId);
  }
  const targetReal = await realpath(normalized);
  if (!targetReal.startsWith(`${rootReal}${path.sep}`)) throw new PatchError('resolved target escapes decoded root', operationId);
  return targetReal;
}

function methodBounds(content, descriptor, operationId) {
  const lines = content.split(/(?<=\n)/);
  let classDescriptor = null;
  let lineOffset = 0;
  let start = -1;
  let end = -1;
  for (const line of lines) {
    if (line.startsWith('.class ')) classDescriptor = line.trim().split(/\s+/).at(-1);
    if (line.startsWith('.method ')) {
      if (start >= 0) throw new PatchError('malformed smali: nested method', operationId);
      const normalizedMethod = line.trim().replace(/^\.method\s+/, '');
      if (normalizedMethod === descriptor.methodDescriptor) start = lineOffset;
    } else if (line.startsWith('.end method') && start >= 0) {
      end = lineOffset + line.length;
      break;
    }
    lineOffset += line.length;
  }
  if (classDescriptor !== descriptor.classDescriptor) throw new PatchError(`class descriptor mismatch (found ${classDescriptor ?? 'none'})`, operationId);
  if (start < 0 || end < 0) throw new PatchError(`method descriptor not found: ${descriptor.methodDescriptor}`, operationId);
  return [start, end];
}

function countExact(text, needle) {
  if (needle.length === 0) throw new Error('empty patch fragment is not allowed');
  let count = 0;
  let index = -1;
  while ((index = text.indexOf(needle, index + 1)) >= 0) count += 1;
  return count;
}

function normalizeLineEndings(value, lineEnding) {
  return value.replace(/\r\n/g, '\n').replace(/\n/g, lineEnding);
}

function validateOperationShape(operation) {
  const id = operation?.id;
  if (!id || typeof id !== 'string') throw new PatchError('operation id is required');
  if (!operation.evidence || !/^E\d{2}$/.test(operation.evidence)) throw new PatchError('evidence must be an E identifier', id);
  if (!operation.relativePath) throw new PatchError('relativePath is required', id);
  const hitCount = operation.expectedHits ?? 1;
  if (!Number.isInteger(hitCount) || hitCount < 1) throw new PatchError('expectedHits must be a positive integer', id);
  if (operation.method && (!operation.method.classDescriptor || !operation.method.methodDescriptor)) throw new PatchError('method operations require full class and method descriptors', id);
  if (!operation.method && !operation.xmlNode && !operation.fileScope) throw new PatchError('operation must identify a method, XML node, or explicit file scope', id);
  if (operation.replacementMethod || operation.replacementBody) {
    if (!operation.method || !/^[A-Fa-f0-9]{64}$/.test(operation.expectedMethodSha256 ?? '')) throw new PatchError('whole-method replacement requires a method descriptor and expected method SHA-256', id);
    if (operation.replacementMethod && typeof operation.replacementMethod !== 'string') throw new PatchError('replacementMethod must be a complete .method block', id);
    if (operation.replacementBody && typeof operation.replacementBody !== 'string') throw new PatchError('replacementBody must be a method body string', id);
  } else if (!operation.expectedOriginal || typeof operation.replacement !== 'string') {
    throw new PatchError('exact-fragment operations require expectedOriginal and replacement', id);
  }
}

function applyOperation(content, operation) {
  validateOperationShape(operation);
  const [methodStart, methodEnd] = operation.method
    ? methodBounds(content, { ...operation.method, classDescriptor: operation.method.classDescriptor }, operation.id)
    : [0, content.length];
  const beforeScope = content.slice(methodStart, methodEnd);
  if (operation.replacementMethod || operation.replacementBody) {
    const currentHash = sha256(Buffer.from(beforeScope.replace(/\r\n/g, '\n'), 'utf8'));
    if (currentHash !== operation.expectedMethodSha256.toUpperCase()) {
      const expectedHeader = beforeScope.split(/\r?\n/, 1)[0];
      const replacementHash = operation.replacementMethod
        ? sha256(Buffer.from(operation.replacementMethod.replace(/\r\n/g, '\n'), 'utf8'))
        : sha256(Buffer.from(`${expectedHeader}\n${operation.replacementBody.trim()}\n.end method\n`, 'utf8'));
      if (currentHash === replacementHash) throw new PatchError('patch has already been applied', operation.id);
      throw new PatchError(`method SHA-256 changed (found ${currentHash})`, operation.id);
    }
    const lineEnding = beforeScope.includes('\r\n') ? '\r\n' : '\n';
    const methodHeader = beforeScope.split(/\r?\n/, 1)[0];
    const replacement = operation.replacementMethod
      ? normalizeLineEndings(operation.replacementMethod, lineEnding)
      : `${methodHeader}${lineEnding}${normalizeLineEndings(operation.replacementBody.trim(), lineEnding)}${lineEnding}.end method${lineEnding}`;
    const replacementHeader = replacement.split(/\r?\n/, 1)[0].trim().replace(/^\.method\s+/, '');
    if (replacementHeader !== operation.method.methodDescriptor || !replacement.trimEnd().endsWith('.end method')) {
      throw new PatchError('replacement method header or end marker does not match its descriptor', operation.id);
    }
    for (const assertion of operation.finalAssertions ?? []) {
      const hits = countExact(replacement, normalizeLineEndings(assertion.text, lineEnding));
      if (assertion.present === false ? hits !== 0 : hits !== (assertion.hits ?? 1)) throw new PatchError(`final assertion failed for ${JSON.stringify(assertion.text)}`, operation.id);
    }
    return { content: content.slice(0, methodStart) + replacement + content.slice(methodEnd), count: 1 };
  }
  const lineEnding = beforeScope.includes('\r\n') ? '\r\n' : '\n';
  const expectedOriginal = normalizeLineEndings(operation.expectedOriginal, lineEnding);
  const replacementText = normalizeLineEndings(operation.replacement, lineEnding);
  const count = countExact(beforeScope, expectedOriginal);
  if (count !== operation.expectedHits) {
    const alreadyApplied = countExact(beforeScope, replacementText) === operation.expectedHits;
    throw new PatchError(alreadyApplied ? 'patch has already been applied' : `expected ${operation.expectedHits} original fragment(s), found ${count}`, operation.id);
  }
  const afterScope = beforeScope.replaceAll(expectedOriginal, replacementText);
  for (const assertion of operation.finalAssertions ?? []) {
    const value = normalizeLineEndings(assertion.text, lineEnding);
    const hits = countExact(afterScope, value);
    if (assertion.present === false ? hits !== 0 : hits !== (assertion.hits ?? 1)) {
      throw new PatchError(`final assertion failed for ${JSON.stringify(value)}`, operation.id);
    }
  }
  return { content: content.slice(0, methodStart) + afterScope + content.slice(methodEnd), count };
}

function expandDynamic(value, variables) {
  if (typeof value === 'string') return value.replace(/\{\{(applicationId|versionCode|releaseName)\}\}/g, (_, key) => String(variables[key]));
  if (Array.isArray(value)) return value.map((item) => expandDynamic(item, variables));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, expandDynamic(child, variables)]));
  return value;
}

export async function applyPatchSpec({ root, specPath = defaultSpecPath, baselineApkPath = null, applicationId = 'io.github.wakeupnoads', versionCode = null, releaseName = null }) {
  const rootReal = await realpath(root);
  const spec = JSON.parse(await readFile(specPath, 'utf8'));
  if (spec.schemaVersion !== 1 || !Array.isArray(spec.operations)) throw new PatchError('unsupported or malformed patch spec');
  if (spec.applicationId !== applicationId) throw new PatchError(`application id mismatch: expected ${spec.applicationId}`);
  if (spec.packageIdentitySpecPath) {
    assertRelativePath(spec.packageIdentitySpecPath, 'package-identity-spec');
    const specDirectory = await realpath(path.dirname(specPath));
    const identityPath = path.resolve(specDirectory, spec.packageIdentitySpecPath);
    const identityRelative = path.relative(specDirectory, identityPath);
    if (identityRelative === '..' || identityRelative.startsWith(`..${path.sep}`) || path.isAbsolute(identityRelative)) throw new PatchError('package identity spec escapes its directory');
    if ((await lstat(identityPath)).isSymbolicLink()) throw new PatchError('package identity spec cannot be a symbolic link');
    const identitySpec = JSON.parse(await readFile(identityPath, 'utf8'));
    if (identitySpec.applicationId !== applicationId || !Array.isArray(identitySpec.operations)) throw new PatchError('package identity spec does not match the fixed application id');
    spec.operations.push(...identitySpec.operations);
  }
  const variables = { applicationId, versionCode, releaseName };
  spec.operations = expandDynamic(spec.operations, variables);
  if (spec.operations.some((operation) => JSON.stringify(operation).includes('{{'))) throw new PatchError('patch variables are incomplete');
  if (baselineApkPath && spec.baselineSha256) {
    const baselineHash = sha256(await readFile(baselineApkPath));
    if (baselineHash !== spec.baselineSha256.toUpperCase()) throw new PatchError('baseline APK SHA-256 does not match patch spec');
  }

  const plans = new Map();
  const results = [];
  for (const operation of spec.operations) {
    validateOperationShape(operation);
    const target = await resolveSafeTarget(rootReal, operation.relativePath, operation.id);
    let plan = plans.get(target);
    if (!plan) {
      const original = await readFile(target, 'utf8');
      plan = { target, relativePath: operation.relativePath, original, current: original, operations: [] };
      plans.set(target, plan);
    }
    if (operation.expectedFileSha256 && sha256(Buffer.from(plan.current, 'utf8')) !== operation.expectedFileSha256.toUpperCase()) {
      throw new PatchError('source file SHA-256 changed from reviewed input', operation.id);
    }
    const applied = applyOperation(plan.current, operation);
    plan.current = applied.content;
    plan.operations.push({ id: operation.id, count: applied.count });
    results.push({ id: operation.id, evidence: operation.evidence, relativePath: operation.relativePath, count: applied.count });
  }

  const staged = [];
  try {
    for (const plan of plans.values()) {
      const tempPath = `${plan.target}.slim-${randomUUID()}.tmp`;
      await writeFile(tempPath, plan.current, { flag: 'wx' });
      staged.push({ ...plan, tempPath });
    }
    const committed = [];
    try {
      for (const item of staged) {
        const backupPath = `${item.target}.slim-${randomUUID()}.bak`;
        await rename(item.target, backupPath);
        try {
          await rename(item.tempPath, item.target);
          committed.push({ target: item.target, backupPath });
        } catch (error) {
          await rename(backupPath, item.target);
          throw error;
        }
      }
      for (const item of committed) await rm(item.backupPath, { force: true });
    } catch (error) {
      for (const item of committed.reverse()) {
        await rm(item.target, { force: true });
        await rename(item.backupPath, item.target);
      }
      throw error;
    }
  } finally {
    for (const item of staged) await rm(item.tempPath, { force: true });
  }

  return {
    schemaVersion: 1,
    applicationId,
    patchedRoot: rootReal,
    operations: results,
    files: [...plans.values()].map((plan) => ({
      relativePath: plan.relativePath,
      originalSha256: asDigest(plan.original),
      patchedSha256: asDigest(plan.current),
      operationCount: plan.operations.length,
    })),
  };
}

async function main(argv) {
  const [root, baselineApkPath, applicationId = 'io.github.wakeupnoads', versionCodeText, releaseName] = argv;
  if (!root || argv.length > 5) throw new Error('usage: node scripts/patch.mjs <decoded-root> [baseline-apk] [application-id] [version-code] [release-name]');
  const versionCode = versionCodeText === undefined ? null : Number(versionCodeText);
  if (versionCodeText !== undefined && (!Number.isSafeInteger(versionCode) || versionCode < 1)) throw new Error('version-code must be a positive integer');
  const result = await applyPatchSpec({ root, baselineApkPath, applicationId, versionCode, releaseName });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.name}: ${error.message}\n`);
    process.exitCode = 1;
  });
}
