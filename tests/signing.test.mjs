import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, link, mkdir, mkdtemp, readFile, readdir, rm, rmdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const signing = await readFile('scripts/signing.ps1', 'utf8');
const build = await readFile('scripts/build.ps1', 'utf8');
const testScript = await readFile('scripts/test.ps1', 'utf8');

test('long-term signing initialization is explicit, protected, and refuses replacement', () => {
  assert.match(signing, /ValidateSet\('Initialize', 'VerifyIdentity', 'Backup', 'RecordRelease', 'Release'\)/);
  assert.match(signing, /Read-ReleasePassword -MinimumLength/);
  assert.doesNotMatch(signing, /Read-Host/);
  assert.doesNotMatch(signing, /Confirm release keystore password/);
  assert.match(signing, /Initialize refuses to overwrite any existing signing target/);
  assert.match(signing, /-keyalg RSA -keysize 3072 -sigalg SHA256withRSA -validity 10000/);
  assert.match(signing, /'-storepass:env' \$PasswordVariable '-keypass:env' \$PasswordVariable/);
  assert.doesNotMatch(signing, /-storepass:env=/);
  assert.match(signing, /CN=WakeupNoAds/);
  assert.match(signing, /SetEnvironmentVariable\(\$PasswordVariable, \$PreviousPassword, 'Process'\)/);
  assert.match(signing, /function Assert-PrivateKeyAccess/);
  assert.doesNotMatch(signing, /password\s*=\s*['"][^'"]+['"]/i);
});

test('identity verification and backup require the fixed certificate fingerprint', () => {
  assert.match(signing, /Assert-KeystoreMatchesIdentity/);
  assert.match(signing, /Signing keystore certificate fingerprint differs from signing-identity\.json/);
  assert.match(signing, /Backup target already exists and will not be overwritten/);
  assert.match(signing, /partial backup is preserved for recovery/);
  assert.match(signing, /schemaVersion = 2/);
});

test('ready.json written by ReleaseSigned carries every field the signing evidence check reads', () => {
  const readyStart = build.indexOf('$ready = [ordered]@{');
  assert.notEqual(readyStart, -1);
  const readyBlock = build.slice(readyStart, build.indexOf('\n    }\n', readyStart));
  const written = new Set([...readyBlock.matchAll(/^\s+([A-Za-z0-9_]+)\s*=/gm)].map((match) => match[1]));
  const read = new Set([...signing.matchAll(/\$ready\.([A-Za-z0-9_]+)/g)].map((match) => match[1]));
  assert.ok(read.has('protectedPayloadHashes'));
  assert.deepEqual([...read].filter((field) => !written.has(field)), []);
  assert.match(readyBlock, /protectedPayloadHashes = \$signedPayloadHashes/);
  assert.match(readyBlock, /identityId = \$signedStage\.metadata\.identityId/);
  assert.match(signing, /versionScript = Get-FileSha256 \(Join-Path \$ProjectRoot 'scripts\/version\.mjs'\)/);
  assert.match(build, /versionScript = Get-Sha256 \(Join-Path \$PSScriptRoot 'version\.mjs'\)/);
  assert.match(readyBlock, /buildInputSha256 = \$metadata\.buildInputSha256/);
});

test('release history is monotonic and an existing candidate can finish registration', () => {
  assert.match(signing, /New delivered versionCode must strictly exceed all registered versions/);
  assert.match(signing, /Version code is already registered to a different APK or release identity/);
  assert.match(signing, /Write-AtomicJson \$HistoryPath \$updatedHistory/);
  const existingCandidateBranch = build.slice(build.indexOf('if ((Test-Path -LiteralPath $candidateRoot)'));
  assert.match(existingCandidateBranch, /current ready evidence; refusing reuse or overwrite/);
  assert.match(existingCandidateBranch, /-PreservationEvidencePath \$readyPath/);
  assert.match(signing, /function Assert-ReadyPreservationEvidence/);
  assert.doesNotMatch(signing, /Archive-FailedCandidate|RotateAndReleasePair|ReleasePair|VersionCodeA/);
  assert.match(signing, /Release completed: /);
  assert.match(signing, /Invoke-SigningInternalAction 'RecordRelease' \$candidateApk \$metadataPath \$readyPath/);
  assert.match(signing, /Set-KeystorePassword[\s\S]*Assert-CurrentIdentityPair -ProbePrivateKeys[\s\S]*-Mode Unsigned -PrepareOnly/);
  assert.match(signing, /PreSignCheck failed[\s\S]*no APK signature or registration was started/);
  assert.match(build, /if \(\$Mode -eq 'PreSignCheck'\)/);
  assert.match(build, /Invoke-CandidatePreservationAudit \$decodedRoot \$candidateApk/);
  assert.match(testScript, /CandidateMetadataPath/);
  assert.match(testScript, /SLIM_CANDIDATE_METADATA_PATH/);
  assert.doesNotMatch(build, /Action Initialize/);
  assert.match(build, /Read-ReleasePassword/);
  assert.match(build, /-Action VerifyIdentity[\s\S]*Ensure-AndroidBuildTools/);
  assert.doesNotMatch(build, /Read-Host|Long-term release keystore password/);
});

const signingFixtureRoot = path.resolve('tools/_cache/slim-v1-signing-round4-tests');
// Per-test roots are removed by each test; drop the shared root once it is empty.
after(() => rmdir(signingFixtureRoot).catch(() => {}));
const buildToolsFixture = path.resolve('tools/android-build-tools-35.0.0/android-15');
const javaHomeFixture = process.env.JAVA_HOME || 'D:/Program Files/Java/JDK25';
const nodeFixture = process.execPath;
const signedFixtureName = 'wakeup-noads-v6.5.2-r1.apk';

async function linkOrCopy(source, destination) {
  await mkdir(path.dirname(destination), { recursive: true });
  try { await link(source, destination); } catch { await copyFile(source, destination); }
}

async function copyRuntimeSources(sourceRoot, destinationRoot, relative = '') {
  const directory = path.join(sourceRoot, relative);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const next = path.join(relative, entry.name);
    if (entry.isDirectory()) await copyRuntimeSources(sourceRoot, destinationRoot, next);
    else if (entry.isFile() && entry.name.endsWith('.java')) {
      await mkdir(path.dirname(path.join(destinationRoot, next)), { recursive: true });
      await copyFile(path.join(sourceRoot, next), path.join(destinationRoot, next));
    }
  }
}

async function copyProjectFiles(sourceRoot, destinationRoot, relative = '') {
  const directory = path.join(sourceRoot, relative);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const next = path.join(relative, entry.name);
    if (entry.isDirectory()) await copyProjectFiles(sourceRoot, destinationRoot, next);
    else if (entry.isFile()) await linkOrCopy(path.join(sourceRoot, next), path.join(destinationRoot, next));
  }
}

async function copySigningInputs(fixtureRoot) {
  const lock = JSON.parse(await readFile('patches/slim-v1/toolchain-lock.json', 'utf8'));
  for (const relative of [
    'patches/slim-v1/toolchain-lock.json',
    'patches/slim-v1/patch-spec.json',
    'patches/slim-v1/package-identity-spec.json',
    'patches/slim-v1/teaching-dependencies.json',
    'scripts/patch.mjs',
    'scripts/version.mjs',
    'scripts/signing-input.ps1',
    'scripts/test.ps1',
    'tests/teaching-preservation.test.mjs',
    'tests/smali-helpers.mjs',
    lock.baseline.path,
    lock.apktool.path,
    lock.apktool.framework.path,
  ]) {
    const target = path.join(fixtureRoot, relative);
    if (/^(patches|scripts|tests)\//.test(relative)) {
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(path.resolve(relative), target);
    } else await linkOrCopy(path.resolve(relative), target);
  }
  await copyProjectFiles(path.resolve(lock.androidBuildTools.installPath), path.join(fixtureRoot, lock.androidBuildTools.installPath));
  await copyRuntimeSources(path.resolve('runtime/src'), path.join(fixtureRoot, 'runtime/src'));
}

function testSigningInputStub() {
  return [
    "function Read-ReleasePassword {param([int]$MinimumLength=0);$global:PromptCount++;Add-Content -LiteralPath $global:InputTrace -Value 'prompt';if($global:PasswordMode -eq 'cancel'){throw 'Secure password input cancelled'};$plain=if($global:PasswordMode -eq 'wrong'){$global:WrongPassword}else{$global:TestPassword};try{if($plain.Length -lt $MinimumLength){throw 'short test password'};return ConvertTo-SecureString -String $plain -AsPlainText -Force}finally{$plain=$null}}",
  ].join('\r\n');
}

function buildMockScript(buildToolsPath) {
  const inputHelpers = signing.slice(signing.indexOf('function Get-FileSha256'), signing.indexOf('function Assert-PreSignSnapshotCurrent')).trim();
  const lines = [
    "[CmdletBinding()]",
    "param([ValidateSet('Unsigned','ReleaseSigned','PreSignCheck')][string]$Mode='ReleaseSigned',[string]$ApplicationId='io.github.wakeupnoads',[int]$VersionCode=542,[int]$Revision=1,[string]$JavaHome,[string]$NodePath,[switch]$PrepareOnly)",
    "$ErrorActionPreference='Stop'",
    "$Root=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path",
    "$ToolchainLockPath=Join-Path $Root 'patches/slim-v1/toolchain-lock.json'",
    "$ToolchainLock=Get-Content -LiteralPath $ToolchainLockPath -Raw | ConvertFrom-Json",
    "$BuildToolsRoot=Join-Path $Root $ToolchainLock.androidBuildTools.installPath",
    "$ResolvedJavaHome=[IO.Path]::GetFullPath($JavaHome)",
    inputHelpers,
    "$trace=Join-Path $Root 'trace.txt'",
    "$tools='" + buildToolsPath.replaceAll("'", "''") + "'",
    "if($PrepareOnly){Add-Content -LiteralPath $trace -Value 'prepare';if($env:SLIM_TEST_FAIL_STAGE -eq 'prepare'){throw 'mock preflight failure'};return}",
    "if($Mode -eq 'PreSignCheck'){",
    "  Add-Content -LiteralPath $trace -Value ('pre-sign:'+$VersionCode)",
    "  if($env:SLIM_TEST_FAIL_STAGE -eq 'presign'){throw 'mock pre-sign failure'}",
    "  $releaseName='wakeup-noads-v6.5.2-r1';$sourceApk=Join-Path $Root ('test-apks/versionCode-'+$VersionCode+'.apk')",
    "  $stage=Join-Path $Root ('tools/_cache/slim-v1-build/pre-sign/versionCode-'+$VersionCode+'/mock-run');New-Item -ItemType Directory -Path $stage -Force | Out-Null",
    "  $apk=Join-Path $stage ($releaseName+'.apk');Copy-Item -LiteralPath $sourceApk -Destination $apk -Force;$decoded=Join-Path $stage 'roundtrip-decoded';New-Item -ItemType Directory -Path $decoded -Force | Out-Null;$patchResult=Join-Path $stage 'patch-result.json';Set-Content -LiteralPath $patchResult -Value '{\"mock\":true}' -Encoding utf8",
    "  $snap=Get-CurrentBuildInputHashes $ResolvedJavaHome $BuildToolsRoot;$hash=(Get-FileHash -LiteralPath $apk -Algorithm SHA256).Hash.ToUpperInvariant();$deps=Get-Content -LiteralPath (Join-Path $Root 'patches/slim-v1/teaching-dependencies.json') -Raw | ConvertFrom-Json",
    "  $auditPath=Join-Path $stage 'teaching-preservation-result.json';$metadataPath=Join-Path $stage 'pre-sign-metadata.json';$audit=[ordered]@{schemaVersion=3;stage='pre-sign';success=$true;normalizationVersion=2;candidatePurpose='pre-sign';candidateRoot=[IO.Path]::GetFullPath($decoded);candidateApkPath=[IO.Path]::GetFullPath($apk);candidateMetadataPath=[IO.Path]::GetFullPath($metadataPath);candidateApkSha256=$hash;buildInputSha256=$snap.buildInputSha256;methodInventorySha256=$deps.methodInventorySha256;unexplainedDifferences=@();unexplainedEdges=@()};$audit | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $auditPath -Encoding utf8",
    "  $metadata=[ordered]@{schemaVersion=3;stage='pre-sign';success=$true;candidatePurpose='pre-sign';signed=$false;deliverable=$false;normalizationVersion=2;baselineSha256=$ToolchainLock.baseline.sha256;baselineVersion=$ToolchainLock.baseline.versionName;releaseName=$releaseName;filename=($releaseName+'.apk');versionName=$releaseName;packageName='io.github.wakeupnoads';versionCode=$VersionCode;apkPath=[IO.Path]::GetFullPath($apk);decodedRoot=[IO.Path]::GetFullPath($decoded);apkSha256=$hash;auditPath=[IO.Path]::GetFullPath($auditPath);preservationAuditSha256=(Get-FileSha256 $auditPath);patchResultPath=[IO.Path]::GetFullPath($patchResult);patchResultSha256=(Get-FileSha256 $patchResult);patchSpecSha256=(Get-FileSha256 (Join-Path $Root 'patches/slim-v1/patch-spec.json'));identitySpecSha256=(Get-FileSha256 (Join-Path $Root 'patches/slim-v1/package-identity-spec.json'));dependencyManifestSha256=(Get-FileSha256 (Join-Path $Root 'patches/slim-v1/teaching-dependencies.json'));toolchainLockSha256=(Get-FileSha256 $ToolchainLockPath);methodInventorySha256=$deps.methodInventorySha256;buildInputSha256=$snap.buildInputSha256;runtimeSourceSha256=$snap.runtimeSourceSha256;inputHashes=$snap.inputHashes;toolPaths=[ordered]@{javaHome=$ResolvedJavaHome;buildToolsRoot=[IO.Path]::GetFullPath($BuildToolsRoot)}}",
    "  $metadata | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $metadataPath -Encoding utf8;if($env:SLIM_TEST_FAIL_STAGE -eq 'input-change'){Add-Content -LiteralPath (Join-Path $Root 'scripts/signing-input.ps1') -Value '# isolated source mutation'};Write-Output ('Pre-sign metadata: '+$metadataPath);return",
    "}",
    "Add-Content -LiteralPath $trace -Value ('build:'+$VersionCode)",
    "if($env:SLIM_TEST_FAIL_STAGE -eq 'build'){throw 'mock build failure'}",
    "$releaseName='wakeup-noads-v6.5.2-r1'",
    "$sourceApk=Join-Path $Root ('test-apks/versionCode-'+$VersionCode+'.apk')",
    "if(-not(Test-Path -LiteralPath $sourceApk -PathType Leaf)){throw 'mock APK fixture is missing'}",
    "$signingRoot=Join-Path $Root 'tools/_signing/wakeup-noads'",
    "$outputDir=Join-Path $Root ('tools/_cache/slim-v1-build/output/versionCode-'+$VersionCode)",
    "$candidateRoot=Join-Path $Root ('tools/_cache/slim-v1-build/candidates/versionCode-'+$VersionCode)",
    "New-Item -ItemType Directory -Path $outputDir,$candidateRoot -Force | Out-Null",
    "$apk=Join-Path $outputDir ($releaseName+'.apk')",
    "$apksigner=@('--enable-native-access=ALL-UNNAMED','-jar',(Join-Path $tools 'lib/apksigner.jar'));$java=Join-Path $ResolvedJavaHome 'bin/java.exe'",
    "$aapt=Join-Path $tools 'aapt.exe'",
    "& $java @apksigner sign --ks (Join-Path $signingRoot 'release.p12') --ks-key-alias 'wakeup-noads' --ks-pass 'env:SLIM_V1_KEYSTORE_PASSWORD' --key-pass 'env:SLIM_V1_KEYSTORE_PASSWORD' --out $apk $sourceApk",
    "if($LASTEXITCODE -ne 0){throw 'mock apksigner failed'}",
    "$verify=& $java @apksigner verify --verbose --print-certs $apk 2>&1",
    "if($LASTEXITCODE -ne 0){throw 'mock APK verify failed'}",
    "$certLine=$verify | Where-Object {$_ -match 'Signer #1 certificate SHA-256 digest:'} | Select-Object -First 1",
    "if(-not $certLine){throw 'mock signer fingerprint missing'}",
    "$certificate=(($certLine -split ':',2)[1].Trim().Replace(':','').ToUpperInvariant())",
    "$badging=& $aapt dump badging $apk 2>&1",
    "if($LASTEXITCODE -ne 0){throw 'mock aapt failed'}",
    "$packageLine=$badging | Where-Object {$_ -match \"^package: name='\"} | Select-Object -First 1",
    "$packageMatch=[regex]::Match($packageLine,\"name='(?<package>[^']+)'\\s+versionCode='(?<code>\\d+)'\\s+versionName='(?<name>[^']*)'\");if(-not $packageMatch.Success){throw 'mock package metadata missing'};$packageMeta=[ordered]@{package=$packageMatch.Groups['package'].Value;code=[int]$packageMatch.Groups['code'].Value;name=$packageMatch.Groups['name'].Value}",
    "$hash=(Get-FileHash -LiteralPath $apk -Algorithm SHA256).Hash.ToUpperInvariant()",
    "$relative=[IO.Path]::GetRelativePath($Root,$apk)",
    "$snap=Get-CurrentBuildInputHashes $ResolvedJavaHome $BuildToolsRoot;$deps=Get-Content -LiteralPath (Join-Path $Root 'patches/slim-v1/teaching-dependencies.json') -Raw | ConvertFrom-Json",
    "$candidateApk=Join-Path $candidateRoot ($releaseName+'.apk');Copy-Item -LiteralPath $apk -Destination $candidateApk -Force",
    "$stage=Join-Path $Root ('tools/_cache/slim-v1-build/staging/versionCode-'+$VersionCode+'/mock-run');$stageDecoded=Join-Path $stage 'roundtrip-decoded';New-Item -ItemType Directory -Path $stageDecoded -Force | Out-Null;$stageApk=Join-Path $stage ($releaseName+'.apk');Copy-Item -LiteralPath $apk -Destination $stageApk -Force",
    "$auditPath=Join-Path $candidateRoot 'teaching-preservation-result.json';$patchResult=Join-Path $candidateRoot 'patch-result.json';Set-Content -LiteralPath $patchResult -Value '{\"mock\":true}' -Encoding utf8",
    "$payload=[ordered]@{};Add-Type -AssemblyName System.IO.Compression.FileSystem;$zip=[IO.Compression.ZipFile]::OpenRead($apk);try{foreach($entry in @($zip.Entries|Where-Object{$_.FullName -match '^classes(?:\\d+)?\\.dex$' -or $_.FullName -match '^lib/[^/]+/[^/]+\\.so$'}|Sort-Object FullName)){$stream=$entry.Open();$alg=[Security.Cryptography.SHA256]::Create();try{$payload[$entry.FullName]=[Convert]::ToHexString($alg.ComputeHash($stream))}finally{$alg.Dispose();$stream.Dispose()}}}finally{$zip.Dispose()}",
    "$decodedInventory='7E7BFC1BFCB31A5D315D4F5FC7DE21A59E84418F369F7E2C9F628EAE5DD4F60A'",
    "$audit=[ordered]@{schemaVersion=3;stage='signed';success=$true;normalizationVersion=2;candidatePurpose='release';candidateApkPath=[IO.Path]::GetFullPath($stageApk);candidateRoot=[IO.Path]::GetFullPath($stageDecoded);candidateApkSha256=$hash;buildInputSha256=$snap.buildInputSha256;methodInventorySha256=$deps.methodInventorySha256;protectedDecodedInventorySha256=$decodedInventory;unexplainedDifferences=@();unexplainedEdges=@()};$audit | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $auditPath -Encoding utf8",
    "$metadata=[ordered]@{schemaVersion=3;stage='signed';success=$true;candidatePurpose='release';signed=$true;deliverable=$true;normalizationVersion=2;baselineSha256=$ToolchainLock.baseline.sha256;baselineVersion=$ToolchainLock.baseline.versionName;revision=$Revision;releaseName=$releaseName;filename=($releaseName+'.apk');apkRelativePath=$relative;apkPath=[IO.Path]::GetFullPath($apk);candidateApkPath=[IO.Path]::GetFullPath($candidateApk);decodedRoot=[IO.Path]::GetFullPath($stageDecoded);versionName=$packageMeta.name;versionCode=$packageMeta.code;tagName=$releaseName;packageName=$packageMeta.package;certificateSha256=$certificate;apkSha256=$hash;patchSpecSha256=(Get-FileSha256 (Join-Path $Root 'patches/slim-v1/patch-spec.json'));identitySpecSha256=(Get-FileSha256 (Join-Path $Root 'patches/slim-v1/package-identity-spec.json'));dependencyManifestSha256=(Get-FileSha256 (Join-Path $Root 'patches/slim-v1/teaching-dependencies.json'));methodInventorySha256=$deps.methodInventorySha256;toolchainLockSha256=(Get-FileSha256 $ToolchainLockPath);runtimeSourceSha256=$snap.runtimeSourceSha256;buildInputSha256=$snap.buildInputSha256;inputHashes=$snap.inputHashes;toolPaths=[ordered]@{javaHome=$ResolvedJavaHome;buildToolsRoot=[IO.Path]::GetFullPath($BuildToolsRoot)};protectedPayloadHashes=$payload;preservationAuditSha256=(Get-FileSha256 $auditPath);auditPath=[IO.Path]::GetFullPath($auditPath)}",
    "$metadataPath=Join-Path $candidateRoot 'release-metadata.json';$metadata | ConvertTo-Json -Depth 16 | Set-Content -LiteralPath $metadataPath -Encoding utf8",
    "$ready=[ordered]@{schemaVersion=1;ready=$true;success=$true;stage='signed';packageName=$packageMeta.package;versionCode=$packageMeta.code;versionName=$packageMeta.name;releaseName=$releaseName;certificateSha256=$certificate;apkSha256=$hash;candidateApkPath=[IO.Path]::GetFullPath($candidateApk);outputApkPath=[IO.Path]::GetFullPath($apk);releaseMetadataPath=[IO.Path]::GetFullPath($metadataPath);releaseMetadataSha256=(Get-FileSha256 $metadataPath);auditPath=[IO.Path]::GetFullPath($auditPath);auditSha256=(Get-FileSha256 $auditPath);auditStageApkPath=[IO.Path]::GetFullPath($stageApk);auditStageDecodedRoot=[IO.Path]::GetFullPath($stageDecoded);patchResultPath=[IO.Path]::GetFullPath($patchResult);patchResultSha256=(Get-FileSha256 $patchResult);protectedDecodedInventorySha256=$decodedInventory;protectedPayloadHashes=$payload;normalizationVersion=2;methodInventorySha256=$deps.methodInventorySha256;buildInputSha256=$snap.buildInputSha256;runtimeSourceSha256=$snap.runtimeSourceSha256;baselineSha256=$ToolchainLock.baseline.sha256;patchSpecSha256=$metadata.patchSpecSha256;identitySpecSha256=$metadata.identitySpecSha256;dependencyManifestSha256=$metadata.dependencyManifestSha256;toolchainLockSha256=(Get-FileSha256 $ToolchainLockPath)};$ready | ConvertTo-Json -Depth 16 | Set-Content -LiteralPath (Join-Path $candidateRoot 'ready.json') -Encoding utf8"
  ];
  return lines.join('\r\n')
    .replace("$signingRoot=Join-Path $Root 'tools/_signing/wakeup-noads'", "$signingRoot=Join-Path $Root 'tools/_signing/wakeup-noads'\r\n$identityId=(Get-Content -LiteralPath (Join-Path $signingRoot 'signing-identity.json') -Raw | ConvertFrom-Json).identityId")
    .replaceAll('certificateSha256=$certificate;apkSha256=$hash', 'certificateSha256=$certificate;identityId=$identityId;apkSha256=$hash');
}

function signingRunnerScript() {
  const lines = [
    "param([string]$FixtureRoot,[string]$JavaHome,[string]$NodePath,[string]$BuildToolsPath,[string]$SetupMode,[string]$FailureStage,[string]$PasswordMode,[int]$VersionCode=0)",
    "$ErrorActionPreference='Stop'",
    "$global:PromptCount=0",
    "$global:TestPassword=[guid]::NewGuid().ToString('N')+'A9!'",
    "$global:WrongPassword=[guid]::NewGuid().ToString('N')+'B7!'",
    "$global:PasswordMode=$PasswordMode",
    "$trace=Join-Path $FixtureRoot 'trace.txt'",
    "$global:InputTrace=$trace",
    "$signingScript=Join-Path $FixtureRoot 'scripts/signing.ps1'",
    "$active=Join-Path $FixtureRoot 'tools/_signing/wakeup-noads'",
    "$backup=Join-Path $FixtureRoot 'tools/_signing/wakeup-noads-backup'",
    "[Environment]::SetEnvironmentVariable('SLIM_V1_KEYSTORE_PASSWORD',$null,'Process')",
    "if($FailureStage){[Environment]::SetEnvironmentVariable('SLIM_TEST_FAIL_STAGE',$FailureStage,'Process')}else{[Environment]::SetEnvironmentVariable('SLIM_TEST_FAIL_STAGE',$null,'Process')}",
    "function New-TestSecurePassword([string]$Kind){$plain=if($Kind -eq 'wrong'){$global:WrongPassword}else{$global:TestPassword};try{return ConvertTo-SecureString -String $plain -AsPlainText -Force}finally{$plain=$null}}",
    "if($SetupMode -eq 'partial'){New-Item -ItemType Directory -Path $active -Force | Out-Null}",
    "if($SetupMode -eq 'complete'){",
    "  [Environment]::SetEnvironmentVariable('SLIM_V1_KEYSTORE_PASSWORD',$global:TestPassword,'Process')",
    "  $null=& $signingScript -Action Initialize -JavaHome $JavaHome -SigningRoot $active -BackupRoot $backup -BuildToolsPath $BuildToolsPath -Silent",
    "  $null=& $signingScript -Action Backup -JavaHome $JavaHome -SigningRoot $active -BackupRoot $backup -BuildToolsPath $BuildToolsPath -Silent",
    "  [Environment]::SetEnvironmentVariable('SLIM_V1_KEYSTORE_PASSWORD',$null,'Process')",
    "}",
    "$inheritedPassword=if($PasswordMode -eq 'stale'){[guid]::NewGuid().ToString('N')}else{$null};[Environment]::SetEnvironmentVariable('SLIM_V1_KEYSTORE_PASSWORD',$inheritedPassword,'Process');$inheritedPassword=[Environment]::GetEnvironmentVariable('SLIM_V1_KEYSTORE_PASSWORD','Process')",
    "$exitCode=0;$message=''",
    "try{$null=& $signingScript -Action Release -JavaHome $JavaHome -NodePath $NodePath -Revision 1 -VersionCode $VersionCode -SigningRoot $active -BackupRoot $backup -BuildToolsPath $BuildToolsPath}catch{$exitCode=1;$message=($_ | Out-String)}",
    "$passwordStillSet=[bool][Environment]::GetEnvironmentVariable('SLIM_V1_KEYSTORE_PASSWORD','Process');$processRestored=([Environment]::GetEnvironmentVariable('SLIM_V1_KEYSTORE_PASSWORD','Process') -ceq $inheritedPassword)",
    "[Environment]::SetEnvironmentVariable('SLIM_V1_KEYSTORE_PASSWORD',$null,'Process')",
    "$traceLines=if(Test-Path -LiteralPath $trace){@(Get-Content -LiteralPath $trace)}else{@()}",
    "$leak=($message.Contains($global:TestPassword) -or $message.Contains($global:WrongPassword))",
    "foreach($file in @(Get-ChildItem -LiteralPath $FixtureRoot -Recurse -File | Where-Object {$_.Extension -in @('.json','.txt','.log')})){try{$text=Get-Content -LiteralPath $file.FullName -Raw;if($text.Contains($global:TestPassword) -or $text.Contains($global:WrongPassword)){$leak=$true}}catch{}}",
    "$summary=[ordered]@{exitCode=$exitCode;message=$message;promptCount=$global:PromptCount;passwordStillSet=$passwordStillSet;processRestored=$processRestored;secretLeak=$leak;trace=($traceLines -join ',')}",
    "$global:TestPassword=$null;$global:WrongPassword=$null;$global:PasswordMode=$null",
    "$summary | ConvertTo-Json -Depth 6 -Compress"
  ];
  return lines.join('\r\n');
}

async function createSigningFixture(t, { setupMode = 'complete', failureStage = '', passwordMode = 'normal', versionCode = 0, runRelease = true } = {}) {
  await mkdir(signingFixtureRoot, { recursive: true });
  const root = await mkdtemp(path.join(signingFixtureRoot, 'run-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await assert.rejects(readFile(path.join(root, 'scripts/signing.ps1')));
  });
  const fixtureRoot = path.join(root, 'project');
  const scriptsDir = path.join(fixtureRoot, 'scripts');
  const cacheDir = path.join(fixtureRoot, 'test-apks');
  await mkdir(scriptsDir, { recursive: true });
  await mkdir(cacheDir, { recursive: true });
  await copySigningInputs(fixtureRoot);
  await copyFile('scripts/signing.ps1', path.join(scriptsDir, 'signing.ps1'));
  await writeFile(path.join(scriptsDir, 'signing-input.ps1'), testSigningInputStub(), 'utf8');
  await writeFile(path.join(scriptsDir, 'build.ps1'), buildMockScript(path.resolve(buildToolsFixture)));
  await copyFile(path.resolve('tools/_cache/slim-v1-build/unsigned/versionCode-542/' + signedFixtureName), path.join(cacheDir, 'versionCode-542.apk'));
  const runnerPath = path.join(root, 'run-signing.ps1');
  await writeFile(runnerPath, signingRunnerScript());
  const tempDir = path.join(root, 'tools/_cache/tmp');
  await mkdir(tempDir, { recursive: true });
  const childEnv = { ...process.env, TEMP: tempDir, TMP: tempDir, ANDROID_USER_HOME: path.join(root, 'tools/_cache/android-user'), HOME: path.join(root, 'tools/_cache/home') };
  delete childEnv.SLIM_V1_KEYSTORE_PASSWORD;
  if (!runRelease) return { root, fixtureRoot, result: null, summary: null };
  const result = spawnSync('pwsh.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', runnerPath,
    fixtureRoot, javaHomeFixture, nodeFixture, path.join(fixtureRoot, 'tools/android-build-tools-35.0.0/android-15'), setupMode, failureStage, passwordMode, String(versionCode)
  ], { encoding: 'utf8', env: childEnv, timeout: 180000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const summaryLine = result.stdout.trim().split(/\r?\n/).at(-1);
  assert.ok(summaryLine, 'PowerShell runner emitted its summary');
  const summary = JSON.parse(summaryLine);
  summary.trace = summary.trace ? summary.trace.split(',') : [];
  return { root, fixtureRoot, result, summary };
}

async function readReleaseHistory(fixtureRoot, relative) {
  return JSON.parse(await readFile(path.join(fixtureRoot, relative, 'release-history.json'), 'utf8'));
}

async function fileSha256(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex').toUpperCase();
}

test('Release runs a real PowerShell key, backup, verify, signed build, history and publish flow with one secure prompt', async (t) => {
  const fixture = await createSigningFixture(t, { setupMode: 'none' });
  assert.equal(fixture.summary.exitCode, 0, fixture.summary.message + '\n' + fixture.result.stderr);
  assert.equal(fixture.summary.promptCount, 1);
  assert.equal(fixture.summary.passwordStillSet, false);
  assert.equal(fixture.summary.secretLeak, false);
  const metadata = JSON.parse(await readFile(path.join(fixture.fixtureRoot, 'tools/_cache/slim-v1-build/candidates/versionCode-542/release-metadata.json'), 'utf8'));
  const ready = JSON.parse(await readFile(path.join(fixture.fixtureRoot, 'tools/_cache/slim-v1-build/candidates/versionCode-542/ready.json'), 'utf8'));
  assert.equal(metadata.inputHashes.versionScript, await fileSha256(path.join(fixture.fixtureRoot, 'scripts/version.mjs')));
  assert.equal(ready.buildInputSha256, metadata.buildInputSha256);
  assert.deepEqual(fixture.summary.trace, ['prompt', 'prepare', 'pre-sign:542', 'build:542']);
  const active = await readReleaseHistory(fixture.fixtureRoot, 'tools/_signing/wakeup-noads');
  const backup = await readReleaseHistory(fixture.fixtureRoot, 'tools/_signing/wakeup-noads-backup');
  assert.equal(active.highestDeliveredVersionCode, 542);
  assert.deepEqual(active, backup);
  assert.deepEqual(active.releases.map((entry) => entry.versionCode), [542]);
  assert.equal(active.releases[0].releaseName, 'wakeup-noads-v6.5.2-r1');
  assert.equal('purpose' in active.releases[0], false);
  const releaseDirectory = path.join(fixture.fixtureRoot, 'tools/release');
  assert.deepEqual(await readdir(releaseDirectory), [signedFixtureName]);
  assert.equal(await fileSha256(path.join(releaseDirectory, signedFixtureName)), active.releases[0].apkSha256);
});

test('Release rejects partial signing state before prompting and performs the fast input check before preparation', async (t) => {
  const partial = await createSigningFixture(t, { setupMode: 'partial' });
  assert.equal(partial.summary.exitCode, 1);
  assert.equal(partial.summary.promptCount, 0);
  assert.deepEqual(partial.summary.trace, []);

  const preflight = await createSigningFixture(t, { failureStage: 'prepare' });
  assert.equal(preflight.summary.exitCode, 1);
  assert.equal(preflight.summary.promptCount, 1);
  assert.deepEqual(preflight.summary.trace, ['prompt', 'prepare']);
});

test('Release leaves identity, history and the release folder untouched when the pre-sign gate or signed build fails', async (t) => {
  for (const [failureStage, expectedTrace] of [
    ['presign', ['prompt', 'prepare', 'pre-sign:542']],
    ['build', ['prompt', 'prepare', 'pre-sign:542', 'build:542']],
  ]) {
    const failed = await createSigningFixture(t, { failureStage });
    assert.equal(failed.summary.exitCode, 1);
    assert.equal(failed.summary.promptCount, 1);
    assert.equal(failed.summary.passwordStillSet, false);
    assert.equal(failed.summary.secretLeak, false);
    assert.deepEqual(failed.summary.trace, expectedTrace);
    const activeHistory = await readReleaseHistory(failed.fixtureRoot, 'tools/_signing/wakeup-noads');
    const backupHistory = await readReleaseHistory(failed.fixtureRoot, 'tools/_signing/wakeup-noads-backup');
    assert.equal(activeHistory.highestDeliveredVersionCode, 0);
    assert.deepEqual(activeHistory.releases, []);
    assert.deepEqual(activeHistory, backupHistory);
    await assert.rejects(readdir(path.join(failed.fixtureRoot, 'tools/release')));
  }
});

test('Release reuses a complete identity and backup, and rejects a wrong password or versionCode before building', async (t) => {
  const reuse = await createSigningFixture(t, { setupMode: 'complete' });
  assert.equal(reuse.summary.exitCode, 0, reuse.summary.message + '\n' + reuse.result.stderr);
  assert.equal(reuse.summary.promptCount, 1);
  assert.equal(reuse.summary.secretLeak, false);
  assert.deepEqual(reuse.summary.trace, ['prompt', 'prepare', 'pre-sign:542', 'build:542']);

  const wrongPassword = await createSigningFixture(t, { setupMode: 'complete', passwordMode: 'wrong' });
  assert.equal(wrongPassword.summary.exitCode, 1);
  assert.equal(wrongPassword.summary.promptCount, 1);
  assert.equal(wrongPassword.summary.secretLeak, false);
  assert.deepEqual(wrongPassword.summary.trace, ['prompt']);
  const history = await readReleaseHistory(wrongPassword.fixtureRoot, 'tools/_signing/wakeup-noads');
  assert.equal(history.highestDeliveredVersionCode, 0);

  const wrongVersion = await createSigningFixture(t, { setupMode: 'complete', versionCode: 543 });
  assert.equal(wrongVersion.summary.exitCode, 1);
  assert.match(wrongVersion.summary.message, /VersionCode must be 542/);
  assert.equal(wrongVersion.summary.promptCount, 0);
  assert.deepEqual(wrongVersion.summary.trace, []);
});

test('Release rejects changed input source after the pre-sign gate and restores inherited process state on success or cancellation', async (t) => {
  const changed = await createSigningFixture(t, { failureStage: 'input-change' });
  assert.equal(changed.summary.exitCode, 1);
  assert.match(changed.summary.message, /inputs changed after PreSignCheck/);
  assert.deepEqual(changed.summary.trace, ['prompt', 'prepare', 'pre-sign:542']);
  assert.equal(changed.summary.processRestored, true);
  assert.equal((await readReleaseHistory(changed.fixtureRoot, 'tools/_signing/wakeup-noads')).highestDeliveredVersionCode, 0);
  const stale = await createSigningFixture(t, { passwordMode: 'stale' });
  assert.equal(stale.summary.exitCode, 0, stale.summary.message);
  assert.equal(stale.summary.promptCount, 1);
  assert.equal(stale.summary.processRestored, true);
  assert.equal(stale.summary.secretLeak, false);
  const cancelled = await createSigningFixture(t, { passwordMode: 'cancel' });
  assert.equal(cancelled.summary.exitCode, 1);
  assert.deepEqual(cancelled.summary.trace, ['prompt']);
  assert.equal(cancelled.summary.processRestored, true);
});

test('current input binding rejects mutation of every source input, including the shared reader', async (t) => {
  const fixture = await createSigningFixture(t, { runRelease: false });
  const runner = path.join(fixture.root, 'input-binding.ps1');
  await writeFile(runner, String.raw`
param([string]$FixtureRoot,[string]$JavaHome,[string]$BuildToolsPath)
$ErrorActionPreference='Stop'
. (Join-Path $FixtureRoot 'scripts/signing.ps1') -Action VerifyIdentity -JavaHome $JavaHome -BuildToolsPath $BuildToolsPath -Silent
$snapshot=Get-CurrentBuildInputHashes $JavaHome $BuildToolsPath
$metadata=@{toolPaths=@{javaHome=$JavaHome;buildToolsRoot=$BuildToolsPath};inputHashes=$snapshot.inputHashes;buildInputSha256=$snapshot.buildInputSha256;runtimeSourceSha256=$snapshot.runtimeSourceSha256}
$paths=@('patches/slim-v1/patch-spec.json','patches/slim-v1/package-identity-spec.json','patches/slim-v1/teaching-dependencies.json','patches/slim-v1/toolchain-lock.json','scripts/patch.mjs','scripts/version.mjs','scripts/build.ps1','scripts/test.ps1','scripts/signing.ps1','scripts/signing-input.ps1','tests/teaching-preservation.test.mjs','tests/smali-helpers.mjs')
$paths+=@([IO.Path]::GetRelativePath($FixtureRoot,(Get-ChildItem -LiteralPath (Join-Path $FixtureRoot 'runtime/src') -Recurse -Filter '*.java' -File | Select-Object -First 1).FullName))
$rejected=0
foreach($relative in $paths){
 $file=Join-Path $FixtureRoot $relative;$bytes=[IO.File]::ReadAllBytes($file)
 try{[IO.File]::WriteAllBytes($file,($bytes+[byte[]]@(32)));$failed=$false;try{Assert-PreSignSnapshotCurrent $metadata $JavaHome $BuildToolsPath}catch{if($_.Exception.Message -notmatch 'inputs changed after PreSignCheck'){throw};$failed=$true};if(-not $failed){throw "mutated source was accepted: $relative"};$rejected++}
 finally{[IO.File]::WriteAllBytes($file,$bytes)}
}
Assert-PreSignSnapshotCurrent $metadata $JavaHome $BuildToolsPath
@{rejected=$rejected;restored=$true}|ConvertTo-Json -Compress
`, 'utf8');
  const result = spawnSync('pwsh.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', runner, fixture.fixtureRoot, javaHomeFixture,
    path.join(fixture.fixtureRoot, 'tools/android-build-tools-35.0.0/android-15')], { encoding: 'utf8', timeout: 60000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)), { rejected: 13, restored: true });
});

function directBuildRunnerScript() {
  return String.raw`
param([string]$FixtureRoot,[string]$JavaHome,[string]$NodePath,[string]$Mode)
$ErrorActionPreference='Stop'
$global:TestPassword=[guid]::NewGuid().ToString('N');$global:WrongPassword=[guid]::NewGuid().ToString('N');$global:PasswordMode=if($Mode -eq 'wrong'){'wrong'}elseif($Mode -eq 'cancel'){'cancel'}else{'normal'};$global:PromptCount=0
$global:InputTrace=Join-Path $FixtureRoot 'trace.txt'
$signing=Join-Path $FixtureRoot 'scripts/signing.ps1';$active=Join-Path $FixtureRoot 'tools/_signing/wakeup-noads';$backup=Join-Path $FixtureRoot 'tools/_signing/wakeup-noads-backup'
[Environment]::SetEnvironmentVariable('SLIM_V1_KEYSTORE_PASSWORD',$global:TestPassword,'Process')
$null=& $signing -Action Initialize -JavaHome $JavaHome -Silent
$null=& $signing -Action Backup -JavaHome $JavaHome -Silent
$oldBytes=@{};foreach($directory in @($active,$backup)){foreach($name in @('release.p12','signing-identity.json','release-history.json')){$p=Join-Path $directory $name;$oldBytes[$p]=(Get-FileHash -LiteralPath $p).Hash}}
$wrapper=Join-Path $FixtureRoot 'tools/_cache/keytool-input-test.ps1'
$wrapperSource=@'
$ErrorActionPreference='Stop';$arguments=@($args);$command=$arguments[0];Add-Content -LiteralPath $env:SLIM_TEST_KEY_TRACE -Value $command
if($command -eq '-certreq' -and $env:SLIM_TEST_PROBE_FAIL -eq '1'){exit 37}
& $env:SLIM_TEST_REAL_KEYTOOL @arguments
exit $LASTEXITCODE
'@
$wrapperSource | Set-Content -LiteralPath $wrapper -Encoding utf8
$source=Get-Content -LiteralPath $signing -Raw
if($Mode -eq 'internal'){$source=$source.Replace('function Get-CertificateDigest([string]$Keystore, [string]$Alias) {','function Get-CertificateDigest([string]$Keystore, [string]$Alias) { Add-Content -LiteralPath $global:InputTrace -Value ''-list''').Replace('function Assert-PrivateKeyAccess([string]$Directory, [string]$Alias = ''wakeup-noads'') {','function Assert-PrivateKeyAccess([string]$Directory, [string]$Alias = ''wakeup-noads'') { Add-Content -LiteralPath $global:InputTrace -Value ''-certreq''')}
else{$source=$source.Replace('function Get-ToolPath([string]$Name) {','function Get-ToolPath([string]$Name) { if($Name -eq ''keytool'' -and $env:SLIM_TEST_KEY_WRAPPER){return $env:SLIM_TEST_KEY_WRAPPER}')}
$source | Set-Content -LiteralPath $signing -Encoding utf8
$env:SLIM_TEST_KEY_WRAPPER=$wrapper;$env:SLIM_TEST_REAL_KEYTOOL=Join-Path $JavaHome 'bin/keytool.exe';$env:SLIM_TEST_KEY_TRACE=$global:InputTrace
if($Mode -eq 'probe'){$env:SLIM_TEST_PROBE_FAIL='1'}
if($Mode -eq 'missing'){$history=Get-Content -LiteralPath (Join-Path $active 'release-history.json') -Raw|ConvertFrom-Json;$history.highestDeliveredVersionCode=542;foreach($directory in @($active,$backup)){$history|ConvertTo-Json -Depth 6|Set-Content -LiteralPath (Join-Path $directory 'release-history.json') -Encoding utf8}}
$previous=[guid]::NewGuid().ToString('N');[Environment]::SetEnvironmentVariable('SLIM_V1_KEYSTORE_PASSWORD',$previous,'Process')
$message='';$failed=$false
try{
 if($Mode -eq 'internal'){
  $null=& $signing -Action Release -JavaHome $JavaHome -NodePath $NodePath
 }else{$null=& (Join-Path $FixtureRoot 'scripts/build.ps1') -Mode ReleaseSigned -VersionCode 542 -Revision 1 -JavaHome $JavaHome -NodePath $NodePath}
}catch{$failed=$true;$message=$_.Exception.Message}
$restored=[Environment]::GetEnvironmentVariable('SLIM_V1_KEYSTORE_PASSWORD','Process') -ceq $previous
$unchanged=$true;if($Mode -ne 'missing'){foreach($file in $oldBytes.Keys){if((Get-FileHash -LiteralPath $file).Hash -ne $oldBytes[$file]){$unchanged=$false}}}
$trace=if(Test-Path -LiteralPath $global:InputTrace){@(Get-Content -LiteralPath $global:InputTrace)}else{@()}
$leak=$message.Contains($global:TestPassword) -or $message.Contains($global:WrongPassword) -or $message.Contains($previous)
foreach($file in @(Get-ChildItem -LiteralPath $FixtureRoot -Recurse -File|Where-Object{$_.Extension -in @('.json','.txt','.log')})){$text=Get-Content -LiteralPath $file.FullName -Raw;if($text.Contains($global:TestPassword) -or $text.Contains($global:WrongPassword) -or $text.Contains($previous)){$leak=$true}}
@{failed=$failed;message=$message;restored=$restored;unchanged=$unchanged;trace=@($trace);prompts=$global:PromptCount;secretLeak=$leak}|ConvertTo-Json -Depth 6 -Compress
[Environment]::SetEnvironmentVariable('SLIM_V1_KEYSTORE_PASSWORD',$null,'Process');$global:TestPassword=$null;$global:WrongPassword=$null;$previous=$null
`;
}

for (const mode of ['correct', 'wrong', 'probe', 'cancel', 'missing', 'internal']) {
  test(`direct ReleaseSigned verifies a real identity before long work: ${mode}`, async (t) => {
    const fixture = await createSigningFixture(t, { runRelease: false });
    const realBuildPath = path.join(fixture.fixtureRoot, 'scripts', mode === 'internal' ? 'build-real.ps1' : 'build.ps1');
    await writeFile(realBuildPath, build.replace('function Ensure-AndroidBuildTools {',
      "function Ensure-AndroidBuildTools { Add-Content -LiteralPath (Join-Path $Root 'trace.txt') -Value 'long-boundary';throw 'intentional test stop before long build'"));
    if (mode === 'internal') {
      await writeFile(path.join(fixture.fixtureRoot, 'scripts/build.ps1'), buildMockScript(path.resolve(buildToolsFixture))
        .replace("Add-Content -LiteralPath $trace -Value ('build:'+$VersionCode)",
          "& (Join-Path $PSScriptRoot 'build-real.ps1') -Mode ReleaseSigned -ApplicationId $ApplicationId -VersionCode $VersionCode -Revision $Revision -JavaHome $JavaHome -NodePath $NodePath;return"));
    }
    const runner = path.join(fixture.root, 'direct-build-runner.ps1');
    await writeFile(runner, directBuildRunnerScript(), 'utf8');
    const temp = path.join(fixture.root, 'tools/_cache/tmp');
    await mkdir(temp, { recursive: true });
    const result = spawnSync('pwsh.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', runner, fixture.fixtureRoot, javaHomeFixture, nodeFixture, mode],
      { encoding: 'utf8', timeout: 60000, env: { ...process.env, TEMP: temp, TMP: temp, HOME: temp, ANDROID_USER_HOME: temp } });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const summary = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
    assert.equal(summary.failed, true);
    assert.equal(summary.restored, true);
    assert.equal(summary.unchanged, true);
    assert.equal(summary.secretLeak, false);
    assert.equal(summary.prompts, mode === 'missing' ? 0 : 1);
    if (mode === 'correct' || mode === 'internal') {
      assert.match(summary.message, /intentional test stop/);
      assert.equal(summary.trace.at(-1), 'long-boundary');
      assert.ok(summary.trace.filter((command) => command === '-list').length >= 2);
      assert.ok(summary.trace.filter((command) => command === '-certreq').length >= 2);
    } else {
      assert.ok(!summary.trace.includes('long-boundary'));
      if (mode === 'probe') {
        assert.equal(summary.trace.filter((command) => command === '-list').length, 2);
        assert.equal(summary.trace.filter((command) => command === '-certreq').length, 1);
        assert.match(summary.message, /Private-key access probe failed/);
      }
    }
  });
}

test('actual ready writer round-trips through the real reader and rejects missing, stale, or wrong identity evidence', async (t) => {
  const fixture = await createSigningFixture(t);
  assert.equal(fixture.summary.exitCode, 0, fixture.summary.message);
  const start = build.indexOf('$ready = [ordered]@{');
  const end = build.indexOf('    Write-AtomicJson $readyPath $ready', start);
  assert.ok(start >= 0 && end > start);
  const writerPath = path.join(fixture.root, 'ready-writer.ps1');
  await writeFile(writerPath, build.slice(start, end), 'utf8');
  const runnerPath = path.join(fixture.root, 'ready-reader.ps1');
  await writeFile(runnerPath, String.raw`
param([string]$FixtureRoot,[string]$JavaHome,[string]$BuildToolsPath,[string]$WriterPath)
$ErrorActionPreference='Stop'
. (Join-Path $FixtureRoot 'scripts/signing.ps1') -Action RecordRelease -JavaHome $JavaHome -BuildToolsPath $BuildToolsPath -Silent
function Get-Sha256([string]$Path){Get-FileSha256 $Path}
$candidateRoot=Join-Path $FixtureRoot 'tools/_cache/slim-v1-build/candidates/versionCode-542';$candidateMetadataPath=Join-Path $candidateRoot 'release-metadata.json';$readyPath=Join-Path $candidateRoot 'ready.json'
$originalMetadata=[IO.File]::ReadAllBytes($candidateMetadataPath);$metadata=Get-Content -LiteralPath $candidateMetadataPath -Raw|ConvertFrom-Json
$Root=$FixtureRoot;$candidateOutput=$metadata.apkPath;$candidateApkPath=$metadata.candidateApkPath;$signedHash=$metadata.apkSha256;$certificateSha256=$metadata.certificateSha256;$releaseName=$metadata.releaseName
$actualApk=Get-ApkIdentity $candidateOutput;$finalAuditPath=$metadata.auditPath;$originalAudit=[IO.File]::ReadAllBytes($finalAuditPath);$audit=Get-Content -LiteralPath $finalAuditPath -Raw|ConvertFrom-Json
$signedStage=@{metadata=$metadata;audit=$audit;apkPath=$audit.candidateApkPath;decodedRoot=$audit.candidateRoot};$signedPayloadHashes=Get-ApkProtectedPayloadHashes $candidateOutput
$Lock=$ToolchainLock;$LockPath=$ToolchainLockPath;$patchSpecSha256=$metadata.patchSpecSha256;$dependencyManifestSha256=$metadata.dependencyManifestSha256;$methodInventorySha256=$metadata.methodInventorySha256
$dependencyManifest=Get-Content -LiteralPath (Join-Path $Root 'patches/slim-v1/teaching-dependencies.json') -Raw|ConvertFrom-Json
$identity=Read-Identity $SigningRoot
$writer=Get-Content -LiteralPath $WriterPath -Raw
& ([scriptblock]::Create($writer+'; Write-AtomicJson $readyPath $ready'))
$originalReady=[IO.File]::ReadAllBytes($readyPath)
$null=Assert-ReadyPreservationEvidence $candidateOutput $candidateMetadataPath $readyPath $identity
$rejected=0
try{
 foreach($mode in @('missing-payload','empty-payload','changed-payload','missing-identity','old-certificate','old-metadata-identity','failed-audit','unknown-edge','stale-normalizer','pre-sign','not-ready','wrong-stage-path','wrong-apk-hash')){
  [IO.File]::WriteAllBytes($candidateMetadataPath,$originalMetadata);[IO.File]::WriteAllBytes($finalAuditPath,$originalAudit)
  $ready=Get-Content -LiteralPath $readyPath -Raw|ConvertFrom-Json -AsHashtable
  $ready=([Text.Encoding]::UTF8.GetString($originalReady)|ConvertFrom-Json -AsHashtable)
  switch($mode){
   'missing-payload' {$null=$ready.Remove('protectedPayloadHashes')}
   'empty-payload' {$ready.protectedPayloadHashes=@{}}
   'changed-payload' {$name=@($ready.protectedPayloadHashes.Keys)[0];$ready.protectedPayloadHashes[$name]='0'*64}
   'missing-identity' {$null=$ready.Remove('identityId')}
   'old-certificate' {$ready.certificateSha256='D1A5FAC9BAEA42CFE443B7CAACC65B7B41240F419DF05B1CA669376910626897'}
   'old-metadata-identity' {$m=[Text.Encoding]::UTF8.GetString($originalMetadata)|ConvertFrom-Json -AsHashtable;$m.identityId='D1A5FAC9BAEA42CFE443B7CAACC65B7B41240F419DF05B1CA669376910626897';Write-AtomicJson $candidateMetadataPath $m;$ready.releaseMetadataSha256=Get-FileSha256 $candidateMetadataPath}
   'failed-audit' {$a=[Text.Encoding]::UTF8.GetString($originalAudit)|ConvertFrom-Json -AsHashtable;$a.success=$false;Write-AtomicJson $finalAuditPath $a}
   'unknown-edge' {$a=[Text.Encoding]::UTF8.GetString($originalAudit)|ConvertFrom-Json -AsHashtable;$a.unexplainedEdges=@('fixture unknown edge');Write-AtomicJson $finalAuditPath $a}
   'stale-normalizer' {$ready.normalizationVersion=1}
   'pre-sign' {$ready.stage='pre-sign'}
   'not-ready' {$ready.ready=$false}
   'wrong-stage-path' {$ready.auditStageApkPath=$candidateApkPath}
   'wrong-apk-hash' {$ready.apkSha256='0'*64}
  }
  if($mode -in @('failed-audit','unknown-edge')){$ready.auditSha256=Get-FileSha256 $finalAuditPath;$m=[Text.Encoding]::UTF8.GetString($originalMetadata)|ConvertFrom-Json -AsHashtable;$m.preservationAuditSha256=$ready.auditSha256;Write-AtomicJson $candidateMetadataPath $m;$ready.releaseMetadataSha256=Get-FileSha256 $candidateMetadataPath}
  Write-AtomicJson $readyPath $ready
  $failed=$false;try{$null=Assert-ReadyPreservationEvidence $candidateOutput $candidateMetadataPath $readyPath $identity}catch{$failed=$true}
  if(-not $failed){throw "reader accepted negative evidence: $mode"};$rejected++
 }
}finally{[IO.File]::WriteAllBytes($candidateMetadataPath,$originalMetadata);[IO.File]::WriteAllBytes($finalAuditPath,$originalAudit);[IO.File]::WriteAllBytes($readyPath,$originalReady)}
$null=Assert-ReadyPreservationEvidence $candidateOutput $candidateMetadataPath $readyPath $identity
@{writerFields=$ready.Count;negativeCount=$rejected;payloadEntries=$signedPayloadHashes.Count;identityId=$identity.identityId}|ConvertTo-Json -Compress
`, 'utf8');
  const result = spawnSync('pwsh.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', runnerPath, fixture.fixtureRoot, javaHomeFixture,
    path.join(fixture.fixtureRoot, 'tools/android-build-tools-35.0.0/android-15'), writerPath], { encoding: 'utf8', timeout: 90000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const summary = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
  assert.equal(summary.negativeCount, 13);
  assert.ok(summary.payloadEntries > 0);
  assert.match(summary.identityId, /^[A-F0-9]{64}$/);
});
