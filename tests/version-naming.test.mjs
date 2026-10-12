import test from 'node:test';
import assert from 'node:assert/strict';
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
