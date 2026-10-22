import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_REVISION = 2_100_000_000;
const BASELINE_VERSION_PATTERN = /^\d+(?:\.\d+){1,3}$/;
const CONFIRMED_BASELINE_VERSIONS = new Set(['6.5.2', '6.5.4', '6.6.0']);
export const DEFAULT_APPLICATION_ID = 'io.github.wakeupnoads';

export function isDefaultConfirmedBaseline(version) {
  return CONFIRMED_BASELINE_VERSIONS.has(version);
}

export function resolveApplicationId(value = DEFAULT_APPLICATION_ID) {
  if (value !== DEFAULT_APPLICATION_ID) throw new Error(`ApplicationId is fixed to ${DEFAULT_APPLICATION_ID}`);
  return value;
}

export function releaseNameFor(baselineVersion, revision, { baselineConfirmed = false } = {}) {
  if (typeof baselineVersion !== 'string' || !BASELINE_VERSION_PATTERN.test(baselineVersion)) {
    throw new TypeError('baselineVersion must be an official dotted numeric version');
  }
  if (!Number.isSafeInteger(revision) || revision < 1 || revision > MAX_REVISION) {
    throw new RangeError('revision must be a positive integer');
  }
  if (!isDefaultConfirmedBaseline(baselineVersion) && !baselineConfirmed) {
    throw new Error('a changed official baseline requires explicit confirmation');
  }
  return `wakeup-noads-v${baselineVersion}-r${revision}`;
}

export function createReleaseMetadata({ baselineSha256, baselineVersion, revision, versionCode, certificateSha256 = null, baselineConfirmed = false }) {
  if (!/^[A-Fa-f0-9]{64}$/.test(baselineSha256 ?? '')) throw new Error('baselineSha256 must be a SHA-256 hex digest');
  if (!Number.isSafeInteger(versionCode) || versionCode < 1 || versionCode > MAX_REVISION) throw new RangeError('versionCode is outside Android supported range');
  if (certificateSha256 !== null && !/^[A-Fa-f0-9]{64}$/.test(certificateSha256)) throw new Error('certificateSha256 must be a SHA-256 hex digest');
  const revisionName = releaseNameFor(baselineVersion, revision, { baselineConfirmed });
  return {
    baselineSha256: baselineSha256.toUpperCase(),
    baselineVersion,
    revision,
    releaseName: revisionName,
    filename: `${revisionName}.apk`,
    versionName: revisionName,
    versionCode,
    tagName: revisionName,
    certificateSha256: certificateSha256?.toUpperCase() ?? null,
  };
}

export function assertReleaseMetadataMatches(actual, expected) {
  const fields = ['versionName', 'versionCode', 'packageName'];
  for (const field of fields) {
    if (actual?.[field] !== expected?.[field]) throw new Error(`APK metadata mismatch for ${field}`);
  }
  if (expected.tagName !== expected.releaseName || expected.versionName !== expected.releaseName || expected.filename !== `${expected.releaseName}.apk`) {
    throw new Error('release filename, versionName, and tagName must share releaseName');
  }
  return true;
}

export async function readApktoolVersionInfo(apktoolYmlPath) {
  const yaml = await readFile(apktoolYmlPath, 'utf8');
  const code = yaml.match(/^  versionCode: (\d+)\s*$/m)?.[1];
  const name = yaml.match(/^  versionName: ([^\r\n]+)\s*$/m)?.[1];
  if (!code || !name) throw new Error('apktool.yml has no versionInfo.versionCode/versionName');
  return { versionCode: Number(code), versionName: name };
}

export function candidatePaths(cacheRoot, versionCode, releaseName) {
  if (!Number.isSafeInteger(versionCode) || versionCode < 1) throw new RangeError('invalid versionCode');
  if (!/^wakeup-noads-v\d+(?:\.\d+){1,3}-r\d+$/.test(releaseName)) throw new Error('invalid releaseName');
  const candidateRoot = path.join(cacheRoot, 'candidates', `versionCode-${versionCode}`);
  return {
    candidateRoot,
    apkPath: path.join(cacheRoot, 'output', `versionCode-${versionCode}`, `${releaseName}.apk`),
  };
}

async function main(argv) {
  const [baselineVersion, revisionText] = argv;
  if (!baselineVersion || !revisionText || argv.length > 2 || !/^\d+$/.test(revisionText)) {
    throw new Error('usage: node scripts/version.mjs <baselineVersion> <positiveRevision>');
  }
  process.stdout.write(`${JSON.stringify({ releaseName: releaseNameFor(baselineVersion, Number(revisionText), { baselineConfirmed: isDefaultConfirmedBaseline(baselineVersion) }) })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
