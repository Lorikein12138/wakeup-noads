import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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

test('the locked v6.5.4 APK, patch spec, and default decoded cache share exact identity', async (t) => {
  const lock = JSON.parse(await readFile(lockPath, 'utf8'));
  const spec = JSON.parse(await readFile('patches/slim-v1/patch-spec.json', 'utf8'));
  const dependency = JSON.parse(await readFile('patches/slim-v1/teaching-dependencies.json', 'utf8'));
  const apkPath = path.resolve(lock.baseline.path);
  const apk = await readFile(apkPath);
  assert.equal(lock.baseline.path, 'baseline/wakeup-v6.5.4.apk');
  assert.equal(lock.baseline.versionName, '6.5.4');
  assert.equal(lock.baseline.versionCode, 543);
  assert.equal(apk.length, 35539955);
  assert.equal(sha256(apk), '05050A52114FAC52019773F8E7F20C23CBAA23211575E4C378CF274663601623');
  assert.equal(spec.baselineSha256, lock.baseline.sha256);
  assert.deepEqual(dependency.baseline, lock.baseline);
  assert.equal(dependency.baselineMethodInventory.baselineSha256, lock.baseline.sha256);
  const yml = await readFile('tools/_cache/slim-v1-decoded/apktool.yml', 'utf8');
  assert.match(yml, /^  versionCode: 543$/m);
  assert.match(yml, /^  versionName: 6\.5\.4$/m);
  const accepted = await verifyToolchain({ projectRoot, lockPath, verifyAndroidTools: false });
  assert.equal(accepted.baselineSha256, lock.baseline.sha256);
  await assert.rejects(verifyToolchain({ projectRoot, inputApkPath: path.resolve('baseline/wakeup-v6.5.2.apk'), lockPath, verifyAndroidTools: false }), /baseline APK hash mismatch/);

  const root = await mkdtemp(path.join(cacheRoot, 'baseline-rejects-before-patch-'));
  const fixtureParent = path.resolve(cacheRoot);
  assert.ok(root.startsWith(`${fixtureParent}${path.sep}`));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sentinel = path.join(root, 'sentinel.bin');
  await writeFile(sentinel, Buffer.from('must remain unchanged'));
  await assert.rejects(applyPatchSpec({
    root,
    specPath: path.resolve('patches/slim-v1/patch-spec.json'),
    baselineApkPath: path.resolve('baseline/wakeup-v6.5.2.apk'),
  }), /baseline APK SHA-256 does not match patch spec/);
  assert.deepEqual(await readFile(sentinel), Buffer.from('must remain unchanged'));
  assert.deepEqual((await (await import('node:fs/promises')).readdir(root)).sort(), ['sentinel.bin']);
});

test('production T22 patches the locked 6.5.4 metadata exactly and rejects stale or ambiguous inputs', async (t) => {
  const lock = JSON.parse(await readFile(lockPath, 'utf8'));
  const productionSpec = JSON.parse(await readFile('patches/slim-v1/patch-spec.json', 'utf8'));
  const operation = productionSpec.operations.find((item) => item.id === 'T22-E01-version-metadata');
  assert.ok(operation);
  assert.equal(operation.relativePath, 'apktool.yml');
  assert.equal(operation.fileScope, true);
  assert.equal(operation.expectedHits, 1);
  assert.equal(operation.expectedOriginal, '  versionCode: 543\n  versionName: 6.5.4');
  assert.equal(operation.replacement, '  versionCode: {{versionCode}}\n  versionName: {{releaseName}}');
  assert.equal(operation.finalAssertions[0].text, operation.replacement);

  const cacheYmlPath = path.resolve('tools/_cache/slim-v1-decoded/apktool.yml');
  const cacheYmlBytes = await readFile(cacheYmlPath);
  const cacheYml = cacheYmlBytes.toString('utf8');
  const anchor = '  versionCode: 543\n  versionName: 6.5.4';
  const normalize = (value) => value.replace(/\r\n/g, '\n');
  const withEnding = (value, ending) => normalize(value).replace(/\n/g, ending);
  const sourceLf = normalize(cacheYml);
  assert.equal(sourceLf.split(anchor).length - 1, 1);
  assert.match(sourceLf, /^  versionCode: 543$/m);
  assert.match(sourceLf, /^  versionName: 6\.5\.4$/m);
  assert.equal(lock.baseline.versionCode, 543);
  assert.equal(lock.baseline.versionName, '6.5.4');
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
    { label: 'lf-default', ending: '\n', versionCode: 543, releaseName: 'wakeup-noads-v6.5.4-r1' },
    { label: 'crlf-default', ending: '\r\n', versionCode: 543, releaseName: 'wakeup-noads-v6.5.4-r1' },
    { label: 'lf-explicit', ending: '\n', versionCode: 654, releaseName: 'wakeup-noads-v6.5.4-r2' },
    { label: 'crlf-explicit', ending: '\r\n', versionCode: 654, releaseName: 'wakeup-noads-v6.5.4-r2' },
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
    expectedOriginal: '  versionCode: 542\n  versionName: 6.5.2',
  };
  const invalidCases = [
    { label: 'stale-spec-anchor', source: withEnding(sourceLf, '\n'), op: staleAnchor },
    { label: 'wrong-source-code', source: withEnding(sourceLf.replace(anchor, '  versionCode: 542\n  versionName: 6.5.4'), '\n'), op: operation },
    { label: 'wrong-source-name', source: withEnding(sourceLf.replace(anchor, '  versionCode: 543\n  versionName: 6.5.2'), '\n'), op: operation },
    { label: 'duplicate-source-fragment', source: withEnding(sourceLf + anchor + '\n', '\n'), op: operation, expected: 2 },
  ];
  for (const { label, source, op, expected = 0 } of invalidCases) {
    const fixture = await makeFixture(label, source, op);
    const targetBefore = await readFile(fixture.targetPath);
    const sentinelBefore = await readFile(fixture.sentinelPath);
    await assert.rejects(applyPatchSpec({
      root: fixture.root, specPath: fixture.specPath, versionCode: 543, releaseName: 'wakeup-noads-v6.5.4-r1',
    }), new RegExp('expected 1 original fragment\\(s\\), found ' + expected));
    assert.deepEqual(await readFile(fixture.targetPath), targetBefore, label + ': target is unchanged');
    assert.deepEqual(await readFile(fixture.sentinelPath), sentinelBefore, label + ': sentinel is unchanged');
  }

  assert.deepEqual(await readFile(cacheYmlPath), cacheYmlBytes, 'production default decoded cache is never written');
});

test('the 6.5.4 teaching ledger is recomputed from every locked decoded smali class', async () => {
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
  const methods = inventory.flatMap((entry) => entry.methods);
  assert.equal(inventory.length, 127);
  assert.equal(methods.length, 1406);
  assert.equal(methods.reduce((sum, method) => sum + method.invokeEdges.length, 0), 9408);
  assert.equal(methods.reduce((sum, method) => sum + method.dynamicInvokeInstructions.length, 0), 0);
  assert.equal(dependency.baselineMethodInventory.fileCount, inventory.length);
  assert.equal(dependency.baselineMethodInventory.methodCount, methods.length);
  assert.equal(dependency.baselineMethodInventory.invokeEdgeCount, 9408);
  assert.equal(dependency.baselineMethodInventory.dynamicInvokeSiteCount, 0);
  assert.equal(sha256(Buffer.from(JSON.stringify(inventory))), dependency.methodInventorySha256);
  assert.equal(dependency.baseline.sha256, lock.baseline.sha256);
  const native = dependency.cryptoLifecycle.nativeBaseutil;
  const nativeBytes = await readFile(path.join(decodedRoot, native.libraryPath));
  assert.equal(sha256(nativeBytes), native.sha256);
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
