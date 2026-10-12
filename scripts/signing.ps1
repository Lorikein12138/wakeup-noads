[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Initialize', 'VerifyIdentity', 'Backup', 'RecordRelease', 'Release')]
    [string]$Action,
    [string]$JavaHome,
    [string]$ApkPath,
    [string]$MetadataPath,
    [string]$PreservationEvidencePath,
    [string]$SigningRoot,
    [string]$BackupRoot,
    [string]$BuildToolsPath,
    [string]$NodePath,
    [ValidateRange(1, 2100000000)]
    [int]$Revision = 1,
    [ValidateRange(0, 2099999999)]
    [int]$VersionCode = 0,
    [switch]$Silent
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $SigningRoot) { $SigningRoot = Join-Path $ProjectRoot 'tools/_signing/wakeup-noads' }
if (-not $BackupRoot) { $BackupRoot = Join-Path $ProjectRoot 'tools/_signing/wakeup-noads-backup' }
if (-not $BuildToolsPath) { $BuildToolsPath = Join-Path $ProjectRoot 'tools/android-build-tools-35.0.0/android-15' }
$SigningRoot = [IO.Path]::GetFullPath($SigningRoot)
$BackupRoot = [IO.Path]::GetFullPath($BackupRoot)
$ToolchainLockPath = Join-Path $ProjectRoot 'patches/slim-v1/toolchain-lock.json'
$ToolchainLock = Get-Content -LiteralPath $ToolchainLockPath -Raw | ConvertFrom-Json
$KeystorePath = Join-Path $SigningRoot 'release.p12'
$IdentityPath = Join-Path $SigningRoot 'signing-identity.json'
$HistoryPath = Join-Path $SigningRoot 'release-history.json'
$PasswordVariable = 'SLIM_V1_KEYSTORE_PASSWORD'
$PreviousPassword = [Environment]::GetEnvironmentVariable($PasswordVariable, 'Process')
$CreatedPassword = $false
$PasswordPointer = [IntPtr]::Zero
$Password = $null
$SecurePassword = $null
$SigningScriptPath = $PSCommandPath
. (Join-Path $PSScriptRoot 'signing-input.ps1')

function Get-ToolPath([string]$Name) {
    if (-not $JavaHome) {
        $javaCommand = Get-Command java.exe -ErrorAction SilentlyContinue
        if (-not $javaCommand) { throw 'A JDK is required. Pass -JavaHome with a JDK directory.' }
        $resolvedJavaHome = Split-Path -Parent (Split-Path -Parent $javaCommand.Source)
    } else {
        $resolvedJavaHome = [IO.Path]::GetFullPath($JavaHome)
    }
    $toolPath = Join-Path $resolvedJavaHome "bin/$Name.exe"
    if (-not (Test-Path -LiteralPath $toolPath -PathType Leaf)) { throw "JDK tool is missing: $toolPath" }
    return $toolPath
}

function Convert-SecureString([Security.SecureString]$Value) {
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}

function Assert-ReleaseLocalInputs {
    $required = @('scripts/build.ps1', 'scripts/patch.mjs', 'scripts/test.ps1', 'scripts/signing-input.ps1',
        'tests/teaching-preservation.test.mjs', 'tests/smali-helpers.mjs', 'patches/slim-v1/patch-spec.json',
        'patches/slim-v1/package-identity-spec.json', 'patches/slim-v1/teaching-dependencies.json',
        $ToolchainLock.baseline.path, $ToolchainLock.apktool.path, $ToolchainLock.apktool.framework.path)
    foreach ($relative in $required) {
        if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot $relative) -PathType Leaf)) { throw "Required local release input is missing: $relative" }
    }
    if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot 'runtime/src') -PathType Container)) { throw 'Required runtime source directory is missing' }
    foreach ($name in @('java', 'javac', 'keytool', 'jar')) { $null = Get-ToolPath $name }
}

function Get-FileSha256([string]$Path) {
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToUpperInvariant()
}

function Get-TextSha256([string]$Value) {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return [Convert]::ToHexString($algorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value))) }
    finally { $algorithm.Dispose() }
}

function Get-CurrentBuildInputHashes([string]$ResolvedJavaHome, [string]$ResolvedBuildToolsRoot) {
    $runtimeRoot = Join-Path $ProjectRoot 'runtime/src'
    $runtimeFiles = @(Get-ChildItem -LiteralPath $runtimeRoot -Recurse -Filter '*.java' -File)
    $runtimeRows = @()
    foreach ($file in $runtimeFiles) {
        $relative = [IO.Path]::GetRelativePath($ProjectRoot, $file.FullName).Replace('\', '/')
        $runtimeRows += "$relative=$((Get-FileSha256 $file.FullName))"
    }
    [Array]::Sort($runtimeRows, [StringComparer]::Ordinal)
    $runtimeSourceTree = Get-TextSha256 (($runtimeRows -join "`n") + "`n")
    $values = @{
        baselineApk = Get-FileSha256 (Join-Path $ProjectRoot $ToolchainLock.baseline.path)
        patchSpec = Get-FileSha256 (Join-Path $ProjectRoot 'patches/slim-v1/patch-spec.json')
        packageIdentitySpec = Get-FileSha256 (Join-Path $ProjectRoot 'patches/slim-v1/package-identity-spec.json')
        dependencyManifest = Get-FileSha256 (Join-Path $ProjectRoot 'patches/slim-v1/teaching-dependencies.json')
        toolchainLock = Get-FileSha256 $ToolchainLockPath
        patchEngine = Get-FileSha256 (Join-Path $ProjectRoot 'scripts/patch.mjs')
        buildScript = Get-FileSha256 (Join-Path $ProjectRoot 'scripts/build.ps1')
        testScript = Get-FileSha256 (Join-Path $ProjectRoot 'scripts/test.ps1')
        signingScript = Get-FileSha256 (Join-Path $ProjectRoot 'scripts/signing.ps1')
        signingInput = Get-FileSha256 (Join-Path $ProjectRoot 'scripts/signing-input.ps1')
        preservationTest = Get-FileSha256 (Join-Path $ProjectRoot 'tests/teaching-preservation.test.mjs')
        smaliHelper = Get-FileSha256 (Join-Path $ProjectRoot 'tests/smali-helpers.mjs')
        runtimeSourceTree = $runtimeSourceTree
        apktoolJar = Get-FileSha256 (Join-Path $ProjectRoot $ToolchainLock.apktool.path)
        apktoolFramework = Get-FileSha256 (Join-Path $ProjectRoot $ToolchainLock.apktool.framework.path)
        zipalign = Get-FileSha256 (Join-Path $ResolvedBuildToolsRoot 'zipalign.exe')
        aapt = Get-FileSha256 (Join-Path $ResolvedBuildToolsRoot 'aapt.exe')
        d8 = Get-FileSha256 (Join-Path $ResolvedBuildToolsRoot 'd8.bat')
        apksigner = Get-FileSha256 (Join-Path $ResolvedBuildToolsRoot 'lib/apksigner.jar')
        java = Get-FileSha256 (Join-Path $ResolvedJavaHome 'bin/java.exe')
        javac = Get-FileSha256 (Join-Path $ResolvedJavaHome 'bin/javac.exe')
    }
    $ordered = [ordered]@{}
    foreach ($name in @($values.Keys | Sort-Object)) { $ordered[$name] = $values[$name] }
    $json = $ordered | ConvertTo-Json -Compress -Depth 4
    return @{ inputHashes = $ordered; buildInputSha256 = Get-TextSha256 $json; runtimeSourceSha256 = $runtimeSourceTree }
}

function Assert-PreSignSnapshotCurrent($Metadata, [string]$ResolvedJavaHome, [string]$ResolvedBuildToolsRoot) {
    if ([IO.Path]::GetFullPath($Metadata.toolPaths.javaHome) -ne [IO.Path]::GetFullPath($ResolvedJavaHome) -or
        [IO.Path]::GetFullPath($Metadata.toolPaths.buildToolsRoot) -ne [IO.Path]::GetFullPath($ResolvedBuildToolsRoot)) {
        throw 'Pre-sign metadata was produced by a different JDK or Android Build Tools path'
    }
    if ([IO.Path]::GetFullPath($ResolvedBuildToolsRoot) -ne [IO.Path]::GetFullPath((Join-Path $ProjectRoot $ToolchainLock.androidBuildTools.installPath))) {
        throw 'Pre-sign metadata does not use the locked Android Build Tools directory'
    }
    $current = Get-CurrentBuildInputHashes $ResolvedJavaHome $ResolvedBuildToolsRoot
    if (($current.inputHashes | ConvertTo-Json -Compress -Depth 4) -cne ($Metadata.inputHashes | ConvertTo-Json -Compress -Depth 4) -or
        $current.buildInputSha256 -ne $Metadata.buildInputSha256 -or $current.runtimeSourceSha256 -ne $Metadata.runtimeSourceSha256) {
        throw 'Source, tool, or baseline inputs changed after PreSignCheck; no APK signature or registration was started'
    }
}

function Set-KeystorePassword([switch]$NewIdentity) {
    if ($Silent) {
        $current = [Environment]::GetEnvironmentVariable($PasswordVariable, 'Process')
        if ([string]::IsNullOrEmpty($current)) { throw 'No password was supplied to this internal signing step' }
        $script:Password = $current
        return
    }
    $script:CreatedPassword = $true
    [Environment]::SetEnvironmentVariable($PasswordVariable, $null, 'Process')
    $script:SecurePassword = Read-ReleasePassword -MinimumLength $(if ($NewIdentity) { 6 } else { 0 })
    $script:PasswordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($script:SecurePassword)
    $script:Password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($script:PasswordPointer)
    [Environment]::SetEnvironmentVariable($PasswordVariable, $script:Password, 'Process')
}

function Get-CertificateDigest([string]$Keystore, [string]$Alias) {
    $keytool = Get-ToolPath 'keytool'
    $listing = & $keytool -list -v -storetype PKCS12 -keystore $Keystore -alias $Alias '-storepass:env' $PasswordVariable 2>&1
    if ($LASTEXITCODE -ne 0) { throw 'Could not validate the PKCS12 release identity; password, alias, or keystore is invalid' }
    $fingerprint = $listing | Where-Object { $_ -match '^\s*SHA256:\s*' } | Select-Object -First 1
    if (-not $fingerprint) { throw 'keytool did not report a SHA-256 certificate fingerprint' }
    return (($fingerprint -replace '^\s*SHA256:\s*', '').Replace(':', '').Trim().ToUpperInvariant())
}

function Read-Identity([string]$Directory) {
    $identityFile = Join-Path $Directory 'signing-identity.json'
    $keyFile = Join-Path $Directory 'release.p12'
    if (-not (Test-Path -LiteralPath $identityFile -PathType Leaf) -or -not (Test-Path -LiteralPath $keyFile -PathType Leaf)) {
        throw "Signing identity is incomplete under $Directory"
    }
    $identity = Get-Content -LiteralPath $identityFile -Raw | ConvertFrom-Json
    if ($identity.schemaVersion -ne 2 -or $identity.applicationId -ne 'io.github.wakeupnoads' -or $identity.alias -ne 'wakeup-noads' -or
        $identity.signatureAlgorithm -ne 'SHA256withRSA' -or $identity.keyAlgorithm -ne 'RSA' -or $identity.keySize -ne 3072 -or $identity.validityDays -ne 10000) {
        throw 'Signing identity metadata has an unexpected application id, alias, or algorithm'
    }
    if ($identity.identityId -ne $identity.certificateSha256 -or $identity.certificateSha256 -notmatch '^[A-F0-9]{64}$' -or
        $identity.keystoreSha256 -notmatch '^[A-F0-9]{64}$' -or (Get-FileSha256 $keyFile) -ne $identity.keystoreSha256) {
        throw 'Signing identity id or keystore hash does not bind its public certificate and key file'
    }
    return $identity
}

function Assert-KeystoreMatchesIdentity([string]$Directory) {
    $identity = Read-Identity $Directory
    $actual = Get-CertificateDigest (Join-Path $Directory 'release.p12') $identity.alias
    if ($actual -ne $identity.certificateSha256.ToUpperInvariant()) { throw 'Signing keystore certificate fingerprint differs from signing-identity.json' }
    return $identity
}

function Assert-PrivateKeyAccess([string]$Directory, [string]$Alias = 'wakeup-noads') {
    $keytool = Get-ToolPath 'keytool'
    $probeRoot = Join-Path $ProjectRoot "tools/_cache/slim-v1-signing-probes/$([guid]::NewGuid().ToString('N'))"
    $probeRoot = Assert-CachePathWithoutLinks $probeRoot 'private-key probe directory'
    New-Item -ItemType Directory -Path $probeRoot -Force | Out-Null
    $csrPath = Join-Path $probeRoot 'private-key-access.csr'
    try {
        $null = & $keytool -certreq -storetype PKCS12 -keystore (Join-Path $Directory 'release.p12') -alias $Alias -sigalg SHA256withRSA -file $csrPath '-storepass:env' $PasswordVariable '-keypass:env' $PasswordVariable 2>&1
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $csrPath -PathType Leaf) -or (Get-Item -LiteralPath $csrPath).Length -eq 0) {
            throw 'Private-key access probe failed; no build, signature, or release registration was started'
        }
        return Get-FileSha256 $csrPath
    } finally {
        [IO.Directory]::Delete($probeRoot, $true)
        $probeParent = Split-Path -Parent $probeRoot
        if (-not (Get-ChildItem -LiteralPath $probeParent -Force | Select-Object -First 1)) { [IO.Directory]::Delete($probeParent) }
    }
}

function Assert-CurrentIdentityPair([switch]$ProbePrivateKeys, [switch]$PublicOnly) {
    foreach ($directory in @($SigningRoot, $BackupRoot)) {
        $null = Assert-SigningTreeHasNoLinks $directory 'Signing pair path'
        if (-not (Test-Path -LiteralPath $directory -PathType Container)) { throw 'Both active and backup signing directories are required' }
        foreach ($name in @('release.p12', 'signing-identity.json', 'release-history.json')) {
            if (-not (Test-Path -LiteralPath (Join-Path $directory $name) -PathType Leaf)) { throw "Signing pair is incomplete under $directory" }
        }
    }
    $active = Read-Identity $SigningRoot
    $backup = Read-Identity $BackupRoot
    if ($active.identityId -ne $backup.identityId -or $active.certificateSha256 -ne $backup.certificateSha256 -or
        $active.keystoreSha256 -ne $backup.keystoreSha256 -or (Get-FileSha256 (Join-Path $SigningRoot 'release.p12')) -ne (Get-FileSha256 (Join-Path $BackupRoot 'release.p12')) -or
        (Get-FileSha256 (Join-Path $SigningRoot 'signing-identity.json')) -ne (Get-FileSha256 (Join-Path $BackupRoot 'signing-identity.json'))) {
        throw 'Active and backup keystore identity or bytes differ'
    }
    $activeHistory = Read-ReleaseHistory $SigningRoot
    $backupHistory = Read-ReleaseHistory $BackupRoot
    if ((Get-FileSha256 (Join-Path $SigningRoot 'release-history.json')) -ne (Get-FileSha256 (Join-Path $BackupRoot 'release-history.json')) -or
        ($activeHistory | ConvertTo-Json -Depth 16 -Compress) -cne ($backupHistory | ConvertTo-Json -Depth 16 -Compress)) {
        throw 'Active and backup release histories conflict; neither history was changed'
    }
    if (-not $PublicOnly) {
        $null = Assert-KeystoreMatchesIdentity $SigningRoot
        $null = Assert-KeystoreMatchesIdentity $BackupRoot
    }
    if ($ProbePrivateKeys) {
        $null = Assert-PrivateKeyAccess $SigningRoot $active.alias
        $null = Assert-PrivateKeyAccess $BackupRoot $backup.alias
    }
    return @{ active = $active; backup = $backup; history = $activeHistory }
}

function Get-ApkIdentity([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "APK does not exist: $Path" }
    $apksigner = Join-Path $BuildToolsPath 'lib/apksigner.jar'
    $aapt = Join-Path $BuildToolsPath 'aapt.exe'
    foreach ($tool in @($apksigner, $aapt)) { if (-not (Test-Path -LiteralPath $tool -PathType Leaf)) { throw "Android Build Tools command is missing: $tool" } }
    $verifyOutput = & (Get-ToolPath 'java') --enable-native-access=ALL-UNNAMED -jar $apksigner verify --verbose --print-certs $Path 2>&1
    if ($LASTEXITCODE -ne 0) { throw 'APK signature verification failed' }
    $certLine = $verifyOutput | Where-Object { $_ -match 'Signer #1 certificate SHA-256 digest:' } | Select-Object -First 1
    if (-not $certLine) { throw 'APK signature has no reported signer certificate digest' }
    $certificate = (($certLine -split ':', 2)[1].Trim().Replace(':', '').ToUpperInvariant())
    $badging = & $aapt dump badging $Path 2>&1
    if ($LASTEXITCODE -ne 0) { throw 'Could not read APK package metadata' }
    $packageLine = $badging | Where-Object { $_ -match "^package: name='" } | Select-Object -First 1
    if (-not $packageLine -or $packageLine -notmatch "name='(?<package>[^']+)'\s+versionCode='(?<code>\d+)'\s+versionName='(?<name>[^']*)'") {
        throw 'APK package metadata line is missing package/version data'
    }
    $hash = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToUpperInvariant()
    return [ordered]@{ packageName = $Matches.package; versionCode = [int]$Matches.code; versionName = $Matches.name; certificateSha256 = $certificate; apkSha256 = $hash }
}

function Get-ApkProtectedPayloadHashes([string]$Path) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($Path)
    try {
        $hashes = [ordered]@{}
        foreach ($entry in @($archive.Entries | Where-Object { $_.FullName -match '^classes(?:\d+)?\.dex$' -or $_.FullName -match '^lib/[^/]+/[^/]+\.so$' } | Sort-Object FullName)) {
            $stream = $entry.Open()
            $algorithm = [Security.Cryptography.SHA256]::Create()
            try { $hashes[$entry.FullName] = [Convert]::ToHexString($algorithm.ComputeHash($stream)) }
            finally { $algorithm.Dispose(); $stream.Dispose() }
        }
        if (-not $hashes.Contains('classes.dex')) { throw "APK has no classes.dex entry: $Path" }
        return $hashes
    } finally { $archive.Dispose() }
}

function Assert-ReadyPreservationEvidence([string]$CandidateApk, [string]$CandidateMetadata, [string]$EvidencePath, $Identity) {
    foreach ($path in @($CandidateApk, $CandidateMetadata, $EvidencePath)) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Required signed candidate evidence is missing: $path" }
    }
    $metadata = Get-Content -LiteralPath $CandidateMetadata -Raw | ConvertFrom-Json
    $ready = Get-Content -LiteralPath $EvidencePath -Raw | ConvertFrom-Json
    $candidateRoot = [IO.Path]::GetFullPath((Split-Path -Parent $CandidateMetadata))
    $expectedReady = [IO.Path]::GetFullPath((Join-Path $candidateRoot 'ready.json'))
    if ([IO.Path]::GetFullPath($EvidencePath) -ne $expectedReady) { throw 'Preservation evidence must be the ready.json owned by this candidate directory' }
    if ($metadata.schemaVersion -ne 3 -or $metadata.stage -ne 'signed' -or $metadata.success -ne $true -or $metadata.deliverable -ne $true -or
        $metadata.identityId -ne $Identity.identityId) {
        throw 'Release metadata is not a successful signed candidate in the current schema'
    }
    if ($ready.schemaVersion -ne 1 -or $ready.stage -ne 'signed' -or $ready.ready -ne $true -or $ready.success -ne $true) {
        throw 'Candidate ready.json is missing or not a successful signed-stage record'
    }
    if ($ready.identityId -ne $Identity.identityId) { throw 'Candidate ready.json is not bound to the current signing identity' }
    if ($metadata.normalizationVersion -ne 2 -or $ready.normalizationVersion -ne 2) { throw 'Candidate evidence uses a stale normalization version' }
    if ($metadata.candidatePurpose -ne 'release') { throw 'Candidate metadata is not a release-stage candidate' }
    $apk = Get-ApkIdentity $CandidateApk
    $candidateCopy = Join-Path $candidateRoot $metadata.filename
    $auditPath = Join-Path $candidateRoot 'teaching-preservation-result.json'
    $patchResultPath = Join-Path $candidateRoot 'patch-result.json'
    foreach ($path in @($candidateCopy, $auditPath, $patchResultPath)) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Candidate evidence file is missing: $path" }
    }
    $candidateHash = Get-FileSha256 $CandidateApk
    if ((Get-FileSha256 $candidateCopy) -ne $candidateHash -or $metadata.apkSha256 -ne $candidateHash -or $ready.apkSha256 -ne $candidateHash) {
        throw 'Candidate APK and output APK hashes are not identical'
    }
    if ($apk.packageName -ne 'io.github.wakeupnoads' -or $apk.packageName -ne $metadata.packageName -or
        $apk.versionCode -ne [int]$metadata.versionCode -or $apk.versionName -ne $metadata.versionName -or
        $apk.certificateSha256 -ne $Identity.certificateSha256.ToUpperInvariant() -or $apk.certificateSha256 -ne $metadata.certificateSha256) {
        throw 'Signed APK package, version, or certificate does not match ready metadata and the fixed identity'
    }
    if ($ready.packageName -ne $apk.packageName -or [int]$ready.versionCode -ne $apk.versionCode -or
        $ready.versionName -ne $apk.versionName -or $ready.certificateSha256 -ne $apk.certificateSha256 -or
        $ready.candidateApkPath -ne [IO.Path]::GetFullPath($candidateCopy) -or $ready.outputApkPath -ne [IO.Path]::GetFullPath($CandidateApk)) {
        throw 'ready.json does not identify this exact signed candidate and output path'
    }
    if ($metadata.apkPath -ne [IO.Path]::GetFullPath($CandidateApk) -or $metadata.candidateApkPath -ne [IO.Path]::GetFullPath($candidateCopy) -or
        $metadata.apkRelativePath -ne [IO.Path]::GetRelativePath($ProjectRoot, $CandidateApk)) { throw 'Release metadata candidate ownership path is inconsistent' }
    if ($ready.releaseMetadataPath -ne [IO.Path]::GetFullPath($CandidateMetadata) -or
        $ready.releaseMetadataSha256 -ne (Get-FileSha256 $CandidateMetadata) -or
        $ready.auditPath -ne [IO.Path]::GetFullPath($auditPath) -or
        $ready.auditSha256 -ne (Get-FileSha256 $auditPath) -or
        $metadata.auditPath -ne [IO.Path]::GetFullPath($auditPath) -or
        $metadata.preservationAuditSha256 -ne $ready.auditSha256 -or
        $ready.patchResultPath -ne [IO.Path]::GetFullPath($patchResultPath) -or
        $ready.patchResultSha256 -ne (Get-FileSha256 $patchResultPath)) {
        throw 'Candidate audit, metadata, ready, or patch evidence hashes do not bind the current files'
    }
    $audit = Get-Content -LiteralPath $auditPath -Raw | ConvertFrom-Json
    if ($audit.schemaVersion -ne 3 -or $audit.stage -ne 'signed' -or $audit.success -ne $true -or
        $audit.normalizationVersion -ne 2 -or $audit.candidatePurpose -ne 'release' -or
        $audit.candidateApkSha256 -ne $candidateHash -or $audit.buildInputSha256 -ne $metadata.buildInputSha256 -or
        $audit.methodInventorySha256 -ne $metadata.methodInventorySha256 -or
        $audit.protectedDecodedInventorySha256 -ne $ready.protectedDecodedInventorySha256 -or
        @($audit.unexplainedDifferences).Count -ne 0 -or @($audit.unexplainedEdges).Count -ne 0) {
        throw 'Signed preservation audit is stale, failed, or unrelated to the ready candidate'
    }
    # The audit stage is removed after a successful build; the audit stays bound to the APK through candidateApkSha256.
    if (-not $ready.auditStageApkPath -or -not $ready.auditStageDecodedRoot -or
        [IO.Path]::GetFullPath($audit.candidateRoot) -ne [IO.Path]::GetFullPath($ready.auditStageDecodedRoot) -or
        [IO.Path]::GetFullPath($audit.candidateApkPath) -ne [IO.Path]::GetFullPath($ready.auditStageApkPath)) {
        throw 'Signed preservation audit stage paths no longer match the ready evidence'
    }
    if ($metadata.baselineSha256 -ne $ToolchainLock.baseline.sha256 -or
        $metadata.patchSpecSha256 -ne (Get-FileSha256 (Join-Path $ProjectRoot 'patches/slim-v1/patch-spec.json')) -or
        $metadata.identitySpecSha256 -ne (Get-FileSha256 (Join-Path $ProjectRoot 'patches/slim-v1/package-identity-spec.json')) -or
        $metadata.dependencyManifestSha256 -ne (Get-FileSha256 (Join-Path $ProjectRoot 'patches/slim-v1/teaching-dependencies.json')) -or
        $metadata.toolchainLockSha256 -ne (Get-FileSha256 $ToolchainLockPath)) {
        throw 'Signed candidate source specification or toolchain inputs have changed since preservation audit'
    }
    Assert-PreSignSnapshotCurrent $metadata ([IO.Path]::GetFullPath($metadata.toolPaths.javaHome)) ([IO.Path]::GetFullPath($metadata.toolPaths.buildToolsRoot))
    $actualPayload = Get-ApkProtectedPayloadHashes $CandidateApk
    if (($actualPayload | ConvertTo-Json -Compress -Depth 4) -cne ($metadata.protectedPayloadHashes | ConvertTo-Json -Compress -Depth 4) -or
        ($actualPayload | ConvertTo-Json -Compress -Depth 4) -cne ($ready.protectedPayloadHashes | ConvertTo-Json -Compress -Depth 4)) {
        throw 'Signed DEX/native payload hashes do not match the pre-sign snapshot'
    }
    return @{ metadata = $metadata; ready = $ready; apk = $apk }
}

function Write-AtomicJson([string]$Path, $Value) {
    $directory = Split-Path -Parent $Path
    $temporary = Join-Path $directory (".$([IO.Path]::GetFileName($Path)).$([guid]::NewGuid().ToString('N')).tmp")
    $Value | ConvertTo-Json -Depth 16 | Set-Content -LiteralPath $temporary -Encoding utf8
    Move-Item -LiteralPath $temporary -Destination $Path -Force
}

function Read-ReleaseHistory([string]$Directory) {
    $path = Join-Path $Directory 'release-history.json'
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "release-history.json is missing under $Directory" }
    $history = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
    $identity = Read-Identity $Directory
    if ($history.schemaVersion -ne 2 -or $history.applicationId -ne 'io.github.wakeupnoads' -or
        $history.identityId -ne $identity.identityId -or $history.certificateSha256 -ne $identity.certificateSha256 -or -not ($history.releases -is [array])) {
        throw "Release history is invalid under $Directory"
    }
    $codes = @($history.releases | ForEach-Object { [int]$_.versionCode })
    $priorCode = 0
    foreach ($code in $codes) { if ($code -le $priorCode) { throw "Release history version entries are not unique and strictly increasing under $Directory" }; $priorCode = $code }
    $computedHighest = if ($codes.Count -gt 0) { [int](($codes | Measure-Object -Maximum).Maximum) } else { 0 }
    if ([int]$history.highestDeliveredVersionCode -ne $computedHighest) { throw "Release history highest version conflicts under $Directory" }
    foreach ($release in $history.releases) {
        if ($release.identityId -ne $identity.identityId -or $release.certificateSha256 -ne $identity.certificateSha256) {
            throw "Release history contains a different signing identity under $Directory"
        }
    }
    return $history
}

function Assert-CachePathWithoutLinks([string]$Path, [string]$Label, [switch]$ScanChildren) {
    $cacheRoot = [IO.Path]::GetFullPath((Join-Path $ProjectRoot 'tools/_cache')).TrimEnd([IO.Path]::DirectorySeparatorChar)
    $full = [IO.Path]::GetFullPath($Path)
    $prefix = $cacheRoot + [IO.Path]::DirectorySeparatorChar
    if (-not $full.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw "$Label is outside tools/_cache" }
    $relative = [IO.Path]::GetRelativePath($cacheRoot, $full)
    $cursor = $cacheRoot
    foreach ($part in $relative.Split([IO.Path]::DirectorySeparatorChar, [StringSplitOptions]::RemoveEmptyEntries)) {
        $cursor = Join-Path $cursor $part
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "$Label crosses a link or reparse point: $cursor" }
        }
    }
    if ($ScanChildren -and (Test-Path -LiteralPath $full -PathType Container)) {
        $link = Get-ChildItem -LiteralPath $full -Recurse -Force | Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 } | Select-Object -First 1
        if ($link) { throw "$Label contains a link or reparse point: $($link.FullName)" }
    }
    return $full
}

function Invoke-SigningInternalAction([string]$ActionName, [string]$CandidateApk, [string]$CandidateMetadata, [string]$CandidateEvidence = $null) {
    $parameters = @{
        Action = $ActionName
        JavaHome = $ResolvedJavaHome
        SigningRoot = $SigningRoot
        BackupRoot = $BackupRoot
        BuildToolsPath = $BuildToolsPath
        Silent = $true
    }
    if ($ActionName -eq 'RecordRelease') {
        $parameters.ApkPath = $CandidateApk
        $parameters.MetadataPath = $CandidateMetadata
        $parameters.PreservationEvidencePath = $CandidateEvidence
    }
    $global:LASTEXITCODE = 0
    & $script:SigningScriptPath @parameters
    if ($LASTEXITCODE -ne 0) { throw "Signing action $ActionName failed with exit code $LASTEXITCODE" }
}

function Assert-SigningTreeHasNoLinks([string]$Path, [string]$Label) {
    $full = [IO.Path]::GetFullPath($Path)
    $cursor = [IO.Path]::GetPathRoot($full)
    foreach ($part in [IO.Path]::GetRelativePath($cursor, $full).Split([IO.Path]::DirectorySeparatorChar, [StringSplitOptions]::RemoveEmptyEntries)) {
        $cursor = Join-Path $cursor $part
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "$Label crosses a link or reparse point: $cursor" }
        }
    }
    if (Test-Path -LiteralPath $full -PathType Container) {
        $childLink = Get-ChildItem -LiteralPath $full -Recurse -Force | Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 } | Select-Object -First 1
        if ($childLink) { throw "$Label contains a link or reparse point: $($childLink.FullName)" }
    }
    return $full
}

function Enter-SigningWorkflowLock {
    $signingBase = [IO.Path]::GetFullPath((Join-Path $ProjectRoot 'tools/_signing'))
    $null = Assert-SigningTreeHasNoLinks $signingBase 'Signing workflow root'
    New-Item -ItemType Directory -Path $signingBase -Force | Out-Null
    $lockPath = Join-Path $signingBase 'signing.lock'
    $null = Assert-SigningTreeHasNoLinks $lockPath 'Signing workflow lock'
    try { return [IO.FileStream]::new($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None, 4096, [IO.FileOptions]::DeleteOnClose) }
    catch { throw 'Another signing action holds the exclusive signing lock' }
}

function Invoke-Release {
    if ($Revision -lt 1) { throw 'Release revision is invalid' }
    Assert-ReleaseLocalInputs
    $buildScript = Join-Path $PSScriptRoot 'build.ps1'
    if (-not (Test-Path -LiteralPath $buildScript -PathType Leaf)) { throw 'scripts/build.ps1 is missing' }
    if ($NodePath) {
        $resolvedNode = [IO.Path]::GetFullPath($NodePath)
        if (-not (Test-Path -LiteralPath $resolvedNode -PathType Leaf)) { throw "Node executable is missing: $NodePath" }
    } else {
        $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
        if (-not $nodeCommand) { throw 'Node.js is required. Pass -NodePath with a Node executable.' }
        $resolvedNode = $nodeCommand.Source
    }
    $keytool = Get-ToolPath 'keytool'
    $ResolvedJavaHome = Split-Path -Parent (Split-Path -Parent $keytool)

    $activeExists = Test-Path -LiteralPath $SigningRoot
    $backupExists = Test-Path -LiteralPath $BackupRoot
    if ($activeExists -ne $backupExists) { throw 'Release found a partial signing identity/backup state; no files were changed' }
    $needsInitialization = -not $activeExists
    if ($needsInitialization) {
        $expectedVersionCode = 542
    } else {
        $pair = Assert-CurrentIdentityPair -PublicOnly
        $highest = [int]$pair.history.highestDeliveredVersionCode
        $expectedVersionCode = if ($highest -eq 0) { 542 } else { $highest + 1 }
    }
    $targetVersionCode = if ($VersionCode -eq 0) { $expectedVersionCode } else { $VersionCode }
    if ($targetVersionCode -ne $expectedVersionCode) { throw "VersionCode must be $expectedVersionCode for the current delivered history" }

    Set-KeystorePassword -NewIdentity:$needsInitialization
    if ($needsInitialization) {
        Invoke-SigningInternalAction 'Initialize' $null $null
        Invoke-SigningInternalAction 'Backup' $null $null
    }
    $null = Assert-CurrentIdentityPair -ProbePrivateKeys

    $global:LASTEXITCODE = 0
    & $buildScript -Mode Unsigned -PrepareOnly -JavaHome $ResolvedJavaHome -NodePath $resolvedNode
    if ($LASTEXITCODE -ne 0) { throw "Build preflight failed with exit code $LASTEXITCODE; no APK signature or registration was started" }

    $global:LASTEXITCODE = 0
    try {
        $preSignOutput = @(& $buildScript -Mode PreSignCheck -ApplicationId 'io.github.wakeupnoads' -VersionCode $targetVersionCode -Revision $Revision -JavaHome $ResolvedJavaHome -NodePath $resolvedNode 2>&1)
    } catch { throw 'PreSignCheck failed before completion; no APK signature or registration was started' }
    $preSignExitCode = $LASTEXITCODE
    foreach ($line in $preSignOutput) { Write-Output $line }
    if ($preSignExitCode -ne 0) { throw "PreSignCheck failed with exit code $preSignExitCode; no APK signature or registration was started" }
    $metadataLine = @($preSignOutput | ForEach-Object { [string]$_ } | Where-Object { $_ -match '^Pre-sign metadata:\s*(?<path>.+)$' } | Select-Object -Last 1)
    if ($metadataLine.Count -ne 1) { throw 'PreSignCheck did not report exactly one metadata path; no APK signature or registration was started' }
    $metadataPath = [IO.Path]::GetFullPath(([regex]::Match($metadataLine[0], '^Pre-sign metadata:\s*(?<path>.+)$')).Groups['path'].Value.Trim())
    if (-not (Test-Path -LiteralPath $metadataPath -PathType Leaf)) { throw 'PreSignCheck metadata is missing; no APK signature or registration was started' }
    $metadata = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
    $preSignRoot = [IO.Path]::GetFullPath((Join-Path $ProjectRoot "tools/_cache/slim-v1-build/pre-sign/versionCode-$targetVersionCode"))
    $preSignPrefix = $preSignRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    $stageRoot = [IO.Path]::GetFullPath((Split-Path -Parent $metadataPath))
    $expectedApkPath = [IO.Path]::GetFullPath((Join-Path $stageRoot $metadata.filename))
    $expectedDecodedRoot = [IO.Path]::GetFullPath((Join-Path $stageRoot 'roundtrip-decoded'))
    $expectedAuditPath = [IO.Path]::GetFullPath((Join-Path $stageRoot 'teaching-preservation-result.json'))
    $expectedPatchResultPath = [IO.Path]::GetFullPath((Join-Path $stageRoot 'patch-result.json'))
    if (-not $stageRoot.StartsWith($preSignPrefix, [StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetFullPath($metadataPath) -ne [IO.Path]::GetFullPath((Join-Path $stageRoot 'pre-sign-metadata.json')) -or
        $metadata.schemaVersion -ne 3 -or $metadata.stage -ne 'pre-sign' -or $metadata.candidatePurpose -ne 'pre-sign' -or
        $metadata.success -ne $true -or $metadata.signed -ne $false -or
        $metadata.deliverable -ne $false -or $metadata.normalizationVersion -ne 2 -or
        [int]$metadata.versionCode -ne $targetVersionCode -or
        [IO.Path]::GetFullPath($metadata.apkPath) -ne $expectedApkPath -or
        [IO.Path]::GetFullPath($metadata.decodedRoot) -ne $expectedDecodedRoot -or
        [IO.Path]::GetFullPath($metadata.auditPath) -ne $expectedAuditPath -or
        [IO.Path]::GetFullPath($metadata.patchResultPath) -ne $expectedPatchResultPath) {
        throw 'PreSignCheck metadata is not a successful isolated pre-sign candidate; no APK signature or registration was started'
    }
    foreach ($path in @($metadata.apkPath, $metadata.auditPath, $metadata.patchResultPath)) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'PreSignCheck evidence file is missing; no APK signature or registration was started' }
    }
    if ((Get-FileSha256 $metadata.apkPath) -ne $metadata.apkSha256 -or
        (Get-FileSha256 $metadata.patchResultPath) -ne $metadata.patchResultSha256 -or
        (Get-FileSha256 $metadata.auditPath) -ne $metadata.preservationAuditSha256) {
        throw 'PreSignCheck APK, patch result, or successful audit is missing or stale; no APK signature or registration was started'
    }
    $badging = & (Join-Path $BuildToolsPath 'aapt.exe') dump badging $metadata.apkPath 2>&1
    if ($LASTEXITCODE -ne 0) { throw 'PreSignCheck actual APK metadata could not be read; no APK signature or registration was started' }
    $packageLine = $badging | Where-Object { $_ -match "^package: name='" } | Select-Object -First 1
    $packageMatch = [regex]::Match([string]$packageLine, "name='(?<package>[^']+)'\s+versionCode='(?<code>\d+)'\s+versionName='(?<name>[^']*)'")
    if (-not $packageMatch.Success -or $packageMatch.Groups['package'].Value -ne 'io.github.wakeupnoads' -or
        [int]$packageMatch.Groups['code'].Value -ne $targetVersionCode -or
        $packageMatch.Groups['name'].Value -ne $metadata.releaseName -or
        $metadata.packageName -ne $packageMatch.Groups['package'].Value -or
        $metadata.versionName -ne $packageMatch.Groups['name'].Value) {
        throw 'PreSignCheck actual APK package/version metadata conflicts with its evidence; no APK signature or registration was started'
    }
    $dependencyManifest = Get-Content -LiteralPath (Join-Path $ProjectRoot 'patches/slim-v1/teaching-dependencies.json') -Raw | ConvertFrom-Json
    if ($metadata.baselineSha256 -ne $ToolchainLock.baseline.sha256 -or
        $metadata.patchSpecSha256 -ne (Get-FileSha256 (Join-Path $ProjectRoot 'patches/slim-v1/patch-spec.json')) -or
        $metadata.identitySpecSha256 -ne (Get-FileSha256 (Join-Path $ProjectRoot 'patches/slim-v1/package-identity-spec.json')) -or
        $metadata.dependencyManifestSha256 -ne (Get-FileSha256 (Join-Path $ProjectRoot 'patches/slim-v1/teaching-dependencies.json')) -or
        $metadata.methodInventorySha256 -ne $dependencyManifest.methodInventorySha256 -or
        $metadata.toolchainLockSha256 -ne (Get-FileSha256 $ToolchainLockPath)) {
        throw 'PreSignCheck baseline/spec/inventory metadata is stale; no APK signature or registration was started'
    }
    $audit = Get-Content -LiteralPath $metadata.auditPath -Raw | ConvertFrom-Json
    if ($audit.schemaVersion -ne 3 -or $audit.stage -ne 'pre-sign' -or $audit.success -ne $true -or
        $audit.normalizationVersion -ne 2 -or $audit.candidatePurpose -ne 'pre-sign' -or
        [IO.Path]::GetFullPath($audit.candidateRoot) -ne $expectedDecodedRoot -or
        [IO.Path]::GetFullPath($audit.candidateApkPath) -ne $expectedApkPath -or
        [IO.Path]::GetFullPath($audit.candidateMetadataPath) -ne [IO.Path]::GetFullPath($metadataPath) -or
        $audit.candidateApkSha256 -ne $metadata.apkSha256 -or $audit.buildInputSha256 -ne $metadata.buildInputSha256 -or
        $audit.methodInventorySha256 -ne $metadata.methodInventorySha256 -or
        @($audit.unexplainedDifferences).Count -ne 0 -or
        @($audit.unexplainedEdges).Count -ne 0) {
        throw 'PreSignCheck audit is failed, unexplained, or unrelated; no APK signature or registration was started'
    }
    Assert-PreSignSnapshotCurrent $metadata $ResolvedJavaHome $BuildToolsPath
    $preSignSnapshot = $metadata
    [IO.Directory]::Delete($stageRoot, $true)
    foreach ($emptyParent in @($preSignRoot, (Split-Path -Parent $preSignRoot))) {
        if ((Test-Path -LiteralPath $emptyParent -PathType Container) -and -not (Get-ChildItem -LiteralPath $emptyParent -Force | Select-Object -First 1)) { [IO.Directory]::Delete($emptyParent) }
    }

    $null = Assert-CurrentIdentityPair
    $currentInputs = Get-CurrentBuildInputHashes $ResolvedJavaHome $BuildToolsPath
    if ($currentInputs.buildInputSha256 -ne $preSignSnapshot.buildInputSha256 -or
        ($currentInputs.inputHashes | ConvertTo-Json -Compress -Depth 4) -cne ($preSignSnapshot.inputHashes | ConvertTo-Json -Compress -Depth 4)) {
        throw 'Build inputs changed after PreSignCheck; no APK signature or registration was started'
    }

    $candidateRoot = Join-Path $ProjectRoot "tools/_cache/slim-v1-build/candidates/versionCode-$targetVersionCode"
    $metadataPath = Join-Path $candidateRoot 'release-metadata.json'
    $readyPath = Join-Path $candidateRoot 'ready.json'
    $existingRegistration = @((Read-ReleaseHistory $SigningRoot).releases | Where-Object { [int]$_.versionCode -eq $targetVersionCode })
    $hasReadyCandidate = (Test-Path -LiteralPath $metadataPath -PathType Leaf) -and (Test-Path -LiteralPath $readyPath -PathType Leaf)
    if ($existingRegistration.Count -gt 1) { throw 'Release history has duplicate registrations for the requested candidate' }
    if ($existingRegistration.Count -eq 1 -and -not $hasReadyCandidate) { throw 'Registered candidate has lost its owned ready evidence; it will not be rebuilt or overwritten' }
    if (-not $hasReadyCandidate) {
        $global:LASTEXITCODE = 0
        & $buildScript -Mode ReleaseSigned -ApplicationId 'io.github.wakeupnoads' -VersionCode $targetVersionCode -Revision $Revision -JavaHome $ResolvedJavaHome -NodePath $resolvedNode
        if ($LASTEXITCODE -ne 0) { throw "ReleaseSigned build failed with exit code $LASTEXITCODE" }
    }
    if (-not (Test-Path -LiteralPath $metadataPath -PathType Leaf)) { throw 'Candidate metadata is missing after ReleaseSigned' }
    $metadata = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
    if ([int]$metadata.versionCode -ne $targetVersionCode) { throw "Candidate metadata conflicts with versionCode $targetVersionCode (found $($metadata.versionCode))" }
    $candidateApk = Join-Path $ProjectRoot $metadata.apkRelativePath
    if (-not (Test-Path -LiteralPath $candidateApk -PathType Leaf)) { throw 'Candidate APK is missing after ReleaseSigned' }
    Invoke-SigningInternalAction 'RecordRelease' $candidateApk $metadataPath $readyPath

    $activeHistory = Read-ReleaseHistory $SigningRoot
    $backupHistory = Read-ReleaseHistory $BackupRoot
    if (($activeHistory | ConvertTo-Json -Depth 16 -Compress) -cne ($backupHistory | ConvertTo-Json -Depth 16 -Compress)) {
        throw 'Active and backup release histories differ after registration'
    }
    $registered = @($activeHistory.releases | Where-Object { [int]$_.versionCode -eq $targetVersionCode })
    if ($registered.Count -ne 1) { throw 'Release history did not register exactly one candidate' }

    $releaseDirectory = Join-Path $ProjectRoot 'tools/release'
    $null = Assert-SigningTreeHasNoLinks $releaseDirectory 'Release output directory'
    New-Item -ItemType Directory -Path $releaseDirectory -Force | Out-Null
    $publishedApk = Join-Path $releaseDirectory $metadata.filename
    $publishTemp = Join-Path $releaseDirectory ".$($metadata.filename).$([guid]::NewGuid().ToString('N')).tmp"
    Copy-Item -LiteralPath $candidateApk -Destination $publishTemp
    if ((Get-FileSha256 $publishTemp) -ne $registered[0].apkSha256) {
        [IO.File]::Delete($publishTemp)
        throw 'Published APK copy does not match the registered APK hash'
    }
    Move-Item -LiteralPath $publishTemp -Destination $publishedApk -Force
    Write-Output "Release completed: $publishedApk (versionCode $targetVersionCode)"
}

try {
    if ($MyInvocation.InvocationName -eq '.') { return }
    if ($Action -eq 'Initialize') {
        $null = Get-ToolPath 'keytool'
        if ((Test-Path -LiteralPath $KeystorePath) -or (Test-Path -LiteralPath $IdentityPath) -or (Test-Path -LiteralPath $HistoryPath)) { throw 'Initialize refuses to overwrite any existing signing target' }
        Set-KeystorePassword -NewIdentity
    } elseif ($Action -eq 'VerifyIdentity') {
        $null = Get-ToolPath 'keytool'
        $null = Assert-CurrentIdentityPair -PublicOnly
        Set-KeystorePassword
    } elseif ($Action -eq 'Backup') {
        $null = Get-ToolPath 'keytool'
        $null = Read-Identity $SigningRoot
        $null = Read-ReleaseHistory $SigningRoot
        if (Test-Path -LiteralPath $BackupRoot) { throw "Backup target already exists and will not be overwritten: $BackupRoot" }
        Set-KeystorePassword
    }
    switch ($Action) {
        'Initialize' {
            if ((Test-Path -LiteralPath $KeystorePath) -or (Test-Path -LiteralPath $IdentityPath) -or (Test-Path -LiteralPath $HistoryPath)) {
                throw 'Initialize refuses to overwrite any existing signing target'
            }
            New-Item -ItemType Directory -Path $SigningRoot -Force | Out-Null
            $keytool = Get-ToolPath 'keytool'
            $keytoolOutput = & $keytool -genkeypair -alias 'wakeup-noads' -keystore $KeystorePath -storetype PKCS12 -keyalg RSA -keysize 3072 -sigalg SHA256withRSA -validity 10000 -dname 'CN=WakeupNoAds' -noprompt '-storepass:env' $PasswordVariable '-keypass:env' $PasswordVariable 2>&1
            if ($LASTEXITCODE -ne 0) { throw 'keytool failed to create the release key; no signing action continued' }
            $certificateSha256 = Get-CertificateDigest $KeystorePath 'wakeup-noads'
            $probeHash = Assert-PrivateKeyAccess $SigningRoot 'wakeup-noads'
            $keystoreSha256 = Get-FileSha256 $KeystorePath
            $identity = [ordered]@{
                schemaVersion = 2
                applicationId = 'io.github.wakeupnoads'
                alias = 'wakeup-noads'
                keyAlgorithm = 'RSA'
                keySize = 3072
                signatureAlgorithm = 'SHA256withRSA'
                validityDays = 10000
                certificateSha256 = $certificateSha256
                identityId = $certificateSha256
                keystoreSha256 = $keystoreSha256
                initializedUtc = [DateTime]::UtcNow.ToString('O')
            }
            $history = [ordered]@{ schemaVersion = 2; applicationId = 'io.github.wakeupnoads'; identityId = $certificateSha256; certificateSha256 = $certificateSha256; highestDeliveredVersionCode = 0; releases = @() }
            if ((Test-Path -LiteralPath $IdentityPath) -or (Test-Path -LiteralPath $HistoryPath)) { throw 'A signing metadata target appeared during initialization' }
            Write-AtomicJson $IdentityPath $identity
            Write-AtomicJson $HistoryPath $history
            if (-not $Silent) { Write-Output "Initialized release identity. Certificate SHA-256: $certificateSha256" }
        }
        'VerifyIdentity' {
            $identity = Assert-CurrentIdentityPair -ProbePrivateKeys
            if (-not $Silent) { Write-Output "Signing identity pair verified. Identity ID: $($identity.active.identityId)" }
        }
        'Backup' {
            $identity = Assert-KeystoreMatchesIdentity $SigningRoot
            $null = Read-ReleaseHistory $SigningRoot
            $null = Assert-PrivateKeyAccess $SigningRoot $identity.alias
            if (Test-Path -LiteralPath $BackupRoot) { throw "Backup target already exists and will not be overwritten: $BackupRoot" }
            New-Item -ItemType Directory -Path $BackupRoot -Force | Out-Null
            try {
                Copy-Item -LiteralPath $KeystorePath,$IdentityPath,$HistoryPath -Destination $BackupRoot
                $backupIdentity = Assert-KeystoreMatchesIdentity $BackupRoot
                if ($backupIdentity.identityId -ne $identity.identityId -or $backupIdentity.keystoreSha256 -ne $identity.keystoreSha256 -or
                    (Get-FileSha256 (Join-Path $BackupRoot 'release.p12')) -ne (Get-FileSha256 $KeystorePath)) { throw 'Backup key identity or bytes do not match the original' }
                $null = Assert-PrivateKeyAccess $BackupRoot $backupIdentity.alias
            } catch {
                throw "Backup verification failed; partial backup is preserved for recovery at $BackupRoot"
            }
            if (-not $Silent) { Write-Output "Signing backup verified. Identity ID: $($identity.identityId)" }
        }
        'Release' {
            $releaseLock = Enter-SigningWorkflowLock
            try { Invoke-Release } finally { $releaseLock.Dispose() }
        }
        'RecordRelease' {
            if (-not $ApkPath -or -not $MetadataPath -or -not $PreservationEvidencePath) { throw 'RecordRelease requires -ApkPath, -MetadataPath, and -PreservationEvidencePath' }
            $identity = Read-Identity $SigningRoot
            $verifiedEvidence = Assert-ReadyPreservationEvidence $ApkPath $MetadataPath $PreservationEvidencePath $identity
            if (-not (Test-Path -LiteralPath $HistoryPath -PathType Leaf)) { throw 'release-history.json is missing; release history is never reset automatically' }
            $backupIdentityPath = Join-Path $BackupRoot 'signing-identity.json'
            $backupHistoryPath = Join-Path $BackupRoot 'release-history.json'
            if (-not (Test-Path -LiteralPath $backupIdentityPath -PathType Leaf) -or -not (Test-Path -LiteralPath $backupHistoryPath -PathType Leaf)) { throw 'The protected key backup and release history backup are required before release registration' }
            $backupIdentity = Read-Identity $BackupRoot
            if ($backupIdentity.identityId -ne $identity.identityId -or $backupIdentity.keystoreSha256 -ne $identity.keystoreSha256 -or
                (Get-FileSha256 (Join-Path $BackupRoot 'release.p12')) -ne (Get-FileSha256 $KeystorePath)) { throw 'Backup key identity conflicts with the active identity' }
            $metadata = $verifiedEvidence.metadata
            $apk = Get-ApkIdentity $ApkPath
            if ($metadata.packageName -ne 'io.github.wakeupnoads' -or $apk.packageName -ne $metadata.packageName) { throw 'APK package name conflicts with release metadata' }
            if ($apk.versionCode -ne [int]$metadata.versionCode -or $apk.versionName -ne $metadata.versionName) { throw 'APK version metadata conflicts with release metadata' }
            if ($metadata.releaseName -ne $metadata.versionName -or $metadata.tagName -ne $metadata.releaseName -or $metadata.filename -ne "$($metadata.releaseName).apk") { throw 'APK filename, versionName, and tagName must use the same releaseName' }
            if ([IO.Path]::GetFileName($ApkPath) -ne $metadata.filename) { throw 'APK file basename does not match release metadata' }
            if ($apk.certificateSha256 -ne $identity.certificateSha256.ToUpperInvariant() -or $metadata.certificateSha256 -ne $apk.certificateSha256 -or
                $metadata.identityId -ne $identity.identityId) { throw 'APK signer fingerprint or identity id conflicts with the current release identity' }
            if ($apk.apkSha256 -ne $metadata.apkSha256.ToUpperInvariant()) { throw 'APK SHA-256 conflicts with release metadata' }

            $history = Read-ReleaseHistory $SigningRoot
            $backupHistory = Read-ReleaseHistory $BackupRoot
            if ((Get-FileSha256 $HistoryPath) -ne (Get-FileSha256 $backupHistoryPath) -or
                ($history | ConvertTo-Json -Depth 16 -Compress) -cne ($backupHistory | ConvertTo-Json -Depth 16 -Compress)) { throw 'Active and backup release histories conflict before registration; neither history was repaired' }
            $codes = @($history.releases | ForEach-Object { [int]$_.versionCode })
            $computedHighest = if ($codes.Count -gt 0) { ($codes | Measure-Object -Maximum).Maximum } else { 0 }
            if ([int]$history.highestDeliveredVersionCode -ne [int]$computedHighest) { throw 'Release history highest version conflicts with its entries' }
            $existing = $history.releases | Where-Object { [int]$_.versionCode -eq $apk.versionCode } | Select-Object -First 1
            if ($existing) {
                    if ($existing.apkSha256 -eq $apk.apkSha256 -and $existing.releaseName -eq $metadata.releaseName -and $existing.certificateSha256 -eq $apk.certificateSha256 -and $existing.identityId -eq $identity.identityId) {
                    if (-not $Silent) { Write-Output 'This exact APK is already registered; release history was not duplicated.' }
                    return
                }
                throw 'Version code is already registered to a different APK or release identity'
            }
            if ($apk.versionCode -le [int]$history.highestDeliveredVersionCode) { throw 'New delivered versionCode must strictly exceed all registered versions' }
            $entry = [ordered]@{
                apkSha256 = $apk.apkSha256
                certificateSha256 = $apk.certificateSha256
                identityId = $identity.identityId
                packageName = $apk.packageName
                versionCode = $apk.versionCode
                versionName = $apk.versionName
                baselineSha256 = $metadata.baselineSha256
                baselineVersion = $metadata.baselineVersion
                revision = $metadata.revision
                releaseName = $metadata.releaseName
                filename = $metadata.filename
                apkRelativePath = $metadata.apkRelativePath
                tagName = $metadata.tagName
                normalizationVersion = $metadata.normalizationVersion
                buildInputSha256 = $metadata.buildInputSha256
                preservationAuditSha256 = $verifiedEvidence.ready.auditSha256
                readySha256 = Get-FileSha256 $PreservationEvidencePath
                registeredUtc = [DateTime]::UtcNow.ToString('O')
            }
            $newReleases = @($history.releases) + @($entry)
            $updatedHistory = [ordered]@{ schemaVersion = 2; applicationId = 'io.github.wakeupnoads'; identityId = $identity.identityId; certificateSha256 = $identity.certificateSha256; highestDeliveredVersionCode = $apk.versionCode; releases = $newReleases }
            Write-AtomicJson $HistoryPath $updatedHistory
            $backupHistoryTemp = Join-Path $BackupRoot ".release-history.$([guid]::NewGuid().ToString('N')).tmp"
            $updatedHistory | ConvertTo-Json -Depth 16 | Set-Content -LiteralPath $backupHistoryTemp -Encoding utf8
            Move-Item -LiteralPath $backupHistoryTemp -Destination $backupHistoryPath -Force
            if (-not $Silent) { Write-Output "Registered $($entry.releaseName) at versionCode $($entry.versionCode). APK SHA-256: $($entry.apkSha256)" }
        }
    }
} finally {
    if ($CreatedPassword) { [Environment]::SetEnvironmentVariable($PasswordVariable, $PreviousPassword, 'Process') }
    $Password = $null
    if ($PasswordPointer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($PasswordPointer)
        $PasswordPointer = [IntPtr]::Zero
    }
    if ($SecurePassword) { $SecurePassword.Dispose() }
    $SecurePassword = $null
    $plainPassword = $null
    $PreviousPassword = $null
}
