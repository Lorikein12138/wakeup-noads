import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultLock = path.resolve(here, '../patches/slim-v1/toolchain-lock.json');
const digest = (data, algorithm = 'sha256') => createHash(algorithm).update(data).digest('hex').toUpperCase();

function projectPath(projectRoot, relative, label) {
  if (typeof relative !== 'string' || path.isAbsolute(relative) || path.win32.isAbsolute(relative) || relative.includes('\0')) {
    throw new Error(`${label} must be a project-relative path`);
  }
  const resolved = path.resolve(projectRoot, relative);
  const rel = path.relative(projectRoot, resolved);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error(`${label} escapes project root`);
  return resolved;
}

export function assertCachePath(projectRoot, candidate) {
  const root = path.resolve(projectRoot);
  const cache = path.resolve(root, 'tools', '_cache');
  const resolved = path.resolve(candidate);
  const relative = path.relative(cache, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`cache path is outside tools/_cache: ${candidate}`);
  }
  return resolved;
}

export function assertLockIsPortable(lock) {
  const serialized = JSON.stringify(lock);
  if (/(?:[A-Za-z]:\\|\\\\[^\\]+\\|\/Users\/|\/home\/)/.test(serialized)) throw new Error('toolchain lock contains a machine-specific absolute path');
  if (/(?:password|passwd|secret|privateKey|storepass)\s*[:=]/i.test(serialized)) throw new Error('toolchain lock contains a secret-like field');
  return true;
}

async function assertHash(file, expected, algorithm, label) {
  const actual = digest(await readFile(file), algorithm);
  if (actual !== expected.toUpperCase()) throw new Error(`${label} hash mismatch: expected ${expected.toUpperCase()}, got ${actual}`);
  return actual;
}

export async function verifyToolchain({ projectRoot, inputApkPath = null, lockPath = defaultLock, verifyAndroidTools = true } = {}) {
  if (!projectRoot) throw new Error('projectRoot is required');
  const root = await realpath(projectRoot);
  const lock = JSON.parse(await readFile(lockPath, 'utf8'));
  if (lock.schemaVersion !== 1) throw new Error('unsupported toolchain lock schema');
  assertLockIsPortable(lock);
  const input = inputApkPath ? path.resolve(inputApkPath) : projectPath(root, lock.baseline.path, 'baseline path');
  await assertHash(input, lock.baseline.sha256, 'sha256', 'baseline APK');
  await assertHash(projectPath(root, lock.apktool.path, 'Apktool path'), lock.apktool.sha256, 'sha256', 'Apktool JAR');
  await assertHash(projectPath(root, lock.apktool.framework.path, 'framework path'), lock.apktool.framework.sha256, 'sha256', 'Apktool framework');
  const buildArchive = projectPath(root, lock.androidBuildTools.archivePath, 'Android Build Tools archive path');
  if (verifyAndroidTools) {
    await assertHash(buildArchive, lock.androidBuildTools.officialSha1, 'sha1', 'Android Build Tools official SHA-1');
    await assertHash(buildArchive, lock.androidBuildTools.archiveSha256, 'sha256', 'Android Build Tools archive SHA-256');
    for (const tool of ['zipalign.exe', 'apksigner.bat', 'd8.bat', 'aapt.exe']) {
      const toolPath = path.join(projectPath(root, lock.androidBuildTools.installPath, 'Android Build Tools install path'), tool);
      const info = await lstat(toolPath);
      if (!info.isFile()) throw new Error(`Android Build Tools command is not a file: ${tool}`);
    }
  }
  return { projectRoot: root, baselineSha256: lock.baseline.sha256, apktoolSha256: lock.apktool.sha256, androidBuildToolsVersion: lock.androidBuildTools.version };
}

async function main(argv) {
  if (argv.length < 1 || argv.length > 2) throw new Error('usage: node scripts/toolchain.mjs <project-root> [input-apk]');
  const result = await verifyToolchain({ projectRoot: argv[0], inputApkPath: argv[1] ?? null });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
