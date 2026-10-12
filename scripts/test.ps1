[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('patch-engine', 'toolchain', 'ad-switches', 'startup', 'hybrid', 'navigation', 'import-routes', 'export-routes', 'mine', 'offline-features', 'import-privacy', 'runtime', 'network-adapter', 'manifest', 'package-identity', 'teaching-preservation', 'signing', 'signing-input', 'version-naming', 'version-display', 'teaching-dependencies', 'teaching-bootstrap', 'All')]
    [string]$Suite,
    [string]$DecodedRoot,
    [string]$BaselineDecodedRoot,
    [string]$CandidateApkPath,
    [ValidateSet('release', 'unsigned', 'pre-sign')]
    [string]$CandidatePurpose = 'release',
    [string]$CandidateMetadataPath,
    [string]$NodePath,
    [string]$JavaHome
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$TestsRoot = Join-Path $Root 'tests'
$CacheRoot = Join-Path $Root 'tools/_cache/slim-v1-build/test-runs'

function Resolve-Executable([string]$ExplicitPath, [string]$Name) {
    if ($ExplicitPath) {
        $full = [IO.Path]::GetFullPath($ExplicitPath)
        if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { throw "$Name path does not exist: $ExplicitPath" }
        return $full
    }
    $command = Get-Command "$Name.exe" -ErrorAction SilentlyContinue
    if (-not $command) { throw "$Name was not found; pass an explicit project-local tool path." }
    return $command.Source
}

function Assert-TestRoot([string]$Path, [string]$Label) {
    if (-not $Path) { return $null }
    $full = [IO.Path]::GetFullPath($Path)
    if (-not (Test-Path -LiteralPath $full -PathType Container)) { throw "$Label does not exist: $Path" }
    $cache = [IO.Path]::GetFullPath((Join-Path $Root 'tools/_cache')).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if (-not $full.StartsWith($cache, [StringComparison]::OrdinalIgnoreCase)) { throw "$Label must be inside tools/_cache: $Path" }
    return $full
}

function Assert-TestArtifact([string]$Path, [string]$Label) {
    if (-not $Path) { return $null }
    $full = [IO.Path]::GetFullPath($Path)
    if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { throw "$Label does not exist: $Path" }
    $cache = [IO.Path]::GetFullPath((Join-Path $Root 'tools/_cache')).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if (-not $full.StartsWith($cache, [StringComparison]::OrdinalIgnoreCase)) { throw "$Label must be inside tools/_cache: $Path" }
    return $full
}

$Node = Resolve-Executable $NodePath 'node'
# Built candidates keep no decoded tree; without -DecodedRoot the bound APK is decoded into its metadata decodedRoot for this run only.
$decodeCandidate = (-not $DecodedRoot) -and $CandidateMetadataPath -and ($Suite -eq 'teaching-preservation' -or $Suite -eq 'All')
$ResolvedJavaHome = $null
if ($decodeCandidate -or $Suite -eq 'runtime' -or $Suite -eq 'teaching-bootstrap' -or $Suite -eq 'network-adapter' -or $Suite -eq 'All') {
    if ($JavaHome) {
        $ResolvedJavaHome = [IO.Path]::GetFullPath($JavaHome)
    } else {
        $javacCommand = Get-Command javac.exe -ErrorAction SilentlyContinue
        if (-not $javacCommand) { throw 'javac was not found; pass -JavaHome with a local JDK.' }
        $ResolvedJavaHome = Split-Path -Parent (Split-Path -Parent $javacCommand.Source)
    }
    foreach ($tool in @('javac.exe', 'java.exe')) {
        if (-not (Test-Path -LiteralPath (Join-Path $ResolvedJavaHome "bin/$tool") -PathType Leaf)) { throw "JDK tool is missing: $tool under $ResolvedJavaHome" }
    }
}

$DecodedRoot = Assert-TestRoot $DecodedRoot 'DecodedRoot'
$BaselineDecodedRoot = Assert-TestRoot $BaselineDecodedRoot 'BaselineDecodedRoot'
$CandidateApkPath = Assert-TestArtifact $CandidateApkPath 'CandidateApkPath'
$CandidateMetadataPath = Assert-TestArtifact $CandidateMetadataPath 'CandidateMetadataPath'
$transientRoot = $null
if ($decodeCandidate) {
    $candidateMetadata = Get-Content -LiteralPath $CandidateMetadataPath -Raw | ConvertFrom-Json
    $decodeSource = if ($CandidateApkPath) { $CandidateApkPath } else { Assert-TestArtifact $candidateMetadata.apkPath 'Candidate metadata apkPath' }
    $decodeTarget = [IO.Path]::GetFullPath($candidateMetadata.decodedRoot)
    $buildCache = [IO.Path]::GetFullPath((Join-Path $Root 'tools/_cache/slim-v1-build')).TrimEnd([IO.Path]::DirectorySeparatorChar)
    if (-not $decodeTarget.StartsWith($buildCache + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw "Candidate decodedRoot must be inside tools/_cache/slim-v1-build: $decodeTarget" }
    if (Test-Path -LiteralPath $decodeTarget) { throw "Candidate decodedRoot already exists; pass it as -DecodedRoot instead: $decodeTarget" }
    # Remove everything this run creates, including missing parent stage directories that receive the audit JSON.
    $transientRoot = $decodeTarget
    while (-not (Test-Path -LiteralPath (Split-Path -Parent $transientRoot))) { $transientRoot = Split-Path -Parent $transientRoot }
    $DecodedRoot = $decodeTarget
}
$oldDecodedRoot = $env:SLIM_VERIFIED_DECODED_ROOT
$oldBaselineRoot = $env:SLIM_BASELINE_DECODED_ROOT
$oldCandidateApk = $env:SLIM_CANDIDATE_APK_PATH
$oldCandidatePurpose = $env:SLIM_CANDIDATE_PURPOSE
$oldCandidateMetadataPath = $env:SLIM_CANDIDATE_METADATA_PATH
$runRoot = $null
# Node suites resolve project files relative to the repository root.
Push-Location -LiteralPath $Root
try {
    if ($decodeCandidate) {
        New-Item -ItemType Directory -Path $CacheRoot -Force | Out-Null
        $runRoot = Join-Path $CacheRoot ([guid]::NewGuid().ToString('N'))
        $decodeTemp = Join-Path $runRoot 'tmp'
        New-Item -ItemType Directory -Path $decodeTemp -Force | Out-Null
        $toolchainLock = Get-Content -LiteralPath (Join-Path $Root 'patches/slim-v1/toolchain-lock.json') -Raw | ConvertFrom-Json
        $decodeOutput = & (Join-Path $ResolvedJavaHome 'bin/java.exe') "-Djava.io.tmpdir=$decodeTemp" '-jar' (Join-Path $Root $toolchainLock.apktool.path) 'd' '-f' '-p' (Join-Path $Root 'tools/_cache/apktool') '-o' $DecodedRoot $decodeSource 2>&1
        if ($LASTEXITCODE -ne 0) { $decodeOutput | Write-Output; throw "Candidate decode failed with exit code $LASTEXITCODE." }
    }
    if ($DecodedRoot) { $env:SLIM_VERIFIED_DECODED_ROOT = $DecodedRoot }
    if ($BaselineDecodedRoot) { $env:SLIM_BASELINE_DECODED_ROOT = $BaselineDecodedRoot }
    if ($CandidateApkPath) { $env:SLIM_CANDIDATE_APK_PATH = $CandidateApkPath }
    if ($CandidateMetadataPath) { $env:SLIM_CANDIDATE_METADATA_PATH = $CandidateMetadataPath }
    $env:SLIM_CANDIDATE_PURPOSE = $CandidatePurpose

    $files = @()
    if ($Suite -eq 'All') {
        $requiredSuites = @('patch-engine', 'toolchain', 'ad-switches', 'startup', 'hybrid', 'navigation', 'import-routes', 'export-routes', 'mine', 'offline-features', 'import-privacy', 'network-adapter', 'manifest', 'package-identity', 'teaching-preservation', 'signing', 'signing-input', 'version-naming', 'version-display', 'teaching-dependencies', 'teaching-bootstrap')
        $missingSuites = @($requiredSuites | Where-Object { $testPath = Join-Path $TestsRoot ($_.ToString() + '.test.mjs'); -not (Test-Path -LiteralPath $testPath -PathType Leaf) })
        if ($missingSuites.Count -gt 0) { throw "All suite is incomplete; missing: $($missingSuites -join ', ')" }
        $files = @(Get-ChildItem -LiteralPath $TestsRoot -Filter '*.test.mjs' -File -Recurse | ForEach-Object { $_.FullName })
        if ($files.Count -eq 0) { throw 'No Node test files were found.' }
    } else {
        $testFile = Join-Path $TestsRoot "$Suite.test.mjs"
        if (Test-Path -LiteralPath $testFile -PathType Leaf) { $files += $testFile }
        $aliases = @{
            'patch-engine' = @('patch-engine')
            'ad-switches' = @('ad-switches')
            'package-identity' = @('package-identity')
            'signing' = @('signing-input')
            'version-naming' = @('version-naming')
            'teaching-dependencies' = @('teaching-dependencies')
            'teaching-bootstrap' = @('teaching-bootstrap')
            'toolchain' = @('toolchain')
        }
        foreach ($alias in $aliases[$Suite]) {
            $candidate = Join-Path $TestsRoot "$alias.test.mjs"
            if ((Test-Path -LiteralPath $candidate -PathType Leaf) -and $candidate -notin $files) { $files += $candidate }
        }
        if ($files.Count -eq 0 -and $Suite -notin @('runtime', 'network-adapter')) { throw "No test implementation exists yet for suite '$Suite'." }
    }

    if ($files.Count -gt 0) {
        & $Node '--test' @files
        if ($LASTEXITCODE -ne 0) { throw "Node suite '$Suite' failed with exit code $LASTEXITCODE." }
    }

    if ($Suite -eq 'runtime' -or $Suite -eq 'teaching-bootstrap' -or $Suite -eq 'network-adapter' -or $Suite -eq 'All') {
        if (-not $runRoot) {
            New-Item -ItemType Directory -Path $CacheRoot -Force | Out-Null
            $runRoot = Join-Path $CacheRoot ([guid]::NewGuid().ToString('N'))
            New-Item -ItemType Directory -Path $runRoot -Force | Out-Null
        }
        $classes = Join-Path $runRoot 'classes'
        New-Item -ItemType Directory -Path $classes -Force | Out-Null
        $javac = Join-Path $ResolvedJavaHome 'bin/javac.exe'
        $java = Join-Path $ResolvedJavaHome 'bin/java.exe'
        $sources = @(Get-ChildItem -LiteralPath (Join-Path $Root 'runtime/src'),(Join-Path $TestsRoot 'runtime') -Recurse -Filter '*.java' -File | ForEach-Object { $_.FullName })
        if ($sources.Count -eq 0) { throw 'No Java runtime or test sources were found.' }
        & $javac '--release' '8' '-Xlint:-options' '-encoding' 'UTF-8' '-d' $classes @sources
        if ($LASTEXITCODE -ne 0) { throw "Java test compilation failed with exit code $LASTEXITCODE." }
        foreach ($main in @('SlimNetworkPolicyTest', 'TeachingBootstrapTest', 'NetworkAdapterTest', 'Rc4PoolLifecycleTest')) {
            & $java '-cp' $classes "com.suda.yzune.wakeupschedule.slim.$main"
            if ($LASTEXITCODE -ne 0) { throw "Java test '$main' failed with exit code $LASTEXITCODE." }
        }
    }

    if ($files.Count -eq 0 -and $Suite -eq 'runtime') { Write-Output 'Java runtime suites passed.' }
} finally {
    Pop-Location
    if ($transientRoot -and (Test-Path -LiteralPath $transientRoot)) { [IO.Directory]::Delete($transientRoot, $true) }
    if ($runRoot -and (Test-Path -LiteralPath $runRoot)) { [IO.Directory]::Delete($runRoot, $true) }
    if ((Test-Path -LiteralPath $CacheRoot) -and -not (Get-ChildItem -LiteralPath $CacheRoot -Force | Select-Object -First 1)) { Remove-Item -LiteralPath $CacheRoot -Force }
    if ($null -eq $oldDecodedRoot) { Remove-Item Env:SLIM_VERIFIED_DECODED_ROOT -ErrorAction SilentlyContinue } else { $env:SLIM_VERIFIED_DECODED_ROOT = $oldDecodedRoot }
    if ($null -eq $oldBaselineRoot) { Remove-Item Env:SLIM_BASELINE_DECODED_ROOT -ErrorAction SilentlyContinue } else { $env:SLIM_BASELINE_DECODED_ROOT = $oldBaselineRoot }
    if ($null -eq $oldCandidateApk) { Remove-Item Env:SLIM_CANDIDATE_APK_PATH -ErrorAction SilentlyContinue } else { $env:SLIM_CANDIDATE_APK_PATH = $oldCandidateApk }
    if ($null -eq $oldCandidatePurpose) { Remove-Item Env:SLIM_CANDIDATE_PURPOSE -ErrorAction SilentlyContinue } else { $env:SLIM_CANDIDATE_PURPOSE = $oldCandidatePurpose }
    if ($null -eq $oldCandidateMetadataPath) { Remove-Item Env:SLIM_CANDIDATE_METADATA_PATH -ErrorAction SilentlyContinue } else { $env:SLIM_CANDIDATE_METADATA_PATH = $oldCandidateMetadataPath }
}
