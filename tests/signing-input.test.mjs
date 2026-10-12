import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const inputScript = path.resolve('scripts/signing-input.ps1');
const source = await readFile(inputScript, 'utf8');
const fixtureCache = path.resolve('tools/_cache/slim-v1-signing-input-tests');
// Per-test roots are removed by each test; drop the shared root once it is empty.
after(() => rmdir(fixtureCache).catch(() => {}));

function runnerScript() {
  return String.raw`
param([string]$InputScript,[string]$Mode)
$ErrorActionPreference='Stop'
. $InputScript
$script:queued=[Collections.Queue]::new()
$script:future=[Collections.Queue]::new()
$script:prompted=$false
$script:promptCount=0
$script:status=@()
$script:emitted=@()
$script:controlC=($Mode -eq 'controltrue')
$script:originalControlC=$script:controlC
function Add-Key([string]$Name,[char]$Character,[bool]$Control=$false){$script:future.Enqueue([ConsoleKeyInfo]::new($Character,[ConsoleKey]$Name,$false,$false,$Control))}
switch($Mode){
  'empty' { Add-Key 'Enter' ([char]0); foreach($c in 'ABCDEF'.ToCharArray()){Add-Key 'A' $c};Add-Key 'Enter' ([char]0) }
  'backspace' { foreach($c in 'ABCDEF'.ToCharArray()){Add-Key 'A' $c};Add-Key 'Backspace' ([char]8);Add-Key 'Z' 'Z';Add-Key 'Enter' ([char]0) }
  'minimum' { foreach($c in 'ABCDE'.ToCharArray()){Add-Key 'A' $c};Add-Key 'Enter' ([char]0);Add-Key 'F' 'F';Add-Key 'Enter' ([char]0) }
  'cancel' { Add-Key 'Escape' ([char]27) }
  'controlc' { Add-Key 'C' ([char]3) $true }
  'controlz' { Add-Key 'Z' ([char]26) $true }
  'controld' { Add-Key 'D' ([char]4) $true }
  'eof' { }
  'readfail' { }
  default { Add-Key 'F1' ([char]0);foreach($c in 'ABCDEF'.ToCharArray()){Add-Key 'A' $c};Add-Key 'Enter' ([char]0) }
}
if($Mode -in @('queued','empty','backspace','minimum')){Add-Key 'Enter' ([char]0);Add-Key 'X' 'X'}
if($Mode -eq 'queued'){$script:queued.Enqueue([ConsoleKeyInfo]::new([char]0,[ConsoleKey]::Enter,$false,$false,$false));$script:queued.Enqueue([ConsoleKeyInfo]::new('Q',[ConsoleKey]::Q,$false,$false,$false))}
$adapter=@{
 isInputRedirected={ $false }
 getControlCAsInput={ $script:controlC }
 setControlCAsInput={param($Value)$script:controlC=[bool]$Value;if($Mode -eq 'controlfail' -and $Value){throw 'private-test-sentinel'}}
 keyAvailable={if($Mode -eq 'clearfail' -or ($Mode -eq 'postclearfail' -and $script:prompted -and $script:future.Count -eq 0)){throw 'private-test-sentinel'};if($script:prompted){$script:future.Count -gt 0}else{$script:queued.Count -gt 0}}
 writePrompt={param($Text)$script:promptCount++;$script:prompted=$true;$script:emitted+=@($Text)}
 writeStatus={param($Text)$script:status+=@($Text);$script:emitted+=@($Text)}
 readKey={
   if(-not $script:prompted){return $script:queued.Dequeue()}
   if($Mode -eq 'readfail'){throw 'private-test-sentinel'}
   if($Mode -eq 'eof'){return $null}
   if($script:future.Count -eq 0){throw 'private-test-sentinel'}
   $script:future.Dequeue()
 }
}
$failed=$false;$message='';$length=-1
try{$secure=Read-ReleasePasswordCore -InputAdapter $adapter -MinimumLength 6 -Prompt 'New release keystore password: ';$length=$secure.Length;$secure.Dispose()}
catch{$failed=$true;$message=$_.Exception.Message}
$text=$script:emitted -join ''
$summary=[ordered]@{failed=$failed;message=$message;length=$length;queuedRemaining=$script:queued.Count;futureRemaining=$script:future.Count;promptCount=$script:promptCount;statusCount=$script:status.Count;controlCRestored=($script:controlC -eq $script:originalControlC);secretWasEchoed=($text.Contains('ABCDEF') -or $text.Contains('ABCDEZ'))}
$summary|ConvertTo-Json -Compress
`;
}

async function invokeReader(t, mode) {
  await mkdir(fixtureCache, { recursive: true });
  const root = await mkdtemp(path.join(fixtureCache, 'reader-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runner = path.join(root, 'reader.ps1');
  await writeFile(runner, runnerScript(), 'utf8');
  const result = spawnSync('pwsh.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', runner, inputScript, mode], {
    encoding: 'utf8', timeout: 30000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
}

test('secure reader drops queued keys, holds blank Enter, handles backspace, and enforces a new-key minimum', async (t) => {
  for (const mode of ['queued', 'empty', 'backspace', 'minimum', 'controltrue']) {
    const result = await invokeReader(t, mode);
    assert.equal(result.failed, false, result.message);
    assert.equal(result.length, 6);
    assert.equal(result.promptCount, 1);
    assert.equal(result.controlCRestored, true);
    assert.equal(result.secretWasEchoed, false);
    assert.equal(result.queuedRemaining, 0);
    assert.equal(result.futureRemaining, 0);
  }
  assert.equal((await invokeReader(t, 'empty')).statusCount, 0);
  assert.equal((await invokeReader(t, 'minimum')).statusCount, 1);
});

test('secure reader cancels and fails closed on EOF, redirected input, or read errors', async (t) => {
  for (const mode of ['cancel', 'controlc', 'controlz', 'controld', 'eof', 'readfail', 'clearfail', 'postclearfail', 'controlfail']) {
    const result = await invokeReader(t, mode);
    assert.equal(result.failed, true);
    assert.match(result.message, /Secure password input/i);
    assert.doesNotMatch(result.message, /private-test-sentinel/);
    assert.equal(result.length, -1);
    assert.equal(result.secretWasEchoed, false);
    assert.equal(result.controlCRestored, true);
  }

  const runner = String.raw`param([string]$InputScript);. $InputScript;try{$null=Read-ReleasePassword;throw 'unexpected acceptance'}catch{if($_.Exception.Message -notmatch 'interactive PowerShell console'){throw};'redirected-rejected'}`;
  await mkdir(fixtureCache, { recursive: true });
  const root = await mkdtemp(path.join(fixtureCache, 'redirect-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runnerPath = path.join(root, 'redirect.ps1');
  await writeFile(runnerPath, runner, 'utf8');
  const result = spawnSync('pwsh.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', runnerPath, inputScript], { encoding: 'utf8', timeout: 30000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /redirected-rejected/);
});

test('shared signing input is side-effect free and never reads a password from Read-Host or environment', () => {
  assert.match(source, /function Read-ReleasePasswordCore/);
  assert.match(source, /\[Console\]::ReadKey\(\$true\)/);
  assert.match(source, /\[Console\]::KeyAvailable/);
  assert.doesNotMatch(source, /Read-Host|SLIM_V1_KEYSTORE_PASSWORD|ConvertTo-SecureString|Write-Output/);
});
