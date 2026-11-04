param(
    [Parameter(Mandatory=$true)][string]$Checkout,
    [Parameter(Mandatory=$true)][string]$StartedAt
)
$ErrorActionPreference = 'Stop'
$directory = Join-Path $env:LOCALAPPDATA 'T3MoriDeployment'
$statusFile = Join-Path $directory 'remote-update.json'
$logFile = Join-Path $directory 'update.log'

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
    & (Join-Path $Checkout 'deploy\wife\Update-Wife.cmd')
    if ($LASTEXITCODE -ne 0) { throw "Updater exited with code $LASTEXITCODE. See log." }
    Write-Status 'succeeded' 'Both applications updated successfully.' ([DateTime]::UtcNow.ToString('o'))
} catch {
    Write-Status 'failed' $_.Exception.Message ([DateTime]::UtcNow.ToString('o'))
}
