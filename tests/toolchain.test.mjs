import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertCachePath, assertLockIsPortable, verifyToolchain } from '../scripts/toolchain.mjs';

const projectRoot = path.resolve('.');
const lockPath = path.resolve('patches/slim-v1/toolchain-lock.json');
const cacheRoot = path.resolve('tools/_cache/slim-v1-review/fixtures');
const buildScript = await readFile('scripts/build.ps1', 'utf8');
const testScript = await readFile('scripts/test.ps1', 'utf8');
const preservationTest = await readFile('tests/teaching-preservation.test.mjs', 'utf8');

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
