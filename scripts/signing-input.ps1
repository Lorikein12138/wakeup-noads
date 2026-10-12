# Shared secure console input. Dot-sourcing only defines functions.
function New-ReleaseConsoleInputAdapter {
    return @{
        isInputRedirected = { [Console]::IsInputRedirected }
        getControlCAsInput = { [Console]::TreatControlCAsInput }
        setControlCAsInput = { param($Value) [Console]::TreatControlCAsInput = [bool]$Value }
        keyAvailable = { [Console]::KeyAvailable }
        readKey = { [Console]::ReadKey($true) }
        writePrompt = { param($Text) [Console]::Write($Text) }
        writeStatus = { param($Text) [Console]::WriteLine($Text) }
    }
}

function Clear-ReleaseQueuedKeys([hashtable]$InputAdapter) {
    while (& $InputAdapter.keyAvailable) { $null = & $InputAdapter.readKey }
}

function Read-ReleasePasswordCore {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][hashtable]$InputAdapter,
        [ValidateRange(0, 1024)][int]$MinimumLength = 0,
        [string]$Prompt = 'Keystore password: '
    )

    $secure = [Security.SecureString]::new()
    $controlCWasInput = $false
    $controlCChanged = $false
    $accepted = $false
    try {
        if (& $InputAdapter.isInputRedirected) { throw 'Secure password input requires an interactive PowerShell console.' }
        $controlCWasInput = [bool](& $InputAdapter.getControlCAsInput)
        if (-not $controlCWasInput) {
            $controlCChanged = $true
            & $InputAdapter.setControlCAsInput $true
        }
        Clear-ReleaseQueuedKeys $InputAdapter
        & $InputAdapter.writePrompt $Prompt
        while ($true) {
            $key = & $InputAdapter.readKey
            if ($null -eq $key) { throw 'Secure password input ended before submission.' }
            $keyName = [string]$key.Key
            $keyChar = [char]$key.KeyChar
            $control = ($key.Modifiers -band [ConsoleModifiers]::Control) -ne 0
            if ($keyName -eq 'Escape' -or ($control -and $keyName -in @('C', 'Z', 'D'))) { throw 'Secure password input was cancelled.' }
            if ($keyName -eq 'Backspace') {
                if ($secure.Length -gt 0) { $secure.RemoveAt($secure.Length - 1) }
                continue
            }
            if ($keyName -eq 'Enter') {
                if ($secure.Length -eq 0) { continue }
                if ($secure.Length -lt $MinimumLength) {
                    & $InputAdapter.writeStatus "Password must contain at least $MinimumLength characters."
                    continue
                }
                Clear-ReleaseQueuedKeys $InputAdapter
                $secure.MakeReadOnly()
                $accepted = $true
                return $secure
            }
            if ($control -or [char]::IsControl($keyChar)) { continue }
            $secure.AppendChar($keyChar)
        }
    } catch {
        if ($_.Exception.Message -like 'Secure password input*') { throw }
        throw 'Secure password input failed. Re-run from an interactive PowerShell 7 console.'
    } finally {
        if ($controlCChanged) {
            try { & $InputAdapter.setControlCAsInput $controlCWasInput }
            catch { $secure.Dispose(); throw 'Secure password console state could not be restored.' }
        }
        if (-not $accepted) { $secure.Dispose() }
        $key = $null
        $keyChar = [char]0
    }
}

function Read-ReleasePassword {
    [CmdletBinding()]
    param([ValidateRange(0, 1024)][int]$MinimumLength = 0)
    $prompt = if ($MinimumLength -gt 0) { 'New release keystore password: ' } else { 'Release keystore password: ' }
    return Read-ReleasePasswordCore -InputAdapter (New-ReleaseConsoleInputAdapter) -MinimumLength $MinimumLength -Prompt $prompt
}
