param(
    [Parameter(Mandatory=$true)][string]$Checkout,
    [Parameter(Mandatory=$true)][string]$StartedAt
)
$ErrorActionPreference = 'Stop'
$directory = Join-Path $env:LOCALAPPDATA 'T3MoriDeployment'
$statusFile = Join-Path $directory 'remote-update.json'
$logFile = Join-Path $env:LOCALAPPDATA 'T3MonkuInstaller\launcher.log'

function Write-Status([string]$state, [string]$message, [string]$finishedAt = '') {
    $value = @{
        state = $state
        startedAt = $StartedAt
        message = $message
        logPath = $logFile
    }
    if ($finishedAt) { $value.finishedAt = $finishedAt }
    $temp = "$statusFile.tmp"
    $value | ConvertTo-Json -Compress | Set-Content -LiteralPath $temp -Encoding UTF8
    Move-Item -LiteralPath $temp -Destination $statusFile -Force
}

try {
    Write-Status 'running' 'Updating T3 Code and Monku no Mori. The connection may temporarily drop.'
    # The repo-owned EXE stages itself outside Git before pulling; --headless
    # waits for the complete update and returns the actual build exit code.
    # Do not call Update-Wife.cmd here: it pauses on failure and can hang a
    # detached Windows process forever without an interactive console.
    $updater = Join-Path $Checkout 'deploy\wife\T3-Monku-Updater.exe'
    if (-not (Test-Path -LiteralPath $updater)) { throw "Updater EXE missing: $updater" }
    $process = Start-Process -FilePath $updater -ArgumentList '--headless' -Wait -PassThru -WindowStyle Hidden
    if ($process.ExitCode -ne 0) { throw "Updater exited with code $($process.ExitCode). See log." }
    Write-Status 'succeeded' 'Both applications updated successfully.' ([DateTime]::UtcNow.ToString('o'))
} catch {
    Write-Status 'failed' $_.Exception.Message ([DateTime]::UtcNow.ToString('o'))
}
