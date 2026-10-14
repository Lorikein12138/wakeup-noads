import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createReleaseMetadata, releaseNameFor, assertReleaseMetadataMatches, candidatePaths } from '../scripts/version.mjs';

const digest = '62AFFB92977D5A5B4E78D90D1F7FF36234795A59114327E4E6F169911E671CEA';

test('release naming uses the official baseline and revision', () => {
  assert.equal(releaseNameFor('6.5.2', 1), 'wakeup-noads-v6.5.2-r1');
  assert.equal(releaseNameFor('6.5.2', 2), 'wakeup-noads-v6.5.2-r2');
  assert.throws(() => releaseNameFor('6.5.3', 1), /confirmation/);
  assert.equal(releaseNameFor('6.5.3', 1, { baselineConfirmed: true }), 'wakeup-noads-v6.5.3-r1');
});

test('revision must be a positive integer', () => {
  for (const revision of [0, -1, 1.2, NaN, Infinity, '1']) {
    assert.throws(() => releaseNameFor('6.5.2', revision), /revision/);
  }
});

test('APK filename, versionName, and tagName share one generated name', () => {
  const metadata = createReleaseMetadata({ baselineSha256: digest, baselineVersion: '6.5.2', revision: 1, versionCode: 542 });
  assert.equal(metadata.filename, 'wakeup-noads-v6.5.2-r1.apk');
  assert.equal(metadata.versionName, 'wakeup-noads-v6.5.2-r1');
  assert.equal(metadata.tagName, 'wakeup-noads-v6.5.2-r1');
  assert.equal(assertReleaseMetadataMatches({ packageName: 'io.github.wakeupnoads', versionCode: 542, versionName: metadata.versionName }, {
    ...metadata, packageName: 'io.github.wakeupnoads', releaseName: 'wakeup-noads-v6.5.2-r1',
  }), true);
  assert.throws(() => assertReleaseMetadataMatches({ packageName: 'wrong', versionCode: 542, versionName: metadata.versionName }, {
    ...metadata, packageName: 'io.github.wakeupnoads', releaseName: metadata.releaseName,
  }), /packageName/);
});

test('each versionCode keeps its own candidate and output folder', () => {
  const first = candidatePaths('tools/_cache/slim-v1-build', 542, 'wakeup-noads-v6.5.2-r1');
  const next = candidatePaths('tools/_cache/slim-v1-build', 543, 'wakeup-noads-v6.5.2-r1');
  assert.notEqual(first.candidateRoot, next.candidateRoot);
  assert.notEqual(first.apkPath, next.apkPath);
  assert.match(first.apkPath, /versionCode-542/);
  assert.match(next.apkPath, /versionCode-543/);
});

test('6.5.4 is a confirmed baseline for release names and metadata', () => {
  const digest654 = '05050A52114FAC52019773F8E7F20C23CBAA23211575E4C378CF274663601623';
  assert.equal(releaseNameFor('6.5.4', 1), 'wakeup-noads-v6.5.4-r1');
  assert.equal(releaseNameFor('6.5.4', 2), 'wakeup-noads-v6.5.4-r2');
  const metadata = createReleaseMetadata({ baselineSha256: digest654, baselineVersion: '6.5.4', revision: 2, versionCode: 543 });
  assert.equal(metadata.releaseName, 'wakeup-noads-v6.5.4-r2');
  assert.equal(metadata.baselineSha256, digest654);
  assert.equal(assertReleaseMetadataMatches({ packageName: 'io.github.wakeupnoads', versionCode: 543, versionName: metadata.versionName }, {
    ...metadata, packageName: 'io.github.wakeupnoads', releaseName: metadata.releaseName,
  }), true);
  assert.throws(() => assertReleaseMetadataMatches({ packageName: 'io.github.wakeupnoads', versionCode: 543, versionName: 'wakeup-noads-v6.5.4-r1' }, {
    ...metadata, packageName: 'io.github.wakeupnoads', releaseName: metadata.releaseName,
  }), /versionName/);
  const cli = spawnSync(process.execPath, ['scripts/version.mjs', '6.5.4', '2'], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.deepEqual(JSON.parse(cli.stdout), { releaseName: 'wakeup-noads-v6.5.4-r2' });
});

test('only the two reviewed official baselines are confirmed without an explicit override', () => {
  for (const version of ['6.5.3', '6.5.5', '6.6.0', 'wakeup-noads-v6.5.4']) {
    assert.throws(() => releaseNameFor(version, 1), /official dotted numeric version|confirmation/);
  }
  assert.equal(releaseNameFor('6.5.5', 1, { baselineConfirmed: true }), 'wakeup-noads-v6.5.5-r1');
});
