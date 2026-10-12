[CmdletBinding()]
param(
    [ValidateSet('Unsigned', 'ReleaseSigned', 'PreSignCheck')]
    [string]$Mode = 'ReleaseSigned',
    [string]$ApplicationId = 'io.github.wakeupnoads',
    [ValidateRange(1, 2100000000)]
    [int]$VersionCode = 542,
    [ValidateRange(1, 2100000000)]
    [int]$Revision = 1,
    [string]$JavaHome,
    [string]$NodePath,
    [string]$BaselineApk,
    [switch]$PrepareOnly
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$LockPath = Join-Path $Root 'patches/slim-v1/toolchain-lock.json'
$Lock = Get-Content -LiteralPath $LockPath -Raw | ConvertFrom-Json
$CacheRoot = Join-Path $Root 'tools/_cache/slim-v1-build'
$DownloadsRoot = Join-Path $Root 'tools/_downloads'
$BuildToolsRoot = Join-Path $Root $Lock.androidBuildTools.installPath
$ArchivePath = Join-Path $Root $Lock.androidBuildTools.archivePath
$ApktoolJar = Join-Path $Root $Lock.apktool.path
$FrameworkRoot = Join-Path $Root 'tools/_cache/apktool'
$SigningRoot = Join-Path $Root 'tools/_signing/wakeup-noads'
$SigningScript = Join-Path $PSScriptRoot 'signing.ps1'
$PatchSpecPath = Join-Path $Root 'patches/slim-v1/patch-spec.json'
$BaselineApk = if ($BaselineApk) { [IO.Path]::GetFullPath($BaselineApk) } else { Join-Path $Root $Lock.baseline.path }
. (Join-Path $PSScriptRoot 'signing-input.ps1')

function Get-Sha256([string]$Path) {
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToUpperInvariant()
}

function Get-Sha256Text([string]$Value) {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return [Convert]::ToHexString($algorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value))) }
    finally { $algorithm.Dispose() }
}

function Assert-ReleaseSigningPublicState {
    $directories = @($SigningRoot, (Join-Path $Root 'tools/_signing/wakeup-noads-backup'))
    $identities = @()
    foreach ($directory in $directories) {
        $cursor = [IO.Path]::GetPathRoot($directory)
        foreach ($part in [IO.Path]::GetRelativePath($cursor, $directory).Split([IO.Path]::DirectorySeparatorChar, [StringSplitOptions]::RemoveEmptyEntries)) {
            $cursor = Join-Path $cursor $part
            if ((Test-Path -LiteralPath $cursor) -and ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Signing identity path crosses a link or reparse point' }
        }
        foreach ($name in @('release.p12', 'signing-identity.json', 'release-history.json')) {
            if (-not (Test-Path -LiteralPath (Join-Path $directory $name) -PathType Leaf)) { throw 'ReleaseSigned requires a complete active and backup signing identity before input' }
            if (((Get-Item -LiteralPath (Join-Path $directory $name) -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Signing identity file is a link or reparse point' }
        }
        $identity = Get-Content -LiteralPath (Join-Path $directory 'signing-identity.json') -Raw | ConvertFrom-Json
        $history = Get-Content -LiteralPath (Join-Path $directory 'release-history.json') -Raw | ConvertFrom-Json
        if ($identity.schemaVersion -ne 2 -or $identity.applicationId -ne 'io.github.wakeupnoads' -or $identity.alias -ne 'wakeup-noads' -or
            $identity.keyAlgorithm -ne 'RSA' -or $identity.keySize -ne 3072 -or $identity.signatureAlgorithm -ne 'SHA256withRSA' -or $identity.validityDays -ne 10000 -or
            $identity.certificateSha256 -notmatch '^[A-F0-9]{64}$' -or
            $identity.identityId -ne $identity.certificateSha256 -or $identity.keystoreSha256 -ne (Get-Sha256 (Join-Path $directory 'release.p12')) -or
            $history.schemaVersion -ne 2 -or $history.applicationId -ne 'io.github.wakeupnoads' -or $history.identityId -ne $identity.identityId -or
            $history.certificateSha256 -ne $identity.certificateSha256 -or -not ($history.releases -is [array])) { throw 'ReleaseSigned public identity/history binding is invalid' }
        $highest = 0
        foreach ($entry in $history.releases) {
            if ($entry.identityId -ne $identity.identityId -or $entry.certificateSha256 -ne $identity.certificateSha256 -or
                $entry.packageName -ne 'io.github.wakeupnoads' -or [int]$entry.versionCode -le $highest) { throw 'ReleaseSigned public release entries are invalid or not strictly increasing' }
            $highest = [int]$entry.versionCode
        }
        if ([int]$history.highestDeliveredVersionCode -ne $highest) { throw 'ReleaseSigned public highest version conflicts with its entries' }
        $identities += $identity
    }
    foreach ($name in @('release.p12', 'signing-identity.json', 'release-history.json')) {
        if ((Get-Sha256 (Join-Path $directories[0] $name)) -ne (Get-Sha256 (Join-Path $directories[1] $name))) { throw 'ReleaseSigned active and backup file hashes differ before input' }
    }
    return $identities[0]
}

function Assert-WithinPath([string]$Path, [string]$Parent, [string]$Label) {
    $fullPath = [IO.Path]::GetFullPath($Path)
    $fullParent = [IO.Path]::GetFullPath($Parent).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if (-not $fullPath.StartsWith($fullParent, [StringComparison]::OrdinalIgnoreCase)) {
        throw "$Label is outside its approved directory: $Path"
    }
    return $fullPath
}

function Invoke-Logged([string]$Executable, [string[]]$Arguments, [string]$LogPath) {
    $output = & $Executable @Arguments 2>&1
    $exitCode = $LASTEXITCODE
    $output | Out-File -LiteralPath $LogPath -Encoding utf8
    if ($exitCode -ne 0) {
        throw "Command failed with exit code $exitCode. See $LogPath"
    }
    return $output
}

function Assert-OfficialBuildToolsMetadata {
    $metadataPath = Join-Path $Root 'tools/_cache/android-repository2-1.xml'
    $metadataPath = Assert-WithinPath $metadataPath (Join-Path $Root 'tools/_cache') 'SDK repository metadata'
    $metadataUrl = 'https://dl.google.com/android/repository/repository2-1.xml'
    $partPath = "$metadataPath.part"
    try {
        Invoke-WebRequest -Uri $metadataUrl -OutFile $partPath
        Move-Item -LiteralPath $partPath -Destination $metadataPath -Force
    } finally {
        if (Test-Path -LiteralPath $partPath) { Remove-Item -LiteralPath $partPath -Force }
    }
    $xmlText = Get-Content -LiteralPath $metadataPath -Raw
    $packageMatch = [regex]::Match($xmlText, '(?s)<remotePackage\s+path="build-tools;35\.0\.0"\s*>(?<body>.*?)</remotePackage>')
    if (-not $packageMatch.Success) { throw 'Google repository metadata has no Build Tools 35.0.0 package' }
    $body = $packageMatch.Groups['body'].Value
    $urlMatch = [regex]::Match($body, '<url>build-tools_r35_windows\.zip</url>')
    $windowsArchive = [regex]::Matches($body, '(?s)<archive>(?<value>.*?)</archive>') | Where-Object { $_.Groups['value'].Value -match '<url>build-tools_r35_windows\.zip</url>' } | Select-Object -First 1
    if (-not $windowsArchive) { throw 'Google repository metadata has no Windows archive entry' }
    $archiveBody = $windowsArchive.Groups['value'].Value
    $shaMatch = [regex]::Match($archiveBody, '<checksum[^>]*>(?<value>[A-Fa-f0-9]{40})</checksum>')
    $sizeMatch = [regex]::Match($archiveBody, '<size>(?<value>\d+)</size>')
    if (-not $urlMatch.Success -or -not $shaMatch.Success -or -not $sizeMatch.Success) {
        throw 'Build Tools metadata is missing the Windows URL, official checksum, or size'
    }
    $officialUrl = 'https://dl.google.com/android/repository/build-tools_r35_windows.zip'
    if ($officialUrl -ne $Lock.androidBuildTools.packageUrl -or
        $shaMatch.Groups['value'].Value.ToUpperInvariant() -ne $Lock.androidBuildTools.officialSha1.ToUpperInvariant() -or
        [long]$sizeMatch.Groups['value'].Value -ne [long]$Lock.androidBuildTools.archiveSize) {
        throw 'Google repository metadata does not match the locked Windows Build Tools package'
    }
}

function Ensure-AndroidBuildTools {
    Assert-OfficialBuildToolsMetadata
    New-Item -ItemType Directory -Path $DownloadsRoot -Force | Out-Null
    if (-not (Test-Path -LiteralPath $ArchivePath)) {
        Invoke-WebRequest -Uri $Lock.androidBuildTools.packageUrl -OutFile $ArchivePath
    }
    $archiveItem = Get-Item -LiteralPath $ArchivePath
    if ($archiveItem.Length -ne [long]$Lock.androidBuildTools.archiveSize) { throw 'Build Tools archive size does not match Google metadata' }
    $sha1 = (Get-FileHash -LiteralPath $ArchivePath -Algorithm SHA1).Hash.ToUpperInvariant()
    if ($sha1 -ne $Lock.androidBuildTools.officialSha1.ToUpperInvariant()) { throw 'Build Tools archive failed the official SHA-1 check' }
    $sha256 = Get-Sha256 $ArchivePath
    if ($sha256 -ne $Lock.androidBuildTools.archiveSha256.ToUpperInvariant()) { throw 'Build Tools archive SHA-256 does not match toolchain-lock.json' }
    $zipalign = Join-Path $BuildToolsRoot 'zipalign.exe'
    $apksigner = Join-Path $BuildToolsRoot 'lib/apksigner.jar'
    $d8 = Join-Path $BuildToolsRoot 'd8.bat'
    $aapt = Join-Path $BuildToolsRoot 'aapt.exe'
    if (-not (Test-Path -LiteralPath $zipalign) -or -not (Test-Path -LiteralPath $apksigner) -or -not (Test-Path -LiteralPath $d8) -or -not (Test-Path -LiteralPath $aapt)) {
        $stage = Join-Path $CacheRoot 'toolchain/android-build-tools-35.0.0-stage'
        if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
        New-Item -ItemType Directory -Path $stage -Force | Out-Null
        Expand-Archive -LiteralPath $ArchivePath -DestinationPath $stage -Force
        $extracted = Join-Path $stage 'android-15'
        if (-not (Test-Path -LiteralPath (Join-Path $extracted 'zipalign.exe'))) { throw 'Build Tools archive has an unexpected directory structure' }
        if (Test-Path -LiteralPath $BuildToolsRoot) { Remove-Item -LiteralPath $BuildToolsRoot -Recurse -Force }
        New-Item -ItemType Directory -Path (Split-Path -Parent $BuildToolsRoot) -Force | Out-Null
        Move-Item -LiteralPath $extracted -Destination $BuildToolsRoot
        Remove-Item -LiteralPath $stage -Recurse -Force
    }
}

function Resolve-Node {
    if ($NodePath) {
        $candidate = [IO.Path]::GetFullPath($NodePath)
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { throw "NodePath does not exist: $NodePath" }
        return $candidate
    }
    $found = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $found) { throw 'Node.js was not found. Pass -NodePath with the node executable.' }
    return $found.Source
}

function Invoke-CandidatePreservationAudit([string]$DecodedPath, [string]$ApkPath, [string]$Purpose, [string]$MetadataPath) {
    $testScript = Join-Path $PSScriptRoot 'test.ps1'
    if (-not (Test-Path -LiteralPath $testScript -PathType Leaf)) { throw 'Candidate preservation test workflow is missing' }
    & $testScript -Suite teaching-preservation -DecodedRoot $DecodedPath `
        -BaselineDecodedRoot (Join-Path $Root 'tools/_cache/slim-v1-decoded') `
        -CandidateApkPath $ApkPath -CandidatePurpose $Purpose -CandidateMetadataPath $MetadataPath -NodePath $Node
    if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { throw 'Candidate teaching-preservation audit failed; candidate is not eligible for release recording' }
}

function Resolve-JavaTools {
    if (-not $JavaHome) {
        $found = Get-Command java.exe -ErrorAction SilentlyContinue
        if (-not $found) { throw 'JDK was not found. Pass -JavaHome with a JDK directory.' }
        $JavaHome = Split-Path -Parent (Split-Path -Parent $found.Source)
    }
    $resolvedHome = [IO.Path]::GetFullPath($JavaHome)
    foreach ($tool in @('java.exe', 'javac.exe', 'jar.exe', 'keytool.exe')) {
        if (-not (Test-Path -LiteralPath (Join-Path $resolvedHome "bin/$tool") -PathType Leaf)) { throw "JDK tool is missing: $tool under $resolvedHome" }
    }
    return $resolvedHome
}

function New-CarrierApk([string]$SourceApk, [string]$DexPath, [string]$CarrierPath) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $source = [IO.Compression.ZipFile]::OpenRead($SourceApk)
    $destination = [IO.Compression.ZipFile]::Open($CarrierPath, [IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($name in @('AndroidManifest.xml', 'resources.arsc')) {
            $entry = $source.GetEntry($name)
            if (-not $entry) { throw "Carrier source is missing $name" }
            $target = $destination.CreateEntry($name, [IO.Compression.CompressionLevel]::NoCompression)
            $inputStream = $entry.Open()
            $outputStream = $target.Open()
            try { $inputStream.CopyTo($outputStream) } finally { $outputStream.Dispose(); $inputStream.Dispose() }
        }
        $dexEntry = $destination.CreateEntry('classes.dex', [IO.Compression.CompressionLevel]::NoCompression)
        $inputDex = [IO.File]::OpenRead($DexPath)
        $outputDex = $dexEntry.Open()
        try { $inputDex.CopyTo($outputDex) } finally { $outputDex.Dispose(); $inputDex.Dispose() }
    } finally {
        $destination.Dispose()
        $source.Dispose()
    }
}

function Get-ApkBadging([string]$ApkPath, [string]$LogPath) {
    $lines = Invoke-Logged (Join-Path $BuildToolsRoot 'aapt.exe') @('dump', 'badging', $ApkPath) $LogPath
    $packageLine = $lines | Where-Object { $_ -match "^package: name='" } | Select-Object -First 1
    if (-not $packageLine -or $packageLine -notmatch "name='(?<package>[^']+)'\s+versionCode='(?<code>\d+)'\s+versionName='(?<name>[^']*)'") {
        throw "Could not read package metadata from $ApkPath"
    }
    return @{ packageName = $Matches.package; versionCode = [int]$Matches.code; versionName = $Matches.name }
}

function Get-BuildInputSnapshot {
    $runtimeRoot = Join-Path $Root 'runtime/src'
    $runtimeFiles = @(Get-ChildItem -LiteralPath $runtimeRoot -Recurse -Filter '*.java' -File)
    $runtimeRows = @()
    foreach ($file in $runtimeFiles) {
        $relative = [IO.Path]::GetRelativePath($Root, $file.FullName).Replace('\', '/')
        $runtimeRows += "$relative=$((Get-Sha256 $file.FullName))"
    }
    [Array]::Sort($runtimeRows, [StringComparer]::Ordinal)
    $runtimeTreeSha256 = Get-Sha256Text (($runtimeRows -join "`n") + "`n")
    $identitySpecPath = Join-Path $Root 'patches/slim-v1/package-identity-spec.json'
    $testScript = Join-Path $PSScriptRoot 'test.ps1'
    $preservationTest = Join-Path $Root 'tests/teaching-preservation.test.mjs'
    $smaliHelper = Join-Path $Root 'tests/smali-helpers.mjs'
    $inputValues = @{
        baselineApk = Get-Sha256 $BaselineApk
        patchSpec = Get-Sha256 $PatchSpecPath
        packageIdentitySpec = Get-Sha256 $identitySpecPath
        dependencyManifest = Get-Sha256 $dependencyManifestPath
        toolchainLock = Get-Sha256 $LockPath
        patchEngine = Get-Sha256 (Join-Path $PSScriptRoot 'patch.mjs')
        buildScript = Get-Sha256 $PSCommandPath
        testScript = Get-Sha256 $testScript
        signingScript = Get-Sha256 $SigningScript
        signingInput = Get-Sha256 (Join-Path $PSScriptRoot 'signing-input.ps1')
        preservationTest = Get-Sha256 $preservationTest
        smaliHelper = Get-Sha256 $smaliHelper
        runtimeSourceTree = $runtimeTreeSha256
        apktoolJar = Get-Sha256 $ApktoolJar
        apktoolFramework = Get-Sha256 (Join-Path $Root $Lock.apktool.framework.path)
        zipalign = Get-Sha256 (Join-Path $BuildToolsRoot 'zipalign.exe')
        aapt = Get-Sha256 (Join-Path $BuildToolsRoot 'aapt.exe')
        d8 = Get-Sha256 (Join-Path $BuildToolsRoot 'd8.bat')
        apksigner = Get-Sha256 (Join-Path $BuildToolsRoot 'lib/apksigner.jar')
        java = Get-Sha256 (Join-Path $ResolvedJavaHome 'bin/java.exe')
        javac = Get-Sha256 (Join-Path $ResolvedJavaHome 'bin/javac.exe')
    }
    $ordered = [ordered]@{}
    foreach ($name in @($inputValues.Keys | Sort-Object)) { $ordered[$name] = $inputValues[$name] }
    $json = $ordered | ConvertTo-Json -Compress -Depth 4
    return @{
        inputs = $ordered
        sha256 = Get-Sha256Text $json
        runtimeSourceSha256 = $runtimeTreeSha256
        toolPaths = [ordered]@{ javaHome = [IO.Path]::GetFullPath($ResolvedJavaHome); buildToolsRoot = [IO.Path]::GetFullPath($BuildToolsRoot) }
    }
}

function Get-ApkProtectedPayloadHashes([string]$ApkPath) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($ApkPath)
    try {
        $hashes = [ordered]@{}
        foreach ($entry in @($archive.Entries | Where-Object { $_.FullName -match '^classes(?:\d+)?\.dex$' -or $_.FullName -match '^lib/[^/]+/[^/]+\.so$' } | Sort-Object FullName)) {
            $stream = $entry.Open()
            $algorithm = [Security.Cryptography.SHA256]::Create()
            try { $hashes[$entry.FullName] = [Convert]::ToHexString($algorithm.ComputeHash($stream)) }
            finally { $algorithm.Dispose(); $stream.Dispose() }
        }
        if (-not $hashes.Contains('classes.dex')) { throw "APK has no classes.dex entry: $ApkPath" }
        return $hashes
    } finally { $archive.Dispose() }
}

function Write-AtomicJson([string]$Path, $Value) {
    $directory = Split-Path -Parent $Path
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    $temporary = Join-Path $directory (".$([IO.Path]::GetFileName($Path)).$([guid]::NewGuid().ToString('N')).tmp")
    $Value | ConvertTo-Json -Depth 16 | Set-Content -LiteralPath $temporary -Encoding utf8
    Move-Item -LiteralPath $temporary -Destination $Path -Force
}

function Remove-CacheTree([string]$Path) {
    if (-not $Path -or -not (Test-Path -LiteralPath $Path)) { return }
    $fullPath = Assert-WithinPath $Path $CacheRoot 'Build cache cleanup target'
    if (-not (Test-Path -LiteralPath $fullPath -PathType Container)) { [IO.File]::Delete($fullPath); return }
    for ($attempt = 1; ; $attempt++) {
        try { [IO.Directory]::Delete($fullPath, $true); return }
        catch [IO.IOException] { if ($attempt -ge 3) { throw }; Start-Sleep -Milliseconds 500 }
    }
}

function Remove-EmptyCacheParents([string]$Path) {
    $stop = [IO.Path]::GetFullPath($CacheRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
    $current = Split-Path -Parent ([IO.Path]::GetFullPath($Path))
    while ($current.Length -gt $stop.Length -and $current.StartsWith($stop + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -and
        (Test-Path -LiteralPath $current -PathType Container) -and -not (Get-ChildItem -LiteralPath $current -Force | Select-Object -First 1)) {
        [IO.Directory]::Delete($current)
        $current = Split-Path -Parent $current
    }
}

function Invoke-RoundtripPreservationAudit([string]$SourceApk, [string]$StageRoot, [string]$Stage, [string]$CertificateSha256 = $null) {
    $sourceApk = [IO.Path]::GetFullPath($SourceApk)
    $stageRoot = Assert-WithinPath $StageRoot (Join-Path $Root 'tools/_cache') 'Candidate audit stage'
    New-Item -ItemType Directory -Path $stageRoot -Force | Out-Null
    $candidateApk = Join-Path $stageRoot "$releaseName.apk"
    if ([IO.Path]::GetFullPath($candidateApk) -ne $sourceApk) {
        if (Test-Path -LiteralPath $candidateApk) { throw "Audit stage APK already exists: $candidateApk" }
        Copy-Item -LiteralPath $sourceApk -Destination $candidateApk
    }
    $badgingLog = Join-Path $stageRoot 'aapt-badging.log'
    $actual = Get-ApkBadging $candidateApk $badgingLog
    if ($actual.packageName -ne $ApplicationId -or $actual.versionCode -ne $versionCode -or $actual.versionName -ne $releaseName) {
        throw "Actual APK package/version metadata does not match $ApplicationId/$versionCode/$releaseName"
    }
    $decodedRoot = Join-Path $stageRoot 'roundtrip-decoded'
    if (Test-Path -LiteralPath $decodedRoot) { throw "Roundtrip decode target already exists: $decodedRoot" }
    Invoke-Logged $Java @("-Djava.io.tmpdir=$temp", '-jar', $ApktoolJar, 'd', '-f', '-p', $ApktoolCache, '-o', $decodedRoot, $candidateApk) (Join-Path $logs "$Stage-decode-roundtrip.log") | Out-Null
    $inputSnapshot = Get-BuildInputSnapshot
    $metadataPath = Join-Path $stageRoot $(if ($Stage -eq 'pre-sign') { 'pre-sign-metadata.json' } else { 'release-metadata.json' })
    $metadataCandidatePurpose = if ($Stage -eq 'pre-sign') { 'pre-sign' } else { 'release' }
    $metadata = [ordered]@{
        schemaVersion = 3
        stage = $Stage
        success = $false
        candidatePurpose = $metadataCandidatePurpose
        signed = ($Stage -eq 'signed')
        deliverable = $false
        baselineSha256 = $Lock.baseline.sha256
        baselineVersion = $Lock.baseline.versionName
        revision = $Revision
        releaseName = $releaseName
        filename = "$releaseName.apk"
        apkPath = [IO.Path]::GetFullPath($candidateApk)
        apkRelativePath = [IO.Path]::GetRelativePath($Root, $candidateApk)
        decodedRoot = [IO.Path]::GetFullPath($decodedRoot)
        versionName = $actual.versionName
        versionCode = $actual.versionCode
        tagName = $releaseName
        packageName = $actual.packageName
        certificateSha256 = $CertificateSha256
        identityId = if ($Stage -eq 'signed') { $currentSigningIdentity.identityId } else { $null }
        apkSha256 = Get-Sha256 $candidateApk
        patchSpecSha256 = $patchSpecSha256
        identitySpecSha256 = Get-Sha256 (Join-Path $Root 'patches/slim-v1/package-identity-spec.json')
        dependencyManifestSha256 = $dependencyManifestSha256
        methodInventorySha256 = $methodInventorySha256
        normalizationVersion = [int]$dependencyManifest.normalizationVersion
        toolchainLockSha256 = Get-Sha256 $LockPath
        runtimeSourceSha256 = $inputSnapshot.runtimeSourceSha256
        buildInputSha256 = $inputSnapshot.sha256
        inputHashes = $inputSnapshot.inputs
        toolPaths = $inputSnapshot.toolPaths
        protectedPayloadHashes = Get-ApkProtectedPayloadHashes $candidateApk
        patchResultPath = [IO.Path]::GetFullPath((Join-Path $work 'patch-result.json'))
        patchResultSha256 = Get-Sha256 (Join-Path $work 'patch-result.json')
        auditPath = [IO.Path]::GetFullPath((Join-Path $stageRoot 'teaching-preservation-result.json'))
        createdUtc = [DateTime]::UtcNow.ToString('O')
    }
    Write-AtomicJson $metadataPath $metadata
    try {
        Invoke-CandidatePreservationAudit $decodedRoot $candidateApk $metadata.candidatePurpose $metadataPath
        $auditPath = Join-Path $stageRoot 'teaching-preservation-result.json'
        if (-not (Test-Path -LiteralPath $auditPath -PathType Leaf)) { throw 'Candidate preservation test did not write its successful audit JSON' }
        $audit = Get-Content -LiteralPath $auditPath -Raw | ConvertFrom-Json
        if ($audit.schemaVersion -ne 3 -or $audit.success -ne $true -or $audit.stage -ne $Stage -or $audit.candidateApkSha256 -ne $metadata.apkSha256) {
            throw 'Candidate preservation audit JSON does not bind the current stage and APK'
        }
        $metadata.success = $true
        $metadata.preservationAuditSha256 = Get-Sha256 $auditPath
        Write-AtomicJson $metadataPath $metadata
        return @{ apkPath = $candidateApk; decodedRoot = $decodedRoot; metadataPath = $metadataPath; metadata = $metadata; auditPath = $auditPath; audit = $audit }
    } catch {
        $metadata.success = $false
        $metadata.failure = $_.Exception.Message
        Write-AtomicJson $metadataPath $metadata
        throw
    } finally {
        Remove-CacheTree $decodedRoot
    }
}

$buildInputPasswordVariable = 'SLIM_V1_KEYSTORE_PASSWORD'
$buildPreviousPassword = [Environment]::GetEnvironmentVariable($buildInputPasswordVariable, 'Process')
$buildOwnsPassword = $false
$buildSecurePassword = $null
$buildPasswordPointer = [IntPtr]::Zero
$buildPlainPassword = $null
$buildWorkflowLock = $null
try {
if ($ApplicationId -ne 'io.github.wakeupnoads') { throw 'ApplicationId is fixed to io.github.wakeupnoads' }
if ($Revision -lt 1 -or $VersionCode -lt 1) { throw 'Revision and VersionCode must be positive integers' }
$CacheRoot = Assert-WithinPath $CacheRoot (Join-Path $Root 'tools/_cache') 'Build cache'
$Node = Resolve-Node
$ResolvedJavaHome = Resolve-JavaTools
$Java = Join-Path $ResolvedJavaHome 'bin/java.exe'
$Javac = Join-Path $ResolvedJavaHome 'bin/javac.exe'
$Jar = Join-Path $ResolvedJavaHome 'bin/jar.exe'
$Keytool = Join-Path $ResolvedJavaHome 'bin/keytool.exe'
$ApktoolCache = Assert-WithinPath $FrameworkRoot (Join-Path $Root 'tools/_cache') 'Apktool framework cache'

foreach ($localInput in @($BaselineApk, $ApktoolJar, (Join-Path $Root $Lock.apktool.framework.path), $PatchSpecPath,
    (Join-Path $Root 'patches/slim-v1/package-identity-spec.json'), (Join-Path $Root 'patches/slim-v1/teaching-dependencies.json'),
    (Join-Path $PSScriptRoot 'patch.mjs'), (Join-Path $PSScriptRoot 'test.ps1'), (Join-Path $Root 'tests/teaching-preservation.test.mjs'),
    (Join-Path $Root 'tests/smali-helpers.mjs'))) {
    if (-not (Test-Path -LiteralPath $localInput -PathType Leaf)) { throw "Required local build input is missing: $localInput" }
}
if (-not (Test-Path -LiteralPath (Join-Path $Root 'runtime/src') -PathType Container)) { throw 'Required runtime source directory is missing' }

if ($Mode -eq 'ReleaseSigned' -and -not $PrepareOnly) {
    if (-not (Test-Path -LiteralPath $SigningScript -PathType Leaf)) { throw 'Long-term signing workflow is missing; ReleaseSigned will not create or rotate a key' }
    $currentSigningIdentity = Assert-ReleaseSigningPublicState
    $internalFlow = @(Get-PSCallStack | Where-Object { $_.FunctionName -eq 'Invoke-Release' -and $_.ScriptName -and
        [string]::Equals([IO.Path]::GetFullPath($_.ScriptName), [IO.Path]::GetFullPath($SigningScript), [StringComparison]::OrdinalIgnoreCase) }).Count -gt 0
    if ($internalFlow) {
        $password = [Environment]::GetEnvironmentVariable($buildInputPasswordVariable, 'Process')
        if ([string]::IsNullOrEmpty($password)) { throw 'Internal ReleaseSigned call has no validated process password' }
    } else {
        $lockPath = Join-Path $Root 'tools/_signing/signing.lock'
        if ((Test-Path -LiteralPath $lockPath) -and ((Get-Item -LiteralPath $lockPath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Signing workflow lock is a link or reparse point' }
        try { $buildWorkflowLock = [IO.FileStream]::new($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None, 4096, [IO.FileOptions]::DeleteOnClose) }
        catch { throw 'Another signing action holds the exclusive signing lock' }
        $buildOwnsPassword = $true
        [Environment]::SetEnvironmentVariable($buildInputPasswordVariable, $null, 'Process')
        $buildSecurePassword = Read-ReleasePassword
        $buildPasswordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($buildSecurePassword)
        $buildPlainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($buildPasswordPointer)
        [Environment]::SetEnvironmentVariable($buildInputPasswordVariable, $buildPlainPassword, 'Process')
    }
    $global:LASTEXITCODE = 0
    & $SigningScript -Action VerifyIdentity -JavaHome $ResolvedJavaHome -SigningRoot $SigningRoot -BackupRoot (Join-Path $Root 'tools/_signing/wakeup-noads-backup') -Silent
    if ($LASTEXITCODE -ne 0) { throw 'Active/backup release identity or private-key verification failed before the long build' }
    $currentSigningIdentity = Get-Content -LiteralPath (Join-Path $SigningRoot 'signing-identity.json') -Raw | ConvertFrom-Json
    if ($currentSigningIdentity.schemaVersion -ne 2 -or $currentSigningIdentity.identityId -ne $currentSigningIdentity.certificateSha256) { throw 'ReleaseSigned requires the current identity-bound schema2 key metadata' }
}

New-Item -ItemType Directory -Path $CacheRoot -Force | Out-Null
Ensure-AndroidBuildTools

$toolchainLog = Join-Path $CacheRoot 'toolchain-check.json'
$toolchain = & $Node (Join-Path $PSScriptRoot 'toolchain.mjs') $Root $BaselineApk 2>&1
if ($LASTEXITCODE -ne 0) { throw "Toolchain check failed: $toolchain" }
$toolchain | Out-File -LiteralPath $toolchainLog -Encoding utf8
if ((Get-Sha256 $BaselineApk) -ne $Lock.baseline.sha256.ToUpperInvariant()) { throw 'Baseline APK SHA-256 mismatch; stopped before decode' }
if ((Get-Sha256 $ApktoolJar) -ne $Lock.apktool.sha256.ToUpperInvariant()) { throw 'Apktool JAR SHA-256 mismatch' }
if ((Get-Sha256 (Join-Path $Root $Lock.apktool.framework.path)) -ne $Lock.apktool.framework.sha256.ToUpperInvariant()) { throw 'Apktool framework SHA-256 mismatch' }

if ($PrepareOnly) {
    Write-Output "Toolchain ready: Build Tools $($Lock.androidBuildTools.version), Apktool $($Lock.apktool.version), baseline $($Lock.baseline.sha256)"
    return
}

$spec = Get-Content -LiteralPath $PatchSpecPath -Raw | ConvertFrom-Json
if ($spec.operations.Count -eq 0) { throw 'patch-spec.json has no executable operations; refusing to build an unmodified APK' }
$dependencyManifestPath = Join-Path $Root 'patches/slim-v1/teaching-dependencies.json'
$dependencyManifest = Get-Content -LiteralPath $dependencyManifestPath -Raw | ConvertFrom-Json
$patchSpecSha256 = Get-Sha256 $PatchSpecPath
$dependencyManifestSha256 = Get-Sha256 $dependencyManifestPath
$methodInventorySha256 = $dependencyManifest.methodInventorySha256
if (-not $methodInventorySha256) { throw 'Teaching dependency method inventory is missing its digest' }
$versionJson = & $Node (Join-Path $PSScriptRoot 'version.mjs') $Lock.baseline.versionName $Revision 2>&1
if ($LASTEXITCODE -ne 0) { throw "Version naming failed: $versionJson" }
$releaseName = ($versionJson | ConvertFrom-Json).releaseName
$versionCode = [int]$VersionCode
$buildRoot = Join-Path $CacheRoot 'work'
$runId = [guid]::NewGuid().ToString('N')
if ($Mode -eq 'PreSignCheck') {
    $work = Join-Path $CacheRoot "pre-sign/versionCode-$versionCode/$runId"
} else {
    $work = Join-Path $buildRoot $runId
}
$work = Assert-WithinPath $work (Join-Path $Root 'tools/_cache') 'Build work directory'
$decoded = Join-Path $work 'decoded'
$temp = Join-Path $work 'tmp'
$output = Join-Path $work 'output'
$logs = Join-Path $work 'logs'
New-Item -ItemType Directory -Path $temp,$output,$logs -Force | Out-Null
$previousTmp = $env:TEMP
$previousJavaTmp = $env:TMP
$previousAndroidHome = $env:ANDROID_USER_HOME
$previousUserHome = $env:HOME
$buildSucceeded = $false
$publishRoot = $null
try {
    $env:TEMP = $temp
    $env:TMP = $temp
    $env:ANDROID_USER_HOME = Join-Path $work 'android-user'
    $env:HOME = Join-Path $work 'java-home'
    New-Item -ItemType Directory -Path $env:ANDROID_USER_HOME,$env:HOME -Force | Out-Null
    Invoke-Logged $Java @("-Djava.io.tmpdir=$temp", '-jar', $ApktoolJar, 'd', '-f', '-p', $ApktoolCache, '-o', $decoded, $BaselineApk) (Join-Path $logs 'decode-baseline.log') | Out-Null
    $baselineMetadata = Get-Content -LiteralPath (Join-Path $decoded 'apktool.yml') -Raw
    $baselineVersionMatch = [regex]::Match($baselineMetadata, '(?m)^  versionName: (?<value>[^\r\n]+)\r?$')
    if (-not $baselineVersionMatch.Success -or $baselineVersionMatch.Groups['value'].Value -ne $Lock.baseline.versionName) { throw 'freshly decoded baseline version does not match the lock' }
    $patchResult = Invoke-Logged $Node @((Join-Path $PSScriptRoot 'patch.mjs'), $decoded, $BaselineApk, $ApplicationId, "$versionCode", $releaseName) (Join-Path $logs 'patch.log')
    $patchResult | Set-Content -LiteralPath (Join-Path $work 'patch-result.json') -Encoding utf8
    if (-not (Test-Path -LiteralPath (Join-Path $decoded 'apktool.yml'))) { throw 'Decoded baseline does not contain apktool.yml' }

    $runtimeSources = @(Get-ChildItem -LiteralPath (Join-Path $Root 'runtime/src') -Recurse -Filter '*.java' -File)
    if ($runtimeSources.Count -eq 0) { throw 'Runtime Java policy source is missing' }
    $classes = Join-Path $work 'runtime-classes'
    New-Item -ItemType Directory -Path $classes -Force | Out-Null
    $sourceArgs = @('--release', '8', '-Xlint:-options', '-encoding', 'UTF-8', '-d', $classes) + @($runtimeSources | ForEach-Object { $_.FullName })
    Invoke-Logged $Javac $sourceArgs (Join-Path $logs 'javac-runtime.log') | Out-Null
    $runtimeJar = Join-Path $work 'runtime.jar'
    Invoke-Logged $Jar @('cf', $runtimeJar, '-C', $classes, '.') (Join-Path $logs 'jar-runtime.log') | Out-Null
    $runtimeDexDir = Join-Path $work 'runtime-dex'
    New-Item -ItemType Directory -Path $runtimeDexDir -Force | Out-Null
    Invoke-Logged (Join-Path $BuildToolsRoot 'd8.bat') @('--min-api', '24', '--output', $runtimeDexDir, $runtimeJar) (Join-Path $logs 'd8.log') | Out-Null
    $runtimeDex = Join-Path $runtimeDexDir 'classes.dex'
    if (-not (Test-Path -LiteralPath $runtimeDex)) { throw 'd8 did not produce classes.dex' }
    $carrierApk = Join-Path $work 'carrier.apk'
    New-CarrierApk $BaselineApk $runtimeDex $carrierApk
    $helperDecoded = Join-Path $work 'helper-decoded'
    Invoke-Logged $Java @("-Djava.io.tmpdir=$temp", '-jar', $ApktoolJar, 'd', '-f', '-r', '--no-assets', '-p', $ApktoolCache, '-o', $helperDecoded, $carrierApk) (Join-Path $logs 'decode-carrier.log') | Out-Null
    $helperSmali = Join-Path $helperDecoded 'smali'
    if (-not (Test-Path -LiteralPath $helperSmali)) { throw 'Carrier decoding produced no helper smali' }
    $smali8 = Join-Path $decoded 'smali_classes8'
    if (Test-Path -LiteralPath $smali8) { throw 'smali_classes8 already exists in baseline; refusing to overwrite classes' }
    Copy-Item -LiteralPath $helperSmali -Destination $smali8 -Recurse
    $originalDexRoots = @(Get-ChildItem -LiteralPath $decoded -Directory | Where-Object { $_.Name -match '^smali(?:_classes[2-7])?$' })
    $helperClasses = @(Get-ChildItem -LiteralPath $helperSmali -Recurse -Filter '*.smali' -File)
    foreach ($helperClass in $helperClasses) {
        $classHeader = [IO.File]::ReadLines($helperClass.FullName) | Where-Object { $_ -match '^\.class\s' } | Select-Object -First 1
        if (-not $classHeader -or $classHeader -notmatch '^\.class\s+(?:[^\s]+\s+)*(?<descriptor>L[^;]+;)\s*$') {
            throw "Carrier class has no readable class descriptor: $($helperClass.FullName)"
        }
        $descriptorPath = $Matches.descriptor.Substring(1, $Matches.descriptor.Length - 2).Replace('/', [IO.Path]::DirectorySeparatorChar) + '.smali'
        $relativeHelperPath = [IO.Path]::GetRelativePath($helperSmali, $helperClass.FullName)
        if (-not [string]::Equals($descriptorPath, $relativeHelperPath, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Carrier class path does not match its descriptor: $($helperClass.FullName)"
        }
        foreach ($dexRoot in $originalDexRoots) {
            if (Test-Path -LiteralPath (Join-Path $dexRoot.FullName $descriptorPath) -PathType Leaf) {
                throw "New runtime class collides with an original DEX class: $($Matches.descriptor)"
            }
        }
    }

    $unsignedApk = Join-Path $output "$releaseName-unsigned.apk"
    Invoke-Logged $Java @("-Djava.io.tmpdir=$temp", '-jar', $ApktoolJar, 'b', '-p', $ApktoolCache, '-o', $unsignedApk, $decoded) (Join-Path $logs 'apktool-build.log') | Out-Null
    $alignedApk = Join-Path $output "$releaseName-aligned.apk"
    Invoke-Logged (Join-Path $BuildToolsRoot 'zipalign.exe') @('-P', '16', '-f', '-v', '4', $unsignedApk, $alignedApk) (Join-Path $logs 'zipalign.log') | Out-Null
    if ($Mode -eq 'Unsigned') {
        $unsignedOutput = Join-Path $CacheRoot "unsigned/versionCode-$versionCode/$releaseName.apk"
        New-Item -ItemType Directory -Path (Split-Path -Parent $unsignedOutput) -Force | Out-Null
        if (Test-Path -LiteralPath $unsignedOutput) { throw "Unsigned output already exists: $unsignedOutput" }
        Copy-Item -LiteralPath $alignedApk -Destination $unsignedOutput
        Write-Output "Unsigned-only candidate: $unsignedOutput (not deliverable)"
        $buildSucceeded = $true
        return
    }
    if ($Mode -eq 'PreSignCheck') {
        $audit = Invoke-RoundtripPreservationAudit $alignedApk $work 'pre-sign'
        Write-Output "PreSignCheck passed for versionCode $versionCode."
        Write-Output "APK: $($audit.apkPath)"
        Write-Output "Audit: $($audit.auditPath)"
        Write-Output "Pre-sign metadata: $($audit.metadataPath)"
        Write-Output "APK SHA-256: $($audit.metadata.apkSha256)"
        Write-Output "Build input SHA-256: $($audit.metadata.buildInputSha256)"
        $buildSucceeded = $true
        return
    }
    if (-not (Test-Path -LiteralPath $SigningScript)) { throw 'Long-term signing workflow is missing; ReleaseSigned will not generate a replacement key' }

    $preSignStage = Invoke-RoundtripPreservationAudit $alignedApk (Join-Path $work 'pre-sign') 'pre-sign'

    $signedApk = Join-Path $output "$releaseName.apk"
    $apksignerLaunch = @('--enable-native-access=ALL-UNNAMED', '-jar', (Join-Path $BuildToolsRoot 'lib/apksigner.jar'))
    Invoke-Logged $Java ($apksignerLaunch + @('sign', '--ks', (Join-Path $SigningRoot 'release.p12'), '--ks-key-alias', 'wakeup-noads', '--ks-pass', 'env:SLIM_V1_KEYSTORE_PASSWORD', '--key-pass', 'env:SLIM_V1_KEYSTORE_PASSWORD', '--v2-signing-enabled', 'true', '--out', $signedApk, $alignedApk)) (Join-Path $logs 'apksigner-sign.log') | Out-Null
    Invoke-Logged $Java ($apksignerLaunch + @('verify', '--verbose', '--print-certs', $signedApk)) (Join-Path $logs 'apksigner-verify.log') | Out-Null
    Invoke-Logged (Join-Path $BuildToolsRoot 'zipalign.exe') @('-c', '-P', '16', '-v', '4', $signedApk) (Join-Path $logs 'zipalign-check.log') | Out-Null
    $actualApk = Get-ApkBadging $signedApk (Join-Path $logs 'aapt-badging.log')
    if ($actualApk.packageName -ne $ApplicationId -or $actualApk.versionCode -ne $versionCode -or $actualApk.versionName -ne $releaseName) {
        throw 'Signed APK metadata does not match the fixed package/version naming contract'
    }
    $certificateLine = (Get-Content -LiteralPath (Join-Path $logs 'apksigner-verify.log') | Where-Object { $_ -match 'Signer #1 certificate SHA-256 digest:' } | Select-Object -First 1)
    if (-not $certificateLine) { throw 'apksigner did not report a signer certificate digest' }
    $certificateSha256 = ($certificateLine -split ':', 2)[1].Trim().Replace(':', '').ToUpperInvariant()
    $signedStage = Invoke-RoundtripPreservationAudit $signedApk (Join-Path $work 'signed-stage') 'signed' $certificateSha256
    if ($signedStage.metadata.buildInputSha256 -ne $preSignStage.metadata.buildInputSha256 -or
        ($signedStage.metadata.inputHashes | ConvertTo-Json -Compress -Depth 4) -cne ($preSignStage.metadata.inputHashes | ConvertTo-Json -Compress -Depth 4)) {
        throw 'Build inputs changed between the pre-sign and signed preservation audits'
    }
    $signedPayloadHashes = Get-ApkProtectedPayloadHashes $signedApk
    if (($signedPayloadHashes | ConvertTo-Json -Compress -Depth 4) -cne ($preSignStage.metadata.protectedPayloadHashes | ConvertTo-Json -Compress -Depth 4)) {
        throw 'APK DEX or native payload entries changed during signing'
    }
    $candidateRoot = Assert-WithinPath (Join-Path $CacheRoot "candidates/versionCode-$versionCode") (Join-Path $Root 'tools/_cache') 'Candidate output'
    $candidateOutput = Assert-WithinPath (Join-Path $CacheRoot "output/versionCode-$versionCode/$releaseName.apk") (Join-Path $Root 'tools/_cache') 'Release output'
    $candidateMetadataPath = Join-Path $candidateRoot 'release-metadata.json'
    $readyPath = Join-Path $candidateRoot 'ready.json'
    $candidateApkPath = Join-Path $candidateRoot "$releaseName.apk"
    if ((Test-Path -LiteralPath $candidateRoot) -or (Test-Path -LiteralPath $candidateOutput)) {
        if (-not (Test-Path -LiteralPath $candidateRoot -PathType Container) -or
            -not (Test-Path -LiteralPath $candidateOutput -PathType Leaf) -or
            -not (Test-Path -LiteralPath $candidateMetadataPath -PathType Leaf) -or
            -not (Test-Path -LiteralPath $readyPath -PathType Leaf) -or
            -not (Test-Path -LiteralPath $candidateApkPath -PathType Leaf)) {
            throw 'Existing candidate is incomplete or has no current ready evidence; refusing reuse or overwrite'
        }
        $existing = Get-Content -LiteralPath $candidateMetadataPath -Raw | ConvertFrom-Json
        $existingReady = Get-Content -LiteralPath $readyPath -Raw | ConvertFrom-Json
        $signedHash = Get-Sha256 $signedApk
        if ($existing.schemaVersion -ne 3 -or $existing.stage -ne 'signed' -or $existing.success -ne $true -or
            $existingReady.schemaVersion -ne 1 -or $existingReady.ready -ne $true -or $existingReady.success -ne $true -or
            $existing.buildInputSha256 -ne $signedStage.metadata.buildInputSha256 -or
            $existingReady.buildInputSha256 -ne $signedStage.metadata.buildInputSha256 -or
            $existing.apkSha256 -ne $signedHash -or $existingReady.apkSha256 -ne $signedHash -or
            (Get-Sha256 $candidateApkPath) -ne $signedHash -or (Get-Sha256 $candidateOutput) -ne $signedHash -or
            $existing.certificateSha256 -ne $certificateSha256 -or
            $existing.identityId -ne $currentSigningIdentity.identityId -or $existingReady.identityId -ne $currentSigningIdentity.identityId -or
            $existingReady.releaseMetadataSha256 -ne (Get-Sha256 $candidateMetadataPath) -or
            $existingReady.auditSha256 -ne (Get-Sha256 (Join-Path $candidateRoot 'teaching-preservation-result.json'))) {
            throw 'Existing candidate evidence is stale or unrelated to this signed build; refusing reuse'
        }
        & $SigningScript -Action RecordRelease -ApkPath $candidateOutput -MetadataPath $candidateMetadataPath -PreservationEvidencePath $readyPath -JavaHome $ResolvedJavaHome -Silent
        if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { throw 'Existing candidate release-history recording failed' }
        Write-Output "Existing ready candidate verified and recorded: $candidateOutput"
        $buildSucceeded = $true
        return
    }

    $publishRoot = Join-Path $CacheRoot "staging/versionCode-$versionCode/$runId"
    $publishRoot = Assert-WithinPath $publishRoot (Join-Path $Root 'tools/_cache') 'Candidate publish stage'
    $publishCandidate = Join-Path $publishRoot 'candidate'
    $publishOutput = Join-Path $publishRoot 'output'
    New-Item -ItemType Directory -Path $publishCandidate,$publishOutput -Force | Out-Null
    $signedHash = Get-Sha256 $signedStage.apkPath
    Copy-Item -LiteralPath $signedStage.apkPath -Destination (Join-Path $publishCandidate "$releaseName.apk")
    Copy-Item -LiteralPath $signedStage.apkPath -Destination (Join-Path $publishOutput "$releaseName.apk")
    Copy-Item -LiteralPath (Join-Path $work 'patch-result.json') -Destination (Join-Path $publishCandidate 'patch-result.json')
    Copy-Item -LiteralPath $signedStage.auditPath -Destination (Join-Path $publishCandidate 'teaching-preservation-result.json')
    $metadata = $signedStage.metadata
    $metadata.apkPath = [IO.Path]::GetFullPath($candidateOutput)
    $metadata.apkRelativePath = [IO.Path]::GetRelativePath($Root, $candidateOutput)
    $metadata.candidateApkPath = [IO.Path]::GetFullPath($candidateApkPath)
    $metadata.auditPath = [IO.Path]::GetFullPath((Join-Path $candidateRoot 'teaching-preservation-result.json'))
    $metadata.stageAuditApkPath = [IO.Path]::GetFullPath($signedStage.apkPath)
    $metadata.stageAuditDecodedRoot = [IO.Path]::GetFullPath($signedStage.decodedRoot)
    $metadata.releaseName = $releaseName
    $metadata.filename = "$releaseName.apk"
    $metadata.tagName = $releaseName
    $metadata.deliverable = $false
    Write-AtomicJson (Join-Path $publishCandidate 'release-metadata.json') $metadata
    if ((Get-Sha256 (Join-Path $publishCandidate "$releaseName.apk")) -ne $signedHash -or
        (Get-Sha256 (Join-Path $publishOutput "$releaseName.apk")) -ne $signedHash) {
        throw 'Staged candidate and output APK hashes differ after successful preservation audit'
    }
    $outputParent = Split-Path -Parent $candidateOutput
    New-Item -ItemType Directory -Path $outputParent -Force | Out-Null
    if ((Test-Path -LiteralPath $candidateRoot) -or (Test-Path -LiteralPath $candidateOutput)) { throw 'Candidate destination appeared during staged publication' }
    Move-Item -LiteralPath $publishCandidate -Destination $candidateRoot
    Move-Item -LiteralPath (Join-Path $publishOutput "$releaseName.apk") -Destination $candidateOutput
    $finalAuditPath = Join-Path $candidateRoot 'teaching-preservation-result.json'
    $metadata.auditPath = [IO.Path]::GetFullPath($finalAuditPath)
    $metadata.deliverable = $true
    Write-AtomicJson $candidateMetadataPath $metadata
    $ready = [ordered]@{
        schemaVersion = 1
        ready = $true
        success = $true
        stage = 'signed'
        packageName = $actualApk.packageName
        versionCode = $actualApk.versionCode
        versionName = $actualApk.versionName
        releaseName = $releaseName
        certificateSha256 = $certificateSha256
        identityId = $signedStage.metadata.identityId
        apkSha256 = $signedHash
        candidateApkPath = [IO.Path]::GetFullPath($candidateApkPath)
        outputApkPath = [IO.Path]::GetFullPath($candidateOutput)
        releaseMetadataPath = [IO.Path]::GetFullPath($candidateMetadataPath)
        releaseMetadataSha256 = Get-Sha256 $candidateMetadataPath
        auditPath = [IO.Path]::GetFullPath($finalAuditPath)
        auditSha256 = Get-Sha256 $finalAuditPath
        auditStageApkPath = [IO.Path]::GetFullPath($signedStage.apkPath)
        auditStageDecodedRoot = [IO.Path]::GetFullPath($signedStage.decodedRoot)
        patchResultPath = [IO.Path]::GetFullPath((Join-Path $candidateRoot 'patch-result.json'))
        patchResultSha256 = Get-Sha256 (Join-Path $candidateRoot 'patch-result.json')
        protectedDecodedInventorySha256 = $signedStage.audit.protectedDecodedInventorySha256
        protectedPayloadHashes = $signedPayloadHashes
        baselineSha256 = $Lock.baseline.sha256
        patchSpecSha256 = $patchSpecSha256
        identitySpecSha256 = $metadata.identitySpecSha256
        dependencyManifestSha256 = $dependencyManifestSha256
        methodInventorySha256 = $methodInventorySha256
        normalizationVersion = [int]$dependencyManifest.normalizationVersion
        toolchainLockSha256 = Get-Sha256 $LockPath
        runtimeSourceSha256 = $metadata.runtimeSourceSha256
        buildInputSha256 = $metadata.buildInputSha256
        createdUtc = [DateTime]::UtcNow.ToString('O')
    }
    Write-AtomicJson $readyPath $ready
    $indexPath = Join-Path $CacheRoot 'release-metadata.json'
    $index = [ordered]@{ candidate = "candidates/versionCode-$versionCode/release-metadata.json"; ready = "candidates/versionCode-$versionCode/ready.json"; versionCode = $versionCode; releaseName = $releaseName; apkSha256 = $signedHash }
    Write-AtomicJson $indexPath $index
    & $SigningScript -Action RecordRelease -ApkPath $candidateOutput -MetadataPath $candidateMetadataPath -PreservationEvidencePath $readyPath -JavaHome $ResolvedJavaHome -Silent
    if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { throw 'Release history recording failed' }
    Write-Output "ReleaseSigned candidate: $candidateOutput"
    Write-Output "SHA-256: $signedHash"
    Write-Output "Package/version: $($actualApk.packageName) $($actualApk.versionCode) $($actualApk.versionName)"
    Write-Output "Certificate SHA-256: $certificateSha256"
    Write-Output "Ready evidence: $readyPath"
    $buildSucceeded = $true
} finally {
    $env:TEMP = $previousTmp
    $env:TMP = $previousJavaTmp
    $env:ANDROID_USER_HOME = $previousAndroidHome
    $env:HOME = $previousUserHome
    if ($publishRoot) {
        Remove-CacheTree $publishRoot
        Remove-EmptyCacheParents $publishRoot
    }
    if ($buildSucceeded -and $Mode -ne 'PreSignCheck') {
        Remove-CacheTree $work
        Remove-EmptyCacheParents $work
    } else {
        # PreSignCheck keeps its stage APK, JSON and logs for Release, which removes them after validation; failures keep only logs and JSON.
        foreach ($heavy in @('decoded', 'helper-decoded', 'tmp', 'runtime-classes', 'runtime-dex', 'runtime.jar', 'carrier.apk', 'output', 'android-user', 'java-home', 'roundtrip-decoded', 'pre-sign/roundtrip-decoded', 'signed-stage/roundtrip-decoded')) {
            Remove-CacheTree (Join-Path $work $heavy)
        }
    }
}
} finally {
    if ($buildWorkflowLock) { $buildWorkflowLock.Dispose() }
    if ($buildOwnsPassword) { [Environment]::SetEnvironmentVariable($buildInputPasswordVariable, $buildPreviousPassword, 'Process') }
    if ($buildPasswordPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($buildPasswordPointer) }
    if ($buildSecurePassword) { $buildSecurePassword.Dispose() }
    $buildPlainPassword = $null
    $buildPreviousPassword = $null
}
