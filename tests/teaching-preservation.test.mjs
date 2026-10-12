import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { applyPatchSpec } from '../scripts/patch.mjs';
import { assertPrivateInvokeAbi, executableSmaliMethod, methodInventoryFromSmali, normalizeSmaliClass, normalizeSmaliMethod, parseSmaliClassStructure, readSmaliMethod, sameExecutableSmaliMethod, sameSmaliMethodInventory, smaliInvokeEdges } from './smali-helpers.mjs';

const repoRoot = process.cwd();
const baselineRoot = path.resolve(process.env.SLIM_BASELINE_DECODED_ROOT ?? 'tools/_cache/slim-v1-decoded');
const candidateRoot = process.env.SLIM_VERIFIED_DECODED_ROOT ? path.resolve(process.env.SLIM_VERIFIED_DECODED_ROOT) : null;
const dependencyPath = path.resolve('patches/slim-v1/teaching-dependencies.json');
const lockPath = path.resolve('patches/slim-v1/toolchain-lock.json');
const specPath = path.resolve('patches/slim-v1/patch-spec.json');
const mutationRoot = path.resolve('tools/_cache/slim-v1-review/fixtures/round-2/preservation-mutations');
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex').toUpperCase();
function normalizeMethodBody(source) {
  return executableSmaliMethod(source);
}

function normalize(source) {
  return /^\s*\.class\s/m.test(source) ? normalizeSmaliClass(source) : normalizeSmaliMethod(source);
}

async function listSmaliFiles(root, relative = '') {
  const directory = path.join(root, relative);
  const items = await readdir(directory, { withFileTypes: true });
  const results = [];
  for (const item of items) {
    const next = path.join(relative, item.name);
    if (item.isDirectory()) results.push(...await listSmaliFiles(root, next));
    else if (item.isFile() && item.name.endsWith('.smali')) results.push(next.replaceAll('\\', '/'));
  }
  return results.sort();
}

async function listFiles(root, relative = '') {
  const items = await readdir(path.join(root, relative), { withFileTypes: true });
  const results = [];
  for (const item of items) {
    const next = path.join(relative, item.name);
    if (item.isDirectory()) results.push(...await listFiles(root, next));
    else if (item.isFile()) results.push(next.replaceAll('\\', '/'));
  }
  return results.sort();
}

async function fileSha256(file) {
  return sha256(await readFile(file));
}

async function currentBuildInputHashes(metadata) {
  const lock = JSON.parse(await readFile(lockPath, 'utf8'));
  const toolPaths = metadata.toolPaths;
  assert.ok(toolPaths?.javaHome && toolPaths?.buildToolsRoot, 'candidate metadata declares the build tool locations');
  assert.equal(path.resolve(toolPaths.buildToolsRoot), path.resolve(lock.androidBuildTools.installPath), 'candidate Build Tools are the locked project toolchain');
  const runtimeRoot = path.resolve('runtime/src');
  const runtimePaths = await listFiles(runtimeRoot);
  const runtimeRows = [];
  for (const relative of runtimePaths.filter((value) => value.endsWith('.java'))) {
    const repoRelative = path.relative(repoRoot, path.join(runtimeRoot, relative)).replaceAll('\\', '/');
    runtimeRows.push(`${repoRelative}=${await fileSha256(path.join(runtimeRoot, relative))}`);
  }
  const runtimeSourceTree = sha256(Buffer.from(`${runtimeRows.join('\n')}\n`));
  const buildToolsRoot = path.resolve(toolPaths.buildToolsRoot);
  const javaHome = path.resolve(toolPaths.javaHome);
  const values = {
    baselineApk: await fileSha256(lock.baseline.path),
    patchSpec: await fileSha256('patches/slim-v1/patch-spec.json'),
    packageIdentitySpec: await fileSha256('patches/slim-v1/package-identity-spec.json'),
    dependencyManifest: await fileSha256('patches/slim-v1/teaching-dependencies.json'),
    toolchainLock: await fileSha256('patches/slim-v1/toolchain-lock.json'),
    patchEngine: await fileSha256('scripts/patch.mjs'),
    buildScript: await fileSha256('scripts/build.ps1'),
    testScript: await fileSha256('scripts/test.ps1'),
    signingScript: await fileSha256('scripts/signing.ps1'),
    signingInput: await fileSha256('scripts/signing-input.ps1'),
    preservationTest: await fileSha256('tests/teaching-preservation.test.mjs'),
    smaliHelper: await fileSha256('tests/smali-helpers.mjs'),
    runtimeSourceTree,
    apktoolJar: await fileSha256(lock.apktool.path),
    apktoolFramework: await fileSha256(lock.apktool.framework.path),
    zipalign: await fileSha256(path.join(buildToolsRoot, 'zipalign.exe')),
    aapt: await fileSha256(path.join(buildToolsRoot, 'aapt.exe')),
    d8: await fileSha256(path.join(buildToolsRoot, 'd8.bat')),
    apksigner: await fileSha256(path.join(buildToolsRoot, 'lib/apksigner.jar')),
    java: await fileSha256(path.join(javaHome, 'bin/java.exe')),
    javac: await fileSha256(path.join(javaHome, 'bin/javac.exe')),
  };
  const sorted = Object.fromEntries(Object.entries(values).sort(([left], [right]) => left.localeCompare(right)));
  return { inputHashes: sorted, buildInputSha256: sha256(Buffer.from(JSON.stringify(sorted))), runtimeSourceTree };
}

function parseSmaliInventory(source) {
  return methodInventoryFromSmali(source);
}

function methodMap(inventory) {
  return new Map(inventory.methods.map((method) => [method.methodDescriptor, method]));
}

function diffInvokeEdges(expectedEdges, actualEdges) {
  const key = ({ kind, target }) => `${kind}\0${target}`;
  const expected = new Map(expectedEdges.map((edge) => [key(edge), edge]));
  const actual = new Map(actualEdges.map((edge) => [key(edge), edge]));
  return {
    added: [...actual].filter(([edge]) => !expected.has(edge)).map(([, value]) => value),
    removed: [...expected].filter(([edge]) => !actual.has(edge)).map(([, value]) => value),
  };
}

test('shared Smali normalizer sorts method keys, preserves target topology, and rejects ambiguous structures', () => {
  const original = `.class public final Lfixture/Order;
.super Ljava/lang/Object;
.field private value:I
.annotation runtime Lfixture/Marker;
    text = "fixed value"
.end annotation
.method private first()V
    .locals 1
    .annotation runtime Lfixture/MethodMarker;
        text = "method value"
    .end annotation
    if-eqz v0, :old_true
    const-string v0, "a b"
    goto :old_end
    :old_true
    const-string v0, "target"
    :old_end
    return-void
.end method
.method public second()V
    .locals 0
    return-void
.end method`;
  const reordered = `.class public final Lfixture/Order;
.super Ljava/lang/Object;
.field private value:I
.annotation runtime Lfixture/Marker;
    text = "fixed value"
.end annotation
.method public second()V
    .locals 0
    return-void
.end method
.method private first()V
    .locals 1
    .line 88
    .annotation runtime Lfixture/MethodMarker;
        text = "method value"
    .end annotation
    if-eqz v0, :new_true # renamed without changing target
    const-string v0, "a b"
    goto :new_end
    :new_true
    const-string v0, "target"
    :new_end
    return-void
    :unused_label
.end method`;
  assert.equal(normalize(original), normalize(reordered), 'method declaration order, debug lines, comments, and label spelling are non-semantic');

  const mutations = [
    ['branch target', original.replace('if-eqz v0, :old_true', 'if-eqz v0, :old_end')],
    ['string whitespace', original.replace('"a b"', '"a  b"')],
    ['method flag', original.replace('.method private first()', '.method public first()')],
    ['class flag', original.replace('.class public final', '.class public')],
    ['class annotation value', original.replace('"fixed value"', '"fixed  value"')],
    ['method annotation value', original.replace('"method value"', '"method  value"')],
    ['method addition', `${original}\n.method public added()V\n    return-void\n.end method`],
    ['method deletion', original.replace(/\.method public second\(\)V[\s\S]*?\.end method\n?/, '')],
  ];
  for (const [name, changed] of mutations) assert.notEqual(normalize(original), normalize(changed), `${name} changes protected structure`);
  assert.throws(() => normalize(original.replace('\n    :old_true\n', '\n    :old_end\n')), /Duplicate Smali label/);
  assert.throws(() => normalize(original.replace(':old_true', ':missing').replace('if-eqz v0, :missing', 'if-eqz v0, :undefined')), /Unresolved Smali label/);
  assert.throws(() => normalize(`${original}\n.method private first()V\n    return-void\n.end method`), /Duplicate Smali method/);

  const switchMethod = `.class public Lfixture/Switch;
.super Ljava/lang/Object;
.method public route(I)V
    .locals 1
    packed-switch p1, :old_payload
    goto :old_done
    :old_case
    return-void
    :old_done
    return-void
    :old_payload
    .packed-switch 0x0
        :old_case
    .end packed-switch
.end method`;
  const renamedSwitch = switchMethod.replaceAll(':old_', ':new_');
  assert.equal(normalize(switchMethod), normalize(renamedSwitch), 'switch payload targets track renamed labels');
  const alignedSwitch = switchMethod.replace('    :old_payload', '    nop\n    :old_payload');
  assert.equal(normalize(switchMethod), normalize(alignedSwitch), 'assembly-only DEX payload alignment nop does not change the CFG');
  assert.notEqual(normalize(switchMethod), normalize(switchMethod.replace('        :old_case', '        :old_done')), 'switch payload target changes remain visible');
  const catchMethod = `.class public Lfixture/Catch;
.super Ljava/lang/Object;
.method public run()V
    .locals 1
    :try_start
    invoke-virtual {v0}, Lfixture/Work;->run()V
    :try_end
    return-void
    :handler
    move-exception v0
    return-void
    .catch Ljava/lang/Exception; {:try_start .. :try_end} :handler
.end method`;
  assert.notEqual(normalize(catchMethod), normalize(catchMethod.replace('} :handler', '} :try_end')), 'exception handler target changes remain visible');
  assert.equal(normalize(catchMethod), normalize(catchMethod.replaceAll(':try_', ':renamed_try_').replaceAll(':handler', ':renamed_handler')),
    'handler and range labels can be renamed only with their original targets preserved');
  assert.equal(executableSmaliMethod('const-string v0, "\\u0061"'), executableSmaliMethod('const-string v0, "a"'),
    'Smali escape spelling normalizes by decoded string value');
});

async function assertSchoolTreeUnchanged() {
  const dependency = JSON.parse(await readFile(dependencyPath, 'utf8'));
  const baseFiles = await listSmaliFiles(baselineRoot, dependency.teachingDependencies.schoolClientRoot);
  const candidateFiles = await listSmaliFiles(candidateRoot, dependency.teachingDependencies.schoolClientRoot);
  assert.deepEqual(candidateFiles, baseFiles, 'no school client, anonymous class, or coroutine file is added or removed');
  const entries = [];
  for (const relative of baseFiles) {
    const baselineText = await readFile(path.join(baselineRoot, relative), 'utf8');
    const candidateText = await readFile(path.join(candidateRoot, relative), 'utf8');
    assert.equal(normalize(candidateText), normalize(baselineText), `${relative} preserves executable content`);
    const inventory = parseSmaliInventory(baselineText);
    assert.ok(inventory.classDescriptor, `${relative} declares a class`);
    entries.push({ path: relative, classDescriptor: inventory.classDescriptor, methods: inventory.methods });
  }
  return entries;
}

test('dependency ledger points at real full descriptors and enumerates school call edges', async () => {
  const dependency = JSON.parse(await readFile(dependencyPath, 'utf8'));
  const lock = JSON.parse(await readFile(lockPath, 'utf8'));
  assert.equal(dependency.baseline.sha256, lock.baseline.sha256);
  const protectedPaths = new Set(dependency.baselineMethodInventory.files.map(({ path: relative }) => relative));
  for (const route of dependency.routeEntrypoints) {
    assert.ok(protectedPaths.has(route.source.path), `${route.id} root is included in the protected method inventory`);
    const method = await readSmaliMethod(baselineRoot, route.source.path, route.source.classDescriptor, route.source.methodDescriptor);
    for (const target of route.requiredTargets ?? []) {
      assert.ok(method.includes(target), `${route.id} baseline root has required call edge ${target}`);
    }
    if (route.target) assert.ok(method.includes(route.target), `${route.id} baseline root reaches or returns ${route.target}`);
    for (const child of route.coroutineChildren ?? []) {
      assert.ok(protectedPaths.has(child.path), `${route.id} coroutine child is included in the protected inventory`);
      const childMethod = await readSmaliMethod(baselineRoot, child.path, child.classDescriptor, child.methodDescriptor);
      for (const target of child.requiredTargets ?? []) {
        assert.ok(childMethod.includes(target), `${route.id} coroutine child has required call edge ${target}`);
      }
    }
    for (const childPath of route.protectedChildren ?? []) {
      assert.ok(protectedPaths.has(childPath), `${route.id} child ${childPath} is included in the protected inventory`);
    }
  }
  const crypto = dependency.cryptoLifecycle;
  for (const reference of [
    crypto.versionCodeSeed.reader,
    crypto.versionCodeSeed.rc4Adapter,
    crypto.nativeBaseutil.loader,
    crypto.nativeBaseutil.initializeMethod,
    crypto.nativeBaseutil.readyMethod,
    crypto.nativeBaseutil.nativeHelper,
    crypto.cacheInvalidation.adapter,
  ]) {
    assert.ok(protectedPaths.has(reference.path), `${reference.path} is in the protected inventory`);
  }
  for (const reference of [crypto.versionCodeSeed.reader, crypto.versionCodeSeed.rc4Adapter, crypto.nativeBaseutil.loader, crypto.nativeBaseutil.initializeMethod]) {
    const body = await readSmaliMethod(baselineRoot, reference.path, reference.classDescriptor, reference.methodDescriptor);
    for (const target of reference.requiredInvokeTargets ?? []) {
      assert.ok(body.includes(target), `${reference.methodDescriptor} baseline edge ${target}`);
    }
  }
  for (const signature of crypto.nativeBaseutil.nativeHelper.nativeMethods) {
    await readSmaliMethod(baselineRoot, crypto.nativeBaseutil.nativeHelper.path, crypto.nativeBaseutil.nativeHelper.classDescriptor, signature);
  }
  for (const descriptor of dependency.teachingDependencies.schoolClientClasses) {
    assert.ok(descriptor.startsWith('Lcom/suda/yzune/wakeupschedule/schedule_import/'), `${descriptor} is fully qualified`);
  }
  assert.equal(new Set(dependency.teachingDependencies.schoolClientClasses).size, dependency.teachingDependencies.schoolClientClasses.length,
    'school class descriptors are unique');
  const schoolFiles = await listSmaliFiles(baselineRoot, dependency.teachingDependencies.schoolClientRoot);
  assert.equal(schoolFiles.length, dependency.teachingDependencies.schoolClientFileCount,
    'the inventory covers every nested school client and coroutine file');
  const schoolClasses = [];
  for (const relative of schoolFiles) {
    const parsed = parseSmaliInventory(await readFile(path.join(baselineRoot, relative), 'utf8'));
    schoolClasses.push(parsed.classDescriptor);
  }
  assert.ok(schoolClasses.every(Boolean));
  assert.deepEqual([...schoolClasses].sort(), [...dependency.teachingDependencies.schoolClientClasses].sort(),
    'the ledger class list comes from actual .class declarations');

  const inventory = dependency.baselineMethodInventory;
  assert.equal(dependency.normalizationVersion, 2, 'method inventory declares the strict shared normalizer version');
  assert.equal(inventory.baselineSha256, lock.baseline.sha256);
  assert.equal(inventory.fileCount, inventory.files.length);
  assert.equal(inventory.methodCount, inventory.files.reduce((sum, file) => sum + file.methods.length, 0));
  assert.equal(dependency.methodInventorySha256, sha256(Buffer.from(JSON.stringify(inventory.files))));
  const inventoryPaths = new Set(inventory.files.map(({ path: relative }) => relative));
  assert.equal(inventoryPaths.size, inventory.files.length, 'inventory paths are unique');
  let methodCount = 0;
  let invokeEdgeCount = 0;
  let dynamicInvokeSiteCount = 0;
  for (const entry of inventory.files) {
    const parsed = parseSmaliInventory(await readFile(path.join(baselineRoot, entry.path), 'utf8'));
    assert.equal(parsed.classDescriptor, entry.classDescriptor, `${entry.path} class descriptor`);
    assert.deepEqual(parsed.classFlags, entry.classFlags, `${entry.path} class access flags`);
    assert.equal(parsed.normalizedClassSha256, entry.normalizedClassSha256, `${entry.path} normalized class structure`);
    assert.equal(parsed.sourceSha256, entry.sourceSha256, `${entry.path} source hash`);
    assert.deepEqual(parsed.methods, entry.methods, `${entry.path} method bodies and call edges`);
    methodCount += parsed.methods.length;
    invokeEdgeCount += parsed.methods.reduce((sum, method) => sum + method.invokeEdges.length, 0);
    dynamicInvokeSiteCount += parsed.methods.reduce((sum, method) => sum + method.dynamicInvokeInstructions.length, 0);
  }
  assert.equal(inventory.methodCount, methodCount);
  assert.equal(inventory.invokeEdgeCount, invokeEdgeCount);
  assert.equal(inventory.dynamicInvokeSiteCount, dynamicInvokeSiteCount);
  const sourceInventoryPath = path.join(mutationRoot, 'source-inventory.json');
  await mkdir(mutationRoot, { recursive: true });
  await writeFile(sourceInventoryPath, JSON.stringify(inventory, null, 2));
});

test('candidate keeps every school implementation, Cookie/session and public parameter method intact', async () => {
  assert.ok(candidateRoot, 'pass -DecodedRoot with the fresh built candidate for the preservation suite');
  const dependency = JSON.parse(await readFile(dependencyPath, 'utf8'));
  const encryptNetPath = 'smali_classes5/com/suda/yzune/wakeupschedule/aaa/utils/EncryptNet.smali';
  assertPrivateInvokeAbi(await readFile(path.join(candidateRoot, encryptNetPath), 'utf8'), {
    classDescriptor: 'Lcom/suda/yzune/wakeupschedule/aaa/utils/EncryptNet;',
    targetMethodDescriptor: 'OooO0oV(Lo000OO0o/OooO0O0;Lkotlin/jvm/functions/Function1;Lkotlin/jvm/functions/Function1;)V',
    callers: [
      { methodDescriptor: 'public final OooO0o(Lo000OO0o/OooO0O0;Lkotlin/jvm/functions/Function1;)V' },
      { methodDescriptor: 'public static final OooOO0O(Landroid/content/Context;Lo000OO0o/OooO0O0;Lcom/baidu/homework/common/net/OooOo00$Oooo0;Lcom/baidu/homework/common/net/OooOo00$OooOo00;)V' },
      { methodDescriptor: 'public final OooOOO0(Landroid/content/Context;Lo000OO0o/OooO0O0;Lkotlin/coroutines/OooO;)Ljava/lang/Object;' },
    ],
  }, encryptNetPath);
  const schoolFiles = await assertSchoolTreeUnchanged();
  const protectedMethods = [
    ['smali_classes5/com/suda/yzune/wakeupschedule/aaa/utils/o00O0000.smali', 'Lcom/suda/yzune/wakeupschedule/aaa/utils/o00O0000;', 'public static OooO0OO()Ljava/lang/String;'],
    ['smali_classes5/com/suda/yzune/wakeupschedule/aaa/utils/o00O0000.smali', 'Lcom/suda/yzune/wakeupschedule/aaa/utils/o00O0000;', 'public static OooO0oO()Lcom/suda/yzune/wakeupschedule/aaa/v1/UserInfo;'],
    ['smali_classes5/com/suda/yzune/wakeupschedule/aaa/utils/o00O0000.smali', 'Lcom/suda/yzune/wakeupschedule/aaa/utils/o00O0000;', 'public static OooOO0()Z'],
    ['smali_classes5/com/suda/yzune/wakeupschedule/aaa/utils/o00O0000.smali', 'Lcom/suda/yzune/wakeupschedule/aaa/utils/o00O0000;', 'public static OooO0o()Ljava/lang/String;'],
    ['smali_classes5/com/suda/yzune/wakeupschedule/aaa/base/OooO00o.smali', 'Lcom/suda/yzune/wakeupschedule/aaa/base/OooO00o;', 'public OooOOO0(Ljava/lang/reflect/Type;Ljava/util/List;)V'],
    ['smali_classes5/com/suda/yzune/wakeupschedule/aaa/base/Config.smali', 'Lcom/suda/yzune/wakeupschedule/aaa/base/Config;', 'public static OooO0Oo()Ljava/util/Map;'],
    ['smali_classes6/com/suda/yzune/wakeupschedule/schedule_import/login_school/OooO00o.smali', 'Lcom/suda/yzune/wakeupschedule/schedule_import/login_school/OooO00o;', 'public loadForRequest(Lokhttp3/HttpUrl;)Ljava/util/List;'],
    ['smali_classes6/com/suda/yzune/wakeupschedule/schedule_import/login_school/OooO00o.smali', 'Lcom/suda/yzune/wakeupschedule/schedule_import/login_school/OooO00o;', 'public saveFromResponse(Lokhttp3/HttpUrl;Ljava/util/List;)V'],
    ['smali_classes6/com/suda/yzune/wakeupschedule/schedule_import/login_school/hust/MobileHub.smali', 'Lcom/suda/yzune/wakeupschedule/schedule_import/login_school/hust/MobileHub;', 'public static final synthetic access$getCookieStore$p(Lcom/suda/yzune/wakeupschedule/schedule_import/login_school/hust/MobileHub;)Ljava/util/HashMap;'],
    ['smali_classes6/com/suda/yzune/wakeupschedule/schedule_import/login_school/jlu/UIMS.smali', 'Lcom/suda/yzune/wakeupschedule/schedule_import/login_school/jlu/UIMS;', 'public final getVPNSCookie(Lkotlin/coroutines/OooO;)Ljava/lang/Object;'],
  ];
  const methodHashes = [];
  for (const [relative, descriptor, signature] of protectedMethods) {
    const baseline = normalize(await readSmaliMethod(baselineRoot, relative, descriptor, signature));
    const candidate = normalize(await readSmaliMethod(candidateRoot, relative, descriptor, signature));
    assert.equal(candidate, baseline, `${signature} remains semantically identical`);
    methodHashes.push({ path: relative, classDescriptor: descriptor, methodDescriptor: signature, sha256: sha256(Buffer.from(candidate)) });
  }
  const baselineLib = sha256(await readFile(path.join(baselineRoot, 'lib/arm64-v8a/libbaseutil.so')));
  const candidateLib = sha256(await readFile(path.join(candidateRoot, 'lib/arm64-v8a/libbaseutil.so')));
  assert.equal(candidateLib, baselineLib, 'the native library bytes remain unchanged');

  const metadataRoot = path.dirname(candidateRoot);
  const candidatePurpose = process.env.SLIM_CANDIDATE_PURPOSE ?? 'release';
  const candidateMetadataPath = process.env.SLIM_CANDIDATE_METADATA_PATH
    ? path.resolve(process.env.SLIM_CANDIDATE_METADATA_PATH)
    : path.join(metadataRoot, 'release-metadata.json');
  let candidateMetadata = null;
  try { candidateMetadata = JSON.parse(await readFile(candidateMetadataPath, 'utf8')); } catch (error) {
    if (candidatePurpose !== 'unsigned') throw new Error(`Production candidate metadata is missing or invalid: ${error.message}`);
  }
  const candidateApkPath = process.env.SLIM_CANDIDATE_APK_PATH
    ? path.resolve(process.env.SLIM_CANDIDATE_APK_PATH)
    : candidateMetadata?.apkPath ? path.resolve(candidateMetadata.apkPath)
      : candidateMetadata?.apkRelativePath ? path.resolve(repoRoot, candidateMetadata.apkRelativePath) : null;
  const candidateApkSha256 = candidateApkPath ? sha256(await readFile(candidateApkPath)) : null;
  const expectedStage = candidatePurpose === 'pre-sign' ? 'pre-sign' : candidatePurpose === 'unsigned' ? 'unsigned' : 'signed';
  if (candidateMetadata) {
    assert.equal(candidateMetadata.schemaVersion, 3, 'candidate metadata uses the current evidence schema');
    assert.equal(candidateMetadata.stage, expectedStage, 'candidate metadata is bound to the requested build stage');
    assert.equal(candidateMetadata.candidatePurpose, candidatePurpose, 'candidate metadata purpose matches the current audit');
    assert.equal(candidateMetadata.normalizationVersion, dependency.normalizationVersion, 'candidate metadata binds the current normalizer');
    assert.equal(candidateMetadata.apkSha256, candidateApkSha256, 'candidate metadata binds the actual APK hash');
    assert.equal(path.resolve(candidateMetadata.apkPath), candidateApkPath, 'candidate metadata binds the actual APK path');
    assert.equal(path.resolve(candidateMetadata.decodedRoot), candidateRoot, 'candidate metadata binds the actual roundtrip decoded directory');
    assert.ok(Number.isSafeInteger(Number(candidateMetadata.versionCode)) && Number(candidateMetadata.versionCode) > 0, 'candidate metadata has a positive version code');
    assert.equal(candidateMetadata.methodInventorySha256, dependency.methodInventorySha256, 'candidate metadata binds this dependency inventory');
    assert.equal(candidateMetadata.patchSpecSha256, sha256(await readFile(specPath)), 'candidate metadata binds this patch spec');
    assert.equal(candidateMetadata.dependencyManifestSha256, sha256(await readFile(dependencyPath)), 'candidate metadata binds this dependency manifest');
    assert.equal(candidateMetadata.identitySpecSha256, sha256(await readFile('patches/slim-v1/package-identity-spec.json')), 'candidate metadata binds the identity spec');
    assert.equal(candidateMetadata.toolchainLockSha256, sha256(await readFile(lockPath)), 'candidate metadata binds the toolchain lock');
    assert.equal(candidateMetadata.normalizationVersion, 2, 'only current normalized evidence can pass');
    const inputSnapshot = await currentBuildInputHashes(candidateMetadata);
    assert.deepEqual(candidateMetadata.inputHashes, inputSnapshot.inputHashes, 'candidate metadata binds every current code, tool, baseline, and runtime input');
    assert.equal(candidateMetadata.buildInputSha256, inputSnapshot.buildInputSha256, 'candidate build input digest matches the complete current input set');
    assert.equal(candidateMetadata.runtimeSourceSha256, inputSnapshot.runtimeSourceTree, 'candidate binds the exact runtime Java source tree');
    assert.equal(candidateMetadata.packageName, 'io.github.wakeupnoads', 'candidate package identity is fixed');
    if (expectedStage === 'signed') {
      assert.match(candidateMetadata.certificateSha256, /^[A-F0-9]{64}$/, 'signed metadata records the actual certificate digest');
      assert.equal(candidateMetadata.identityId, candidateMetadata.certificateSha256, 'signed metadata binds its actual signing identity');
    }
    assert.ok(candidateMetadata.releaseName && candidateMetadata.versionName === candidateMetadata.releaseName, 'candidate version name is bound to releaseName');
  }
  const patchSpec = JSON.parse(await readFile(specPath, 'utf8'));
  const identitySpecPath = path.resolve('patches/slim-v1/package-identity-spec.json');
  const identitySpec = JSON.parse(await readFile(identitySpecPath, 'utf8'));
  const inventory = dependency.baselineMethodInventory.files;
  const protectedPaths = new Set(inventory.map(({ path: relative }) => relative));
  const allOperations = [...patchSpec.operations, ...identitySpec.operations];
  const protectedOperations = allOperations.filter((operation) => protectedPaths.has(operation.relativePath));
  const allowedOperationIds = [...new Set(protectedOperations.map(({ id }) => id))].sort();
  assert.deepEqual(allowedOperationIds, [...dependency.allowedOperationIds].sort(),
    'only explicitly listed operation ids may touch protected files');
  const apktool = await readFile(path.join(candidateRoot, 'apktool.yml'), 'utf8');
  const versionCode = Number(apktool.match(/^\s+versionCode:\s*['"]?(\d+)/m)?.[1]);
  const releaseName = apktool.match(/^\s+versionName:\s*['"]?([^'"\r\n]+)['"]?\s*$/m)?.[1];
  assert.ok(Number.isSafeInteger(versionCode) && versionCode > 0, 'candidate apktool metadata has a positive versionCode');
  assert.ok(releaseName, 'candidate apktool metadata has a versionName');
  if (candidateMetadata) {
    assert.equal(Number(candidateMetadata.versionCode), versionCode, 'candidate metadata versionCode matches the APK roundtrip');
    assert.equal(candidateMetadata.versionName, releaseName, 'candidate metadata versionName matches the APK roundtrip');
  }

  const fixtureRoot = await mkdtemp(path.join(mutationRoot, 'candidate-expected-'));
  const operationIdsByPath = new Map();
  for (const operation of protectedOperations) {
    if (!operationIdsByPath.has(operation.relativePath)) operationIdsByPath.set(operation.relativePath, []);
    operationIdsByPath.get(operation.relativePath).push(operation.id);
  }
  const protectedFileResults = [];
  const methodDifferences = [];
  const protectedMethodChanges = [];
  const unexplainedDifferences = [];
  const unexplainedEdges = [];
  let candidateLibraries = [];
  let expectedPatchResult;
  try {
    for (const { path: relative } of inventory) {
      const source = path.join(baselineRoot, relative);
      const target = path.join(fixtureRoot, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(source, target);
    }
    const fixtureSpecPath = path.join(fixtureRoot, 'filtered-protected-spec.json');
    await writeFile(fixtureSpecPath, JSON.stringify({
      schemaVersion: patchSpec.schemaVersion,
      baselineSha256: patchSpec.baselineSha256,
      applicationId: patchSpec.applicationId,
      operations: protectedOperations,
    }, null, 2));
    expectedPatchResult = await applyPatchSpec({
      root: fixtureRoot,
      specPath: fixtureSpecPath,
      applicationId: patchSpec.applicationId,
      versionCode,
      releaseName,
    });

    for (const entry of inventory) {
      const expectedText = await readFile(path.join(fixtureRoot, entry.path), 'utf8');
      const candidateText = await readFile(path.join(candidateRoot, entry.path), 'utf8');
      const baselineText = await readFile(path.join(baselineRoot, entry.path), 'utf8');
      const expectedMethods = methodMap(parseSmaliInventory(expectedText));
      const baselineMethods = methodMap(parseSmaliInventory(baselineText));
      const candidateMethods = methodMap(parseSmaliInventory(candidateText));
      const operationIds = operationIdsByPath.get(entry.path) ?? [];
      const fileMatches = normalize(candidateText) === normalize(expectedText);
      const methodSet = new Set([...baselineMethods.keys(), ...expectedMethods.keys()]);
      for (const methodDescriptor of methodSet) {
        const baselineMethod = baselineMethods.get(methodDescriptor);
        const expectedMethod = expectedMethods.get(methodDescriptor);
        const candidateMethod = candidateMethods.get(methodDescriptor);
        if (sameSmaliMethodInventory(baselineMethod, expectedMethod)) continue;
        const operationIdsForMethod = protectedOperations
          .filter((operation) => operation.relativePath === entry.path && operation.method?.methodDescriptor?.split(/\s+/).at(-1) === methodDescriptor)
          .map(({ id }) => id);
        const candidateEdges = candidateMethod?.invokeEdges ?? [];
        const expectedEdges = expectedMethod?.invokeEdges ?? [];
        const edgeDelta = diffInvokeEdges(expectedEdges, candidateEdges);
        for (const edge of edgeDelta.added) unexplainedEdges.push({
          path: entry.path,
          classDescriptor: entry.classDescriptor,
          methodDescriptor,
          operationIds: operationIdsForMethod,
          direction: 'added',
          edge,
        });
        for (const edge of edgeDelta.removed) unexplainedEdges.push({
          path: entry.path,
          classDescriptor: entry.classDescriptor,
          methodDescriptor,
          operationIds: operationIdsForMethod,
          direction: 'removed',
          edge,
        });
        protectedMethodChanges.push({
          path: entry.path,
          classDescriptor: entry.classDescriptor,
          methodDescriptor,
          allowedOperationIds: operationIdsForMethod,
          baselineBodySha256: baselineMethod?.normalizedBodySha256 ?? null,
          expectedBodySha256: expectedMethod?.normalizedBodySha256 ?? null,
          candidateBodySha256: candidateMethods.get(methodDescriptor)?.normalizedBodySha256 ?? null,
          baselineInvokeEdges: baselineMethod?.invokeEdges ?? [],
          expectedInvokeEdges: expectedMethod?.invokeEdges ?? [],
          addedFromBaseline: diffInvokeEdges(baselineMethod?.invokeEdges ?? [], expectedMethod?.invokeEdges ?? []).added,
          removedFromBaseline: diffInvokeEdges(baselineMethod?.invokeEdges ?? [], expectedMethod?.invokeEdges ?? []).removed,
          addedAgainstExpected: edgeDelta.added,
          removedAgainstExpected: edgeDelta.removed,
          expectedInvokeTargets: expectedMethod?.invokeTargets ?? [],
          candidateInvokeTargets: candidateMethods.get(methodDescriptor)?.invokeTargets ?? [],
          expectedControlFlowEdges: expectedMethod?.controlFlowEdges ?? [],
          candidateControlFlowEdges: candidateMethods.get(methodDescriptor)?.controlFlowEdges ?? [],
          candidateMatchesExpected: sameSmaliMethodInventory(expectedMethod, candidateMethods.get(methodDescriptor)),
        });
      }
      if (!fileMatches) {
        const methods = new Set([...expectedMethods.keys(), ...candidateMethods.keys()]);
        for (const methodDescriptor of methods) {
          const expectedMethod = expectedMethods.get(methodDescriptor);
          const actualMethod = candidateMethods.get(methodDescriptor);
          if (sameSmaliMethodInventory(expectedMethod, actualMethod)) continue;
          const operationIdsForMethod = protectedOperations
            .filter((operation) => operation.relativePath === entry.path && operation.method?.methodDescriptor?.split(/\s+/).at(-1) === methodDescriptor)
            .map(({ id }) => id);
          methodDifferences.push({
            path: entry.path,
            classDescriptor: entry.classDescriptor,
            methodDescriptor,
            allowedOperationIds: operationIdsForMethod,
            expectedBodySha256: expectedMethod?.normalizedBodySha256 ?? null,
            candidateBodySha256: actualMethod?.normalizedBodySha256 ?? null,
            expectedInvokeTargets: expectedMethod?.invokeTargets ?? [],
            candidateInvokeTargets: actualMethod?.invokeTargets ?? [],
            expectedControlFlowEdges: expectedMethod?.controlFlowEdges ?? [],
            candidateControlFlowEdges: actualMethod?.controlFlowEdges ?? [],
          });
        }
        unexplainedDifferences.push({
          path: entry.path,
          allowedOperationIds: operationIds,
          expectedSha256: sha256(Buffer.from(normalize(expectedText))),
          candidateSha256: sha256(Buffer.from(normalize(candidateText))),
          reason: 'normalized file content differs from baseline plus exact allowed operations',
        });
      }
      protectedFileResults.push({
        path: entry.path,
        classDescriptor: entry.classDescriptor,
        methodCount: entry.methods.length,
        invokeEdgeCount: entry.methods.reduce((sum, method) => sum + method.invokeEdges.length, 0),
        allowedOperationIds: operationIds,
        baselineSha256: sha256(Buffer.from(baselineText)),
        expectedSha256: sha256(Buffer.from(expectedText)),
        candidateSha256: sha256(Buffer.from(candidateText)),
        baselineNormalizedClassSha256: parseSmaliInventory(baselineText).normalizedClassSha256,
        expectedNormalizedClassSha256: parseSmaliInventory(expectedText).normalizedClassSha256,
        candidateNormalizedClassSha256: parseSmaliInventory(candidateText).normalizedClassSha256,
        classFlags: parseSmaliInventory(candidateText).classFlags,
        changedFromBaseline: normalize(expectedText) !== normalize(await readFile(path.join(baselineRoot, entry.path), 'utf8')),
        matchesExpectedCandidate: fileMatches,
      });
    }
    assert.deepEqual(unexplainedDifferences, [], 'every protected file matches the locked baseline plus exact allowed operations');
    assert.deepEqual(unexplainedEdges, [], 'every protected invoke edge matches the locked baseline plus exact allowed operations');

    async function listNativeLibraries(root, relative = 'lib') {
      const directory = path.join(root, relative);
      let items;
      try { items = await readdir(directory, { withFileTypes: true }); } catch { return []; }
      const results = [];
      for (const item of items) {
        const next = path.posix.join(relative.replaceAll('\\', '/'), item.name);
        if (item.isDirectory()) results.push(...await listNativeLibraries(root, next));
        else if (item.isFile() && item.name.endsWith('.so')) {
          results.push({ path: next, sha256: sha256(await readFile(path.join(root, next))) });
        }
      }
      return results.sort((left, right) => left.path.localeCompare(right.path));
    }
    const baselineLibraries = await listNativeLibraries(baselineRoot);
    candidateLibraries = await listNativeLibraries(candidateRoot);
    assert.deepEqual(candidateLibraries, baselineLibraries, 'all native library paths and bytes match baseline');
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }

  const routes = [];
  for (const route of dependency.routeEntrypoints) {
    const baselineBody = await readSmaliMethod(baselineRoot, route.source.path, route.source.classDescriptor, route.source.methodDescriptor);
    const candidateBody = await readSmaliMethod(candidateRoot, route.source.path, route.source.classDescriptor, route.source.methodDescriptor);
    for (const target of route.requiredTargets ?? []) {
      assert.ok(candidateBody.includes(target), `${route.id} candidate preserves required call edge ${target}`);
    }
    if (route.target) assert.ok(candidateBody.includes(route.target), `${route.id} candidate reaches or returns ${route.target}`);
    const baselineMethod = parseSmaliInventory(baselineBody).methods[0];
    const candidateMethod = parseSmaliInventory(candidateBody).methods[0];
    const operationIds = protectedOperations
      .filter((operation) => operation.relativePath === route.source.path && operation.method?.methodDescriptor?.split(/\s+/).at(-1) === route.source.methodDescriptor.split(/\s+/).at(-1))
      .map(({ id }) => id);
    const expectedChange = protectedMethodChanges.find((change) => change.path === route.source.path && change.methodDescriptor === route.source.methodDescriptor.split(/\s+/).at(-1));
    const edgeDelta = diffInvokeEdges(baselineMethod?.invokeEdges ?? [], candidateMethod?.invokeEdges ?? []);
    const routeUnexplainedEdges = unexplainedEdges.filter((edge) => edge.path === route.source.path && edge.methodDescriptor === route.source.methodDescriptor.split(/\s+/).at(-1));
    const coroutineChildren = [];
    for (const child of route.coroutineChildren ?? []) {
      const childBaseline = await readSmaliMethod(baselineRoot, child.path, child.classDescriptor, child.methodDescriptor);
      const childCandidate = await readSmaliMethod(candidateRoot, child.path, child.classDescriptor, child.methodDescriptor);
      for (const target of child.requiredTargets ?? []) {
        assert.ok(childCandidate.includes(target), `${route.id} candidate coroutine child preserves ${target}`);
      }
      const childBaselineMethod = parseSmaliInventory(childBaseline).methods[0];
      const childCandidateMethod = parseSmaliInventory(childCandidate).methods[0];
      const childOperationIds = protectedOperations
        .filter((operation) => operation.relativePath === child.path && operation.method?.methodDescriptor?.split(/\s+/).at(-1) === child.methodDescriptor.split(/\s+/).at(-1))
        .map(({ id }) => id);
      const childDelta = diffInvokeEdges(childBaselineMethod?.invokeEdges ?? [], childCandidateMethod?.invokeEdges ?? []);
      coroutineChildren.push({
        ...child,
        operationIds: childOperationIds,
        baselineInvokeTargets: childBaselineMethod?.invokeTargets ?? [],
        candidateInvokeTargets: childCandidateMethod?.invokeTargets ?? [],
        addedInvokeEdges: childDelta.added,
        removedInvokeEdges: childDelta.removed,
      });
    }
    routes.push({
      id: route.id,
      source: route.source,
      routeTypes: route.routeTypes ?? [],
      target: route.target ?? null,
      requiredTargets: route.requiredTargets ?? [],
      protectedChildren: route.protectedChildren ?? [],
      operationIds,
      baselineBodySha256: baselineMethod?.normalizedBodySha256 ?? null,
      expectedBodySha256: expectedChange?.expectedBodySha256 ?? baselineMethod?.normalizedBodySha256 ?? null,
      candidateBodySha256: candidateMethod?.normalizedBodySha256 ?? null,
      baselineControlFlowEdges: baselineMethod?.controlFlowEdges ?? [],
      candidateControlFlowEdges: candidateMethod?.controlFlowEdges ?? [],
      baselineInvokeTargets: baselineMethod?.invokeTargets ?? [],
      expectedInvokeTargets: expectedChange?.expectedInvokeTargets ?? baselineMethod?.invokeTargets ?? [],
      candidateInvokeTargets: candidateMethod?.invokeTargets ?? [],
      candidateMatchesExpected: expectedChange
        ? expectedChange.candidateMatchesExpected
        : sameSmaliMethodInventory(baselineMethod, candidateMethod),
      expectedOperationIds: expectedChange?.allowedOperationIds ?? [],
      addedInvokeEdges: edgeDelta.added,
      removedInvokeEdges: edgeDelta.removed,
      unexplainedEdges: routeUnexplainedEdges,
      coroutineChildren,
      boundary: route.boundary ?? null,
    });
  }
  async function candidateMethodEvidence(reference) {
    const body = await readSmaliMethod(candidateRoot, reference.path, reference.classDescriptor, reference.methodDescriptor);
    const method = parseSmaliInventory(body).methods[0];
    return {
      path: reference.path,
      classDescriptor: reference.classDescriptor,
      methodDescriptor: reference.methodDescriptor,
      normalizedBodySha256: method.normalizedBodySha256,
      invokeEdges: method.invokeEdges,
      invokeTargets: method.invokeTargets,
      controlFlowEdges: method.controlFlowEdges,
      body,
    };
  }
  const crypto = dependency.cryptoLifecycle;
  const versionReader = await candidateMethodEvidence(crypto.versionCodeSeed.reader);
  const versionSeedAdapter = await candidateMethodEvidence(crypto.versionCodeSeed.rc4Adapter);
  const runtimeVersionCheck = await candidateMethodEvidence(crypto.versionCodeSeed.runtimeCheck);
  for (const target of crypto.versionCodeSeed.rc4Adapter.requiredInvokeTargets) {
    assert.ok(versionSeedAdapter.body.includes(target), `candidate version-code seed preserves ${target}`);
  }
  for (const target of crypto.versionCodeSeed.rc4Adapter.candidateRequiredInvokeTargets ?? []) {
    assert.ok(versionSeedAdapter.body.includes(target), `candidate version-code seed is connected to ${target}`);
  }
  for (const constant of crypto.versionCodeSeed.runtimeCheck.requiredConstants) {
    assert.ok(runtimeVersionCheck.body.includes(constant), `candidate version-code validation uses ${constant}`);
  }
  for (const target of crypto.versionCodeSeed.runtimeCheck.requiredInvokeTargets) {
    assert.ok(runtimeVersionCheck.body.includes(target), `candidate version-code validation calls ${target}`);
  }
  const invalidationAdapter = await candidateMethodEvidence(crypto.cacheInvalidation.adapter);
  const invalidationImplementation = await candidateMethodEvidence(crypto.cacheInvalidation.implementation);
  assert.ok(invalidationAdapter.body.includes(crypto.cacheInvalidation.adapter.clearedKeyField), 'candidate invalidation clears the cached key field');
  for (const target of crypto.cacheInvalidation.adapter.requiredInvokeTargets) {
    assert.ok(invalidationAdapter.body.includes(target), `candidate invalidation adapter calls ${target}`);
  }
  for (const target of crypto.cacheInvalidation.implementation.requiredInvokeTargets) {
    assert.ok(invalidationImplementation.body.includes(target), `candidate invalidation implementation calls ${target}`);
  }
  const baseutilLoader = await candidateMethodEvidence(crypto.nativeBaseutil.loader);
  const baseutilInitialize = await candidateMethodEvidence(crypto.nativeBaseutil.initializeMethod);
  const baseutilReady = await candidateMethodEvidence(crypto.nativeBaseutil.readyMethod);
  for (const target of crypto.nativeBaseutil.loader.requiredInvokeTargets) {
    assert.ok(baseutilLoader.body.includes(target), `candidate native loader keeps ${target}`);
  }
  for (const target of crypto.nativeBaseutil.initializeMethod.requiredInvokeTargets) {
    assert.ok(baseutilInitialize.body.includes(target), `candidate initializer keeps ${target}`);
  }
  for (const field of crypto.nativeBaseutil.readyMethod.requiredFields ?? []) {
    assert.ok(baseutilReady.body.includes(field), `candidate baseutil readiness method reads ${field}`);
  }
  const nativeHelperMethods = [];
  for (const signature of crypto.nativeBaseutil.nativeHelper.nativeMethods) {
    nativeHelperMethods.push(await candidateMethodEvidence({
      ...crypto.nativeBaseutil.nativeHelper,
      methodDescriptor: signature,
    }));
  }
  const baseutilLibraries = candidateLibraries.filter((library) => library.path.endsWith('/libbaseutil.so'));
  const baseutilAbiSet = [...new Set(baseutilLibraries.map((library) => library.path.split('/')[1]))].sort();
  assert.deepEqual(baseutilAbiSet, [...crypto.nativeBaseutil.abiSet].sort(), 'candidate baseutil ABI set matches the reviewed baseline');
  assert.equal(baseutilLibraries.length, crypto.nativeBaseutil.abiSet.length, 'each reviewed baseutil ABI has exactly one library');
  assert.equal(baseutilLibraries.find((library) => library.path === crypto.nativeBaseutil.libraryPath)?.sha256, crypto.nativeBaseutil.sha256,
    'candidate baseutil bytes match the recorded SHA-256');
  const summarizeMethodEvidence = ({ body: _body, ...evidence }) => evidence;
  const versionReaderBaseline = await readSmaliMethod(baselineRoot, crypto.versionCodeSeed.reader.path,
    crypto.versionCodeSeed.reader.classDescriptor, crypto.versionCodeSeed.reader.methodDescriptor);
  const versionReaderBaselineHash = parseSmaliInventory(versionReaderBaseline).methods[0].normalizedBodySha256;
  const protectedDecodedInventory = protectedFileResults.map(({ path: relative, candidateSha256 }) => ({ path: relative, sha256: candidateSha256 }));
  const baseutilLibrary = baseutilLibraries.find((library) => library.path === crypto.nativeBaseutil.libraryPath);
  const candidateAuditPath = path.join(metadataRoot, 'teaching-preservation-result.json');
  const result = {
    schemaVersion: 3,
    normalizationVersion: dependency.normalizationVersion,
    stage: expectedStage,
    success: true,
    baselineSha256: dependency.baseline.sha256,
    candidateRoot,
    candidateApkPath,
    candidateApkSha256,
    candidatePurpose,
    versionCode,
    releaseName,
    dependencyManifestSha256: sha256(await readFile(dependencyPath)),
    patchSpecSha256: sha256(await readFile(specPath)),
    identitySpecSha256: sha256(await readFile(identitySpecPath)),
    methodInventorySha256: dependency.methodInventorySha256,
    buildInputSha256: candidateMetadata?.buildInputSha256 ?? null,
    runtimeSourceSha256: candidateMetadata?.runtimeSourceSha256 ?? null,
    toolchainLockSha256: candidateMetadata?.toolchainLockSha256 ?? sha256(await readFile(lockPath)),
    toolPaths: candidateMetadata?.toolPaths ?? null,
    tools: { nodeVersion: process.version, apktoolVersion: JSON.parse(await readFile(lockPath, 'utf8')).apktool.version,
      androidBuildToolsVersion: JSON.parse(await readFile(lockPath, 'utf8')).androidBuildTools.version },
    candidateMetadataPath: candidateMetadata ? candidateMetadataPath : null,
    inputHashes: candidateMetadata?.inputHashes ?? null,
    protectedDecodedInventorySha256: sha256(Buffer.from(JSON.stringify(protectedDecodedInventory))),
    allowedOperationIds,
    appliedProtectedOperations: expectedPatchResult.operations,
    nativeLibrary: { path: crypto.nativeBaseutil.libraryPath, sha256: candidateLib, expectedSha256: crypto.nativeBaseutil.sha256, unchanged: true },
    nativeLibraries: candidateLibraries.map((library) => ({ ...library, unchanged: true })),
    nativeAbiSet: [...new Set(candidateLibraries.map((library) => library.path.split('/')[1]))].sort(),
    cryptoLifecycle: {
      versionCodeSeed: {
        packageVersionCode: versionCode,
        expectedDecimalSeedArgument: String(versionCode),
        readerBaselineBodySha256: versionReaderBaselineHash,
        readerCandidate: summarizeMethodEvidence(versionReader),
        rc4Adapter: summarizeMethodEvidence(versionSeedAdapter),
        runtimeKeyCheck: summarizeMethodEvidence(runtimeVersionCheck),
      },
      cacheInvalidation: {
        adapter: summarizeMethodEvidence(invalidationAdapter),
        implementation: summarizeMethodEvidence(invalidationImplementation),
      },
      baseutil: {
        libraryPath: crypto.nativeBaseutil.libraryPath,
        expectedSha256: crypto.nativeBaseutil.sha256,
        actualSha256: baseutilLibrary.sha256,
        abiSet: baseutilAbiSet,
        loader: summarizeMethodEvidence(baseutilLoader),
        initialize: summarizeMethodEvidence(baseutilInitialize),
        readiness: summarizeMethodEvidence(baseutilReady),
        nativeHelperMethods: nativeHelperMethods.map(summarizeMethodEvidence),
      },
    },
    protectedFiles: protectedFileResults,
    protectedSchoolFiles: schoolFiles.map(({ path: relative, classDescriptor, methods }) => ({
      path: relative,
      classDescriptor,
      methodCount: methods.length,
      invokeEdgeCount: methods.reduce((total, method) => total + method.invokeEdges.length, 0),
      matchesExpectedCandidate: protectedFileResults.find((file) => file.path === relative)?.matchesExpectedCandidate ?? false,
    })),
    protectedMethods: methodHashes,
    protectedMethodChanges,
    methodDifferences,
    routes,
    unexplainedDifferences,
    unexplainedEdges,
    deviceOrServerClaims: [],
  };
  assert.equal(result.routes.length, dependency.routeEntrypoints.length, 'candidate audit includes every declared teaching route');
  assert.ok(result.routes.every((route) => route.baselineBodySha256 && route.expectedBodySha256 && route.candidateBodySha256),
    'every route reports baseline, expected, and candidate method hashes');
  assert.deepEqual(result.unexplainedDifferences, [], 'candidate audit has no unapproved protected-file changes');
  assert.deepEqual(result.unexplainedEdges, [], 'candidate audit has no unapproved or unknown invoke edges');
  assert.ok(result.routes.every((route) => route.candidateMatchesExpected), 'every teaching route method matches its exact protected expectation');
  assert.equal(result.cryptoLifecycle.versionCodeSeed.packageVersionCode, versionCode);
  assert.equal(result.cryptoLifecycle.versionCodeSeed.expectedDecimalSeedArgument, String(versionCode));
  assert.deepEqual(result.cryptoLifecycle.baseutil.abiSet, crypto.nativeBaseutil.abiSet);
  assert.equal(result.cryptoLifecycle.baseutil.actualSha256, crypto.nativeBaseutil.sha256);
  await mkdir(metadataRoot, { recursive: true });
  await writeFile(candidateAuditPath, JSON.stringify(result, null, 2));
  if (candidateMetadata && candidateApkPath && candidateMetadata.stage === 'signed' && candidateMetadata.success === true) {
    const indexPath = path.join(repoRoot, 'tools/_cache/slim-v1-build/teaching-preservation-result.json');
    const index = {
      schemaVersion: 1,
      candidateAudit: path.relative(repoRoot, candidateAuditPath).replaceAll('\\', '/'),
      candidateRoot,
      versionCode,
      releaseName,
      candidateApkSha256: result.candidateApkSha256,
      dependencyManifestSha256: result.dependencyManifestSha256,
      patchSpecSha256: result.patchSpecSha256,
    };
    await mkdir(path.dirname(indexPath), { recursive: true });
    await writeFile(indexPath, JSON.stringify(index, null, 2));
  }
});

test('preservation guards detect JS bridge, parser, Cookie and permission widening mutations', async () => {
  const actualBridge = await readSmaliMethod(
    baselineRoot,
    'smali_classes6/com/suda/yzune/wakeupschedule/schedule_import/v2/ParserFragment$configWebView$6.smali',
    'Lcom/suda/yzune/wakeupschedule/schedule_import/v2/ParserFragment$configWebView$6;',
    'public onAction(Landroid/app/Activity;Lorg/json/JSONObject;Lcom/baidu/homework/common/ui/widget/HybridWebView$OooOo;)V',
  );
  const actualParser = await readSmaliMethod(
    baselineRoot,
    'smali_classes6/com/suda/yzune/wakeupschedule/schedule_import/ImportViewModel$loginTsinghua$2.smali',
    'Lcom/suda/yzune/wakeupschedule/schedule_import/ImportViewModel$loginTsinghua$2;',
    'public final invokeSuspend(Ljava/lang/Object;)Ljava/lang/Object;',
  );
  const actualCookie = await readSmaliMethod(
    baselineRoot,
    'smali_classes6/com/suda/yzune/wakeupschedule/schedule_import/login_school/OooO00o.smali',
    'Lcom/suda/yzune/wakeupschedule/schedule_import/login_school/OooO00o;',
    'public loadForRequest(Lokhttp3/HttpUrl;)Ljava/util/List;',
  );
  const actualPolicy = await readFile('runtime/src/com/suda/yzune/wakeupschedule/slim/SlimNetworkPolicy.java', 'utf8');
  const policyStart = actualPolicy.indexOf('public static boolean allowsStatic(');
  const policyEnd = actualPolicy.indexOf('\n    }', policyStart);
  const allowsStatic = actualPolicy.slice(policyStart, policyEnd + '\n    }'.length);
  const bridgeActionLine = actualBridge.split('\n').find((line) => /EncryptNet;->OooOO0O\(/.test(line));
  const parserHttpLine = actualParser.split('\n').find((line) => /Lorg\/jsoup\/Connection;->execute\(/.test(line));
  const cookieLookupLine = actualCookie.split('\n').find((line) => /ConcurrentHashMap;->get\(/.test(line));
  assert.ok(bridgeActionLine, 'fixture has an actual JS bridge callback edge');
  assert.ok(parserHttpLine, 'fixture has an actual Tsinghua Jsoup exchange edge');
  assert.ok(cookieLookupLine, 'fixture has the actual school Cookie lookup edge');
  assert.ok(smaliInvokeEdges(actualBridge).some(({ target }) => target.includes('EncryptNet;->OooOO0O(')),
    'the restricted fixture extracts the real encrypted bridge dispatch edge');
  const baselineBridgeInventory = parseSmaliInventory(actualBridge).methods[0];
  const bridgeMutation = actualBridge.replace(bridgeActionLine, '    nop');
  const bridgeMutationInventory = parseSmaliInventory(bridgeMutation).methods[0];
  const bridgeEdgeDelta = diffInvokeEdges(baselineBridgeInventory.invokeEdges, bridgeMutationInventory.invokeEdges);
  assert.ok(bridgeEdgeDelta.removed.some(({ target }) => target.includes('EncryptNet;->OooOO0O(')),
    'an omitted route edge is reported with its original full target');
  assert.ok(smaliInvokeEdges(actualParser).some(({ target }) => target.includes('Connection;->execute(')),
    'the restricted fixture extracts the real parser HTTP edge');
  const mutations = [
    ['JS bridge action', actualBridge.replace(bridgeActionLine, '    nop')],
    ['parser dispatch', actualParser.replace(parserHttpLine, '    nop')],
    ['school Cookie handling', actualCookie.replace(cookieLookupLine, '    nop')],
    ['network permission widening', allowsStatic.replace('return false;', 'return true;')],
  ];
  const originalSources = [actualBridge, actualParser, actualCookie, allowsStatic];
  for (const [index, [label, mutated]] of mutations.entries()) {
    const matches = index < 3
      ? sameExecutableSmaliMethod(originalSources[index], mutated)
      : normalize(originalSources[index]) === normalize(mutated);
    assert.equal(matches, false, `${label} mutation is rejected at its source method`);
    if (index < 3) {
      assert.notDeepEqual(smaliInvokeEdges(originalSources[index]), smaliInvokeEdges(mutated),
        `${label} mutation changes the extracted invoke edges`);
    }
  }
});

test('T30 exact method and native hash checks identify loader, initialization, and route mutations', async () => {
  const outputRoot = path.join(mutationRoot, 't30-loader-route-mutations');
  await mkdir(outputRoot, { recursive: true });
  const cases = [
    {
      id: 'native-loader-removed',
      relative: 'smali_classes6/com/zuoyebang/baseutil/OooO00o.smali',
      classDescriptor: 'Lcom/zuoyebang/baseutil/OooO00o;',
      descriptor: 'static constructor <clinit>()V',
      edge: 'Ljava/lang/System;->loadLibrary(Ljava/lang/String;)V',
      mutate: (method) => method.replace('invoke-static {v0}, Ljava/lang/System;->loadLibrary(Ljava/lang/String;)V', 'nop'),
    },
    {
      id: 'nativeSetToken-edge-removed',
      relative: 'smali_classes6/com/zuoyebang/baseutil/OooO00o.smali',
      classDescriptor: 'Lcom/zuoyebang/baseutil/OooO00o;',
      descriptor: 'public static declared-synchronized OooO0o()Z',
      edge: 'NativeHelper;->nativeSetToken(',
      mutate: (method) => method.replace(/    invoke-static \{v0, v3, v4, v5\}, Lcom\/zuoyebang\/baseutil\/NativeHelper;->nativeSetToken\([^\r\n]+/, '    const/4 v0, 0x0'),
    },
    {
      id: 'sync-bootstrap-overall-return',
      relative: 'smali_classes2/com/baidu/homework/common/net/OooOo00.smali',
      classDescriptor: 'Lcom/baidu/homework/common/net/OooOo00;',
      descriptor: 'public static OoooO0O(Lo000OO0o/OooO0O0;Ljava/lang/Class;ZZ)Ljava/lang/Object;',
      edge: 'NetContext;->OooO00o()',
      mutate: (method) => `${method.split('\n', 1)[0]}\n    .locals 1\n    const/4 v0, 0x0\n    return-object v0\n.end method\n`,
    },
    {
      id: 'parser-route-rerouted',
      relative: 'smali_classes6/com/suda/yzune/wakeupschedule/schedule_import/LoginWebActivity.smali',
      classDescriptor: 'Lcom/suda/yzune/wakeupschedule/schedule_import/LoginWebActivity;',
      descriptor: 'public final o0OoOo0(Landroid/os/Bundle;)Ljava/lang/Boolean;',
      mutate: (method) => method.replace('const-string v1, "ziyan"', 'const-string v1, "unknown"'),
    },
  ];
  for (const mutation of cases) {
    const expected = await readSmaliMethod(baselineRoot, mutation.relative, mutation.classDescriptor, mutation.descriptor);
    const changed = mutation.mutate(expected);
    const diagnostic = `${mutation.relative}::${mutation.descriptor}`;
    assert.notEqual(changed, expected, `${mutation.id} mutates an actual baseline method`);
    assert.equal(sameExecutableSmaliMethod(expected, changed), false,
      `${mutation.id} is rejected by the same method comparison at ${diagnostic}`);
    if (mutation.edge) {
      assert.equal(smaliInvokeEdges(expected).some(({ target }) => target.includes(mutation.edge)), true,
        `${mutation.id} begins with the actual protected edge`);
      assert.equal(smaliInvokeEdges(changed).some(({ target }) => target.includes(mutation.edge)), false,
        `${mutation.id} removes the protected edge`);
    }
    const target = path.join(outputRoot, mutation.id, path.basename(mutation.relative));
    await mkdir(path.dirname(target), { recursive: true });
    const wholeFile = await readFile(path.join(baselineRoot, mutation.relative), 'utf8');
    await writeFile(target, wholeFile.replace(expected, changed), 'utf8');
  }

  const library = await readFile(path.join(baselineRoot, 'lib/arm64-v8a/libbaseutil.so'));
  const changedLibrary = Buffer.from(library);
  changedLibrary[0] ^= 0x01;
  assert.notEqual(sha256(changedLibrary), sha256(library),
    'the same native-library SHA check rejects a one-byte libbaseutil mutation');
  await writeFile(path.join(outputRoot, 'libbaseutil-mutated.so'), changedLibrary);
});
