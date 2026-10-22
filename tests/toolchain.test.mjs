import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertCachePath, assertLockIsPortable, verifyToolchain } from '../scripts/toolchain.mjs';
import { applyPatchSpec } from '../scripts/patch.mjs';
import { methodInventoryFromSmali } from './smali-helpers.mjs';

const projectRoot = path.resolve('.');
const lockPath = path.resolve('patches/slim-v1/toolchain-lock.json');
const cacheRoot = path.resolve('tools/_cache/slim-v1-review/fixtures');
const buildScript = await readFile('scripts/build.ps1', 'utf8');
const testScript = await readFile('scripts/test.ps1', 'utf8');
const preservationTest = await readFile('tests/teaching-preservation.test.mjs', 'utf8');
const signingScript = await readFile('scripts/signing.ps1', 'utf8');
const versionScript = await readFile('scripts/version.mjs', 'utf8');
const sha256 = (value) => createHash('sha256').update(value).digest('hex').toUpperCase();

async function listSmaliFiles(root, relative = '') {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const next = path.posix.join(relative.replaceAll('\\', '/'), entry.name);
    if (entry.isDirectory()) files.push(...await listSmaliFiles(root, next));
    else if (entry.isFile() && entry.name.endsWith('.smali')) files.push(next);
  }
  return files.sort();
}

async function fixtureProject(t) {
  await mkdir(cacheRoot, { recursive: true });
  const root = await mkdtemp(path.join(cacheRoot, 'toolchain path with spaces '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const baseline = path.join(root, 'baseline', 'base.apk');
  const apktool = path.join(root, 'tools', 'apktool');
  const framework = path.join(root, 'tools', '_cache', 'apktool', '1.apk');
  const archive = path.join(root, 'tools', '_downloads', 'build-tools.zip');
  const install = path.join(root, 'tools', 'build-tools', 'zipalign.exe');
  await mkdir(path.dirname(baseline), { recursive: true });
  await mkdir(path.dirname(framework), { recursive: true });
  await mkdir(path.dirname(archive), { recursive: true });
  await mkdir(path.dirname(install), { recursive: true });
  await writeFile(baseline, 'fixture baseline');
  await writeFile(apktool, 'fixture apktool');
  await writeFile(framework, 'fixture framework');
  await writeFile(archive, 'fixture archive');
  for (const name of ['zipalign.exe', 'apksigner.bat', 'd8.bat', 'aapt.exe']) await writeFile(path.join(path.dirname(install), name), name);
  const { createHash } = await import('node:crypto');
  const hash = (file, algo = 'sha256') => createHash(algo).update(file).digest('hex').toUpperCase();
  const lock = {
    schemaVersion: 1,
    baseline: { path: 'baseline/base.apk', sha256: hash(Buffer.from('fixture baseline')) },
    apktool: { path: 'tools/apktool', sha256: hash(Buffer.from('fixture apktool')), framework: { path: 'tools/_cache/apktool/1.apk', sha256: hash(Buffer.from('fixture framework')) } },
    androidBuildTools: {
      version: '35.0.0', officialSha1: hash(Buffer.from('fixture archive'), 'sha1'), archiveSha256: hash(Buffer.from('fixture archive')),
      archivePath: 'tools/_downloads/build-tools.zip', installPath: 'tools/build-tools',
    },
  };
  const localLockPath = path.join(root, 'lock.json');
  await writeFile(localLockPath, JSON.stringify(lock));
  return { root, lock, localLockPath, baseline };
}

test('rejects a changed baseline APK before decode', async (t) => {
  const f = await fixtureProject(t);
  await writeFile(f.baseline, 'wrong baseline');
  await assert.rejects(verifyToolchain({ projectRoot: f.root, lockPath: f.localLockPath }), /baseline APK hash mismatch/);
});

test('rejects changed tool and archive hashes', async (t) => {
  const f = await fixtureProject(t);
  await writeFile(path.join(f.root, 'tools/apktool'), 'changed apktool');
  await assert.rejects(verifyToolchain({ projectRoot: f.root, lockPath: f.localLockPath, verifyAndroidTools: false }), /Apktool JAR hash mismatch/);
  const g = await fixtureProject(t);
  await writeFile(path.join(g.root, 'tools/_downloads/build-tools.zip'), 'changed archive');
  await assert.rejects(verifyToolchain({ projectRoot: g.root, lockPath: g.localLockPath }), /Android Build Tools official SHA-1 hash mismatch/);
});

test('handles project directories containing spaces', async (t) => {
  const f = await fixtureProject(t);
  const result = await verifyToolchain({ projectRoot: f.root, lockPath: f.localLockPath });
  assert.equal(result.projectRoot, f.root);
});

test('rejects cache paths outside tools/_cache', () => {
  assert.throws(() => assertCachePath(projectRoot, path.resolve('tools/_downloads/cache')), /outside tools\/_cache/);
  assert.throws(() => assertCachePath(projectRoot, path.resolve('reports/tmp')), /outside tools\/_cache/);
  assert.equal(assertCachePath(projectRoot, path.resolve('tools/_cache/tmp')), path.resolve('tools/_cache/tmp'));
});

test('checked-in toolchain lock is portable and has no secret fields', async () => {
  const lock = JSON.parse(await readFile(lockPath, 'utf8'));
  assert.equal(assertLockIsPortable(lock), true);
  assert.equal(/PLACEHOLDER/.test(JSON.stringify(lock)), false);
});

test('the locked v6.6.0 APK, patch spec, and default decoded cache share exact identity', async (t) => {
  const lock = JSON.parse(await readFile(lockPath, 'utf8'));
  const spec = JSON.parse(await readFile('patches/slim-v1/patch-spec.json', 'utf8'));
  const dependency = JSON.parse(await readFile('patches/slim-v1/teaching-dependencies.json', 'utf8'));
  const apkPath = path.resolve(lock.baseline.path);
  const apk = await readFile(apkPath);
  assert.equal(lock.baseline.path, 'baseline/wakeup-v6.6.0.apk');
  assert.equal(lock.baseline.versionName, '6.6.0');
  assert.equal(lock.baseline.versionCode, 550);
  assert.equal(apk.length, 36641160);
  assert.equal(sha256(apk), '6556E8AC409381BFC686D3407FBE25A2C2603FDC46B4BABFF89620E333712922');
  assert.equal(spec.baselineSha256, lock.baseline.sha256);
  assert.deepEqual(dependency.baseline, lock.baseline);
  assert.equal(dependency.baselineMethodInventory.baselineSha256, lock.baseline.sha256);
  const yml = await readFile('tools/_cache/slim-v1-decoded/apktool.yml', 'utf8');
  assert.match(yml, /^  versionCode: 550$/m);
  assert.match(yml, /^  versionName: 6\.6\.0$/m);
  const decodedEntries = await readdir('tools/_cache/slim-v1-decoded', { withFileTypes: true });
  assert.equal(decodedEntries.filter((entry) => entry.isDirectory() && /^smali(?:_classes\d+)?$/.test(entry.name)).length, 7,
    'the locked APK decodes to exactly seven DEX roots');
  const accepted = await verifyToolchain({ projectRoot, lockPath, verifyAndroidTools: false });
  assert.equal(accepted.baselineSha256, lock.baseline.sha256);
  for (const oldApkPath of ['baseline/wakeup-v6.5.2.apk', 'baseline/wakeup-v6.5.4.apk']) {
    await assert.rejects(verifyToolchain({ projectRoot, inputApkPath: path.resolve(oldApkPath), lockPath, verifyAndroidTools: false }), /baseline APK hash mismatch/);
  }

  const root = await mkdtemp(path.join(cacheRoot, 'baseline-rejects-before-patch-'));
  const fixtureParent = path.resolve(cacheRoot);
  assert.ok(root.startsWith(`${fixtureParent}${path.sep}`));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sentinel = path.join(root, 'sentinel.bin');
  await writeFile(sentinel, Buffer.from('must remain unchanged'));
  for (const oldApkPath of ['baseline/wakeup-v6.5.2.apk', 'baseline/wakeup-v6.5.4.apk']) {
    await assert.rejects(applyPatchSpec({
      root,
      specPath: path.resolve('patches/slim-v1/patch-spec.json'),
      baselineApkPath: path.resolve(oldApkPath),
    }), /baseline APK SHA-256 does not match patch spec/);
    assert.deepEqual(await readFile(sentinel), Buffer.from('must remain unchanged'));
    assert.deepEqual((await (await import('node:fs/promises')).readdir(root)).sort(), ['sentinel.bin']);
  }
});

test('production T22 patches the locked 6.6.0 metadata exactly and rejects stale or ambiguous inputs', async (t) => {
  const lock = JSON.parse(await readFile(lockPath, 'utf8'));
  const productionSpec = JSON.parse(await readFile('patches/slim-v1/patch-spec.json', 'utf8'));
  const operation = productionSpec.operations.find((item) => item.id === 'T22-E01-version-metadata');
  assert.ok(operation);
  assert.equal(operation.relativePath, 'apktool.yml');
  assert.equal(operation.fileScope, true);
  assert.equal(operation.expectedHits, 1);
  assert.equal(operation.expectedOriginal, '  versionCode: 550\n  versionName: 6.6.0');
  assert.equal(operation.replacement, '  versionCode: {{versionCode}}\n  versionName: {{releaseName}}');
  assert.equal(operation.finalAssertions[0].text, operation.replacement);

  const cacheYmlPath = path.resolve('tools/_cache/slim-v1-decoded/apktool.yml');
  const cacheYmlBytes = await readFile(cacheYmlPath);
  const cacheYml = cacheYmlBytes.toString('utf8');
  const anchor = '  versionCode: 550\n  versionName: 6.6.0';
  const normalize = (value) => value.replace(/\r\n/g, '\n');
  const withEnding = (value, ending) => normalize(value).replace(/\n/g, ending);
  const sourceLf = normalize(cacheYml);
  assert.equal(sourceLf.split(anchor).length - 1, 1);
  assert.match(sourceLf, /^  versionCode: 550$/m);
  assert.match(sourceLf, /^  versionName: 6\.6\.0$/m);
  assert.equal(lock.baseline.versionCode, 550);
  assert.equal(lock.baseline.versionName, '6.6.0');
  assert.equal(productionSpec.baselineSha256, lock.baseline.sha256);

  const makeFixture = async (label, source, localOperation = operation) => {
    await mkdir(cacheRoot, { recursive: true });
    const root = await mkdtemp(path.join(cacheRoot, 't22-' + label + '-'));
    assert.ok(root.startsWith(path.resolve(cacheRoot) + path.sep), 'T22 fixture is contained in tools/_cache');
    t.after(() => rm(root, { recursive: true, force: true }));
    const targetPath = path.join(root, 'apktool.yml');
    const specPath = path.join(root, 'patch-spec.json');
    const sentinelPath = path.join(root, 'sentinel.txt');
    await writeFile(targetPath, source);
    await writeFile(sentinelPath, 'sentinel must stay unchanged');
    await writeFile(specPath, JSON.stringify({
      schemaVersion: 1,
      applicationId: productionSpec.applicationId,
      operations: [JSON.parse(JSON.stringify(localOperation))],
    }));
    return { root, targetPath, specPath, sentinelPath };
  };

  for (const { label, ending, versionCode, releaseName } of [
    { label: 'lf-default', ending: '\n', versionCode: 550, releaseName: 'wakeup-noads-v6.6.0-r1' },
    { label: 'crlf-default', ending: '\r\n', versionCode: 550, releaseName: 'wakeup-noads-v6.6.0-r1' },
    { label: 'lf-explicit', ending: '\n', versionCode: 654, releaseName: 'wakeup-noads-v6.6.0-r2' },
    { label: 'crlf-explicit', ending: '\r\n', versionCode: 654, releaseName: 'wakeup-noads-v6.6.0-r2' },
  ]) {
    const original = withEnding(sourceLf, ending);
    const fixture = await makeFixture(label, original);
    const result = await applyPatchSpec({
      root: fixture.root, specPath: fixture.specPath, versionCode, releaseName,
    });
    const expected = withEnding(
      sourceLf.replace(anchor, '  versionCode: ' + versionCode + '\n  versionName: ' + releaseName),
      ending
    );
    assert.equal(result.operations.length, 1);
    assert.equal(result.operations[0].id, 'T22-E01-version-metadata');
    assert.equal(result.operations[0].count, 1);
    assert.equal(result.files.length, 1);
    assert.equal(await readFile(fixture.targetPath, 'utf8'), expected, label + ': independent full-file output');
    assert.equal(await readFile(fixture.sentinelPath, 'utf8'), 'sentinel must stay unchanged');
    const once = await readFile(fixture.targetPath);
    await assert.rejects(applyPatchSpec({
      root: fixture.root, specPath: fixture.specPath, versionCode, releaseName,
    }), /patch has already been applied/);
    assert.deepEqual(await readFile(fixture.targetPath), once, label + ': repeated application does not rewrite target');
    assert.equal(await readFile(fixture.sentinelPath, 'utf8'), 'sentinel must stay unchanged');
  }

  const staleAnchor = {
    ...operation,
    expectedOriginal: '  versionCode: 543\n  versionName: 6.5.4',
  };
  const invalidCases = [
    { label: 'stale-spec-anchor', source: withEnding(sourceLf, '\n'), op: staleAnchor },
    { label: 'wrong-source-code', source: withEnding(sourceLf.replace(anchor, '  versionCode: 549\n  versionName: 6.6.0'), '\n'), op: operation },
    { label: 'wrong-source-name', source: withEnding(sourceLf.replace(anchor, '  versionCode: 550\n  versionName: 6.5.4'), '\n'), op: operation },
    { label: 'duplicate-source-fragment', source: withEnding(sourceLf + anchor + '\n', '\n'), op: operation, expected: 2 },
  ];
  for (const { label, source, op, expected = 0 } of invalidCases) {
    const fixture = await makeFixture(label, source, op);
    const targetBefore = await readFile(fixture.targetPath);
    const sentinelBefore = await readFile(fixture.sentinelPath);
    await assert.rejects(applyPatchSpec({
      root: fixture.root, specPath: fixture.specPath, versionCode: 550, releaseName: 'wakeup-noads-v6.6.0-r1',
    }), new RegExp('expected 1 original fragment\\(s\\), found ' + expected));
    assert.deepEqual(await readFile(fixture.targetPath), targetBefore, label + ': target is unchanged');
    assert.deepEqual(await readFile(fixture.sentinelPath), sentinelBefore, label + ': sentinel is unchanged');
  }

  const atomicRoot = await mkdtemp(path.join(cacheRoot, 't22-atomic-failure-'));
  assert.ok(atomicRoot.startsWith(path.resolve(cacheRoot) + path.sep), 'atomic failure fixture is contained in tools/_cache');
  t.after(() => rm(atomicRoot, { recursive: true, force: true }));
  const firstPath = path.join(atomicRoot, 'first.txt');
  const secondPath = path.join(atomicRoot, 'second.txt');
  const atomicSpecPath = path.join(atomicRoot, 'patch-spec.json');
  await writeFile(firstPath, 'first-original');
  await writeFile(secondPath, 'second-original');
  await writeFile(atomicSpecPath, JSON.stringify({
    schemaVersion: 1,
    applicationId: productionSpec.applicationId,
    operations: [
      { id: 'T22-atomic-first', evidence: 'E01', relativePath: 'first.txt', fileScope: true, expectedOriginal: 'first-original', replacement: 'first-patched', expectedHits: 1 },
      { id: 'T22-atomic-second', evidence: 'E01', relativePath: 'second.txt', fileScope: true, expectedOriginal: 'wrong-original', replacement: 'second-patched', expectedHits: 1 },
    ],
  }));
  await assert.rejects(applyPatchSpec({ root: atomicRoot, specPath: atomicSpecPath }), /T22-atomic-second: expected 1 original fragment\(s\), found 0/);
  assert.equal(await readFile(firstPath, 'utf8'), 'first-original', 'a previously planned file remains unchanged after a later planning failure');
  assert.equal(await readFile(secondPath, 'utf8'), 'second-original');

  assert.deepEqual(await readFile(cacheYmlPath), cacheYmlBytes, 'production default decoded cache is never written');
});

test('the 6.6.0 teaching ledger is recomputed and independently covers every route and school class', async () => {
  const lock = JSON.parse(await readFile(lockPath, 'utf8'));
  const dependency = JSON.parse(await readFile('patches/slim-v1/teaching-dependencies.json', 'utf8'));
  const decodedRoot = path.resolve('tools/_cache/slim-v1-decoded');
  const inventory = [];
  for (const entry of dependency.baselineMethodInventory.files) {
    const source = await readFile(path.join(decodedRoot, entry.path), 'utf8');
    const parsed = methodInventoryFromSmali(source, entry.path);
    inventory.push({
      path: entry.path,
      classDescriptor: parsed.classDescriptor,
      classFlags: parsed.classFlags,
      normalizedClassSha256: parsed.normalizedClassSha256,
      sourceSha256: parsed.sourceSha256,
      methods: parsed.methods,
    });
  }
  assert.deepEqual(inventory, dependency.baselineMethodInventory.files);
  assert.deepEqual(dependency.protectedFiles, inventory.map(({ path: relative }) => relative));
  const methods = inventory.flatMap((entry) => entry.methods);
  assert.equal(inventory.length, 128);
  assert.equal(methods.length, 1441);
  assert.equal(methods.reduce((sum, method) => sum + method.invokeEdges.length, 0), 10702);
  assert.equal(methods.reduce((sum, method) => sum + method.dynamicInvokeInstructions.length, 0), 0);
  assert.equal(dependency.baselineMethodInventory.fileCount, inventory.length);
  assert.equal(dependency.baselineMethodInventory.methodCount, methods.length);
  assert.equal(dependency.baselineMethodInventory.invokeEdgeCount, 10702);
  assert.equal(dependency.baselineMethodInventory.dynamicInvokeSiteCount, 0);
  assert.equal(sha256(Buffer.from(JSON.stringify(inventory))), dependency.methodInventorySha256);
  assert.equal(dependency.baseline.sha256, lock.baseline.sha256);

  const protectedPaths = new Set(dependency.protectedFiles);
  const schoolRoot = dependency.teachingDependencies.schoolClientRoot;
  const schoolFiles = await listSmaliFiles(decodedRoot, schoolRoot);
  assert.equal(schoolFiles.length, 82, 'school files are independently enumerated from the complete decoded tree');
  assert.equal(dependency.teachingDependencies.schoolClientFileCount, schoolFiles.length);
  const actualSchoolClasses = [];
  for (const relative of schoolFiles) {
    const source = await readFile(path.join(decodedRoot, relative), 'utf8');
    const parsed = methodInventoryFromSmali(source, relative);
    actualSchoolClasses.push(parsed.classDescriptor);
    assert.ok(protectedPaths.has(relative), `${relative} is protected independently of the manifest class list`);
  }
  assert.deepEqual([...actualSchoolClasses].sort(), [...dependency.teachingDependencies.schoolClientClasses].sort());

  const referencedSmaliPaths = new Set();
  const collectSmaliPaths = (value) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { for (const item of value) collectSmaliPaths(item); return; }
    if (typeof value.path === 'string' && /^smali_classes[2-7]\//.test(value.path) && value.path.endsWith('.smali')) referencedSmaliPaths.add(value.path);
    for (const item of Object.values(value)) collectSmaliPaths(item);
  };
  collectSmaliPaths(dependency.routeEntrypoints);
  collectSmaliPaths(dependency.cryptoLifecycle);
  for (const relative of referencedSmaliPaths) assert.ok(protectedPaths.has(relative), `${relative} ABI or route reference is protected`);

  const native = dependency.cryptoLifecycle.nativeBaseutil;
  const nativeBytes = await readFile(path.join(decodedRoot, native.libraryPath));
  assert.equal(sha256(nativeBytes), native.sha256);
});

test('production main and identity specs apply every 6.6.0 operation atomically to copied baseline targets', async (t) => {
  const lock = JSON.parse(await readFile(lockPath, 'utf8'));
  const patchSpec = JSON.parse(await readFile('patches/slim-v1/patch-spec.json', 'utf8'));
  const identitySpec = JSON.parse(await readFile('patches/slim-v1/package-identity-spec.json', 'utf8'));
  const allOperations = [...patchSpec.operations, ...identitySpec.operations];
  const targetPaths = [...new Set(allOperations.map(({ relativePath }) => relativePath))].sort();
  const baselineApkPath = path.resolve(lock.baseline.path);
  assert.equal(patchSpec.operations.length, 416);
  assert.equal(identitySpec.operations.length, 40);
  assert.ok(patchSpec.operations.some(({ id }) => id === 'T05-E02-prune-hotfix-task-dependencies'));
  assert.ok(targetPaths.includes('smali_classes6/o0OO0o00/OooOO0O.smali'));

  async function copyTargets(t, suffix) {
    await mkdir(cacheRoot, { recursive: true });
    const root = await mkdtemp(path.join(cacheRoot, `production-spec-${suffix}-`));
    assert.ok(root.startsWith(`${path.resolve(cacheRoot)}${path.sep}`), 'production fixture stays under tools/_cache');
    t.after(() => rm(root, { recursive: true, force: true }));
    for (const relative of targetPaths) {
      const target = path.join(root, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await cp(path.join('tools/_cache/slim-v1-decoded', relative), target);
    }
    const snapshot = new Map();
    for (const relative of targetPaths) snapshot.set(relative, await readFile(path.join(root, relative)));
    return { root, snapshot };
  }

  const fixture = await copyTargets(t, 'success');
  const result = await applyPatchSpec({
    root: fixture.root,
    specPath: path.resolve('patches/slim-v1/patch-spec.json'),
    baselineApkPath,
    versionCode: 550,
    releaseName: 'wakeup-noads-v6.6.0-r1',
  });
  assert.deepEqual(result.operations.map(({ id }) => id).sort(), allOperations.map(({ id }) => id).sort());
  for (const operation of allOperations) {
    const applied = result.operations.find(({ id }) => id === operation.id);
    assert.equal(applied.count, operation.expectedHits ?? 1, `${operation.id} hit count`);
  }
  assert.deepEqual(result.files.map(({ relativePath }) => relativePath).sort(),
    targetPaths, 'every changed production target is reported once');
  assert.equal(result.operations.length, 456);
  const nibbleOperands = /^(invoke-(virtual|super|direct|static|interface|polymorphic|custom)|filled-new-array|iget[a-z-]*|iput[a-z-]*|instance-of|new-array|move|move-object|move-wide|neg-[a-z]+|not-[a-z]+|(int|long|float|double)-to-[a-z]+|array-length|[a-z-]+\/2addr|if-(eq|ne|lt|ge|gt|le)|const\/4)$/;
  for (const relative of targetPaths) {
    let open = false;
    let locals = null;
    const lines = (await readFile(path.join(fixture.root, relative), 'utf8')).split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      if (/^\.method\s/.test(line)) {
        assert.ok(!open, `${relative} opens a method inside another method`);
        open = true;
        locals = null;
      } else if (/^\.end method\s*$/.test(line)) {
        assert.ok(open, `${relative} has an orphan .end method`);
        open = false;
      } else if (open) {
        const declared = line.match(/^\s*\.locals\s+(\d+)\s*$/);
        if (declared) locals = Number(declared[1]);
        const instruction = line.trim().match(/^([a-z0-9/-]+)\s+(.*)$/);
        if (!instruction || !nibbleOperands.test(instruction[1])) continue;
        const operands = instruction[2].startsWith('{') ? instruction[2].slice(1, instruction[2].indexOf('}')) : instruction[2];
        for (const operand of operands.split(',')) {
          const parsed = operand.trim().match(/^([vp])(\d+)$/);
          if (!parsed) continue;
          const [, kind, number] = parsed;
          if (kind === 'p' && locals === null) continue;
          const register = kind === 'v' ? Number(number) : locals + Number(number);
          assert.ok(register <= 15, `${relative}:${index + 1} uses ${kind}${number} in a 4-bit register operand`);
        }
      }
    }
    assert.ok(!open, `${relative} ends inside a method`);
  }

  const afterSuccess = new Map();
  for (const relative of targetPaths) afterSuccess.set(relative, await readFile(path.join(fixture.root, relative)));
  await assert.rejects(applyPatchSpec({
    root: fixture.root,
    specPath: path.resolve('patches/slim-v1/patch-spec.json'),
    baselineApkPath,
    versionCode: 550,
    releaseName: 'wakeup-noads-v6.6.0-r1',
  }), /patch has already been applied/);
  for (const relative of targetPaths) assert.deepEqual(await readFile(path.join(fixture.root, relative)), afterSuccess.get(relative), `${relative} stays unchanged on repeat`);

  const oldApkFixture = await copyTargets(t, 'old-apk-rejection');
  await assert.rejects(applyPatchSpec({
    root: oldApkFixture.root,
    specPath: path.resolve('patches/slim-v1/patch-spec.json'),
    baselineApkPath: path.resolve('baseline/wakeup-v6.5.4.apk'),
    versionCode: 550,
    releaseName: 'wakeup-noads-v6.6.0-r1',
  }), /baseline APK SHA-256 does not match patch spec/);
  for (const relative of targetPaths) assert.deepEqual(await readFile(path.join(oldApkFixture.root, relative)), oldApkFixture.snapshot.get(relative), `${relative} stays unchanged after wrong APK`);

  const wrongAnchorFixture = await copyTargets(t, 'wrong-anchor-rejection');
  const wrongAnchorSpec = {
    ...patchSpec,
    operations: patchSpec.operations.map((operation, index) => index === 0
      ? { ...operation, expectedOriginal: `${operation.expectedOriginal}__wrong_anchor__` }
      : operation),
  };
  const wrongAnchorPath = path.join(wrongAnchorFixture.root, 'wrong-anchor-spec.json');
  await writeFile(wrongAnchorPath, JSON.stringify(wrongAnchorSpec));
  await assert.rejects(applyPatchSpec({
    root: wrongAnchorFixture.root,
    specPath: wrongAnchorPath,
    baselineApkPath,
    versionCode: 550,
    releaseName: 'wakeup-noads-v6.6.0-r1',
  }));
  for (const relative of targetPaths) assert.deepEqual(await readFile(path.join(wrongAnchorFixture.root, relative)), wrongAnchorFixture.snapshot.get(relative), `${relative} stays unchanged after wrong anchor`);
});

test('all three build input readers bind the same actual version script and default code follows the lock', async () => {
  const lock = JSON.parse(await readFile(lockPath, 'utf8'));
  const versionHash = sha256(Buffer.from(versionScript));
  assert.match(buildScript, /versionScript = Get-Sha256 \(Join-Path \$PSScriptRoot 'version\.mjs'\)/);
  assert.match(signingScript, /versionScript = Get-FileSha256 \(Join-Path \$ProjectRoot 'scripts\/version\.mjs'\)/);
  assert.match(preservationTest, /versionScript: await fileSha256\('scripts\/version\.mjs'\)/);
  assert.equal(sha256(await readFile('scripts/version.mjs')), versionHash);
  assert.match(buildScript, /\[int\]\$VersionCode,?[\s\S]*?if \(-not \$PSBoundParameters\.ContainsKey\('VersionCode'\)\) \{ \$VersionCode = \[int\]\$Lock\.baseline\.versionCode \}/);
  assert.match(buildScript, /\[ValidateRange\(1, 2100000000\)\]\s+\[int\]\$VersionCode/);
});

test('PreSignCheck and ReleaseSigned share the aligned-APK roundtrip preservation gate', () => {
  assert.match(buildScript, /ValidateSet\('Unsigned', 'ReleaseSigned', 'PreSignCheck'\)/);
  assert.match(buildScript, /if \(\$Mode -eq 'PreSignCheck'\)[\s\S]*?Invoke-RoundtripPreservationAudit \$alignedApk \$work 'pre-sign'/);
  assert.match(buildScript, /\$preSignStage = Invoke-RoundtripPreservationAudit \$alignedApk/);
  assert.match(buildScript, /Invoke-RoundtripPreservationAudit \$signedApk .* 'signed'/);
  assert.doesNotMatch(buildScript, /verified-decoded/);
  assert.match(buildScript, /Invoke-CandidatePreservationAudit \$decodedRoot[\s\S]*?finally \{\s*Remove-CacheTree \$decodedRoot/);
  assert.match(buildScript, /if \(\$buildSucceeded -and \$Mode -ne 'PreSignCheck'\) \{\s*Remove-CacheTree \$work/);
  assert.match(buildScript, /signedPayloadHashes[\s\S]*?protectedPayloadHashes/);
  assert.match(buildScript, /patchResultPath = \[IO\.Path\]::GetFullPath/);
  assert.match(buildScript, /stage = \$Stage[\s\S]*?success = \$false[\s\S]*?normalizationVersion =/);
  assert.match(buildScript, /\$metadata\.success = \$true[\s\S]*Write-AtomicJson \$metadataPath \$metadata/);
});

test('build and test runners leave CPU headroom for the desktop', () => {
  for (const script of [buildScript, testScript]) {
    // The limits must be in place before any child process (Node, Java, aapt2) is started.
    const firstChild = script.search(/Resolve-Path \(Join-Path \$PSScriptRoot/);
    const limits = script.slice(0, firstChild);
    assert.match(limits, /\$Runner\.PriorityClass = \[Diagnostics\.ProcessPriorityClass\]::BelowNormal/);
    assert.match(limits, /\$CpuLimit = \[Math\]::Max\(1, \[Math\]::Min\(63, \[int\]\[Math\]::Floor\(\[Environment\]::ProcessorCount \/ 2\)\)\)/);
    assert.match(limits, /\$Runner\.ProcessorAffinity = \[IntPtr\]\(\(1L -shl \$CpuLimit\) - 1\)/);
  }
  assert.match(testScript, /\$WorkerLimit = \[Math\]::Max\(1, \[Math\]::Min\(4, \[int\]\[Math\]::Floor\(\$CpuLimit \/ 2\)\)\)/);
  assert.match(testScript, /& \$Node '--test' "--test-concurrency=\$WorkerLimit" @files/);
});

test('production preservation metadata is explicit, stage-bound, and restored after each suite', () => {
  assert.match(testScript, /CandidateMetadataPath/);
  assert.match(testScript, /SLIM_CANDIDATE_METADATA_PATH/);
  assert.match(testScript, /\$oldCandidateMetadataPath/);
  assert.match(testScript, /Remove-Item Env:SLIM_CANDIDATE_METADATA_PATH/);
  assert.match(preservationTest, /Production candidate metadata is missing or invalid/);
  assert.match(preservationTest, /candidate metadata is bound to the requested build stage/);
  assert.match(preservationTest, /candidateMetadata\.inputHashes, inputSnapshot\.inputHashes/);
  assert.match(preservationTest, /candidateMetadata\.candidatePurpose, candidatePurpose/);
});
