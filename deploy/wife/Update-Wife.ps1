# Run from the wife's own Windows checkout. No developer credentials or profiles are copied.
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$logDir = Join-Path $env:LOCALAPPDATA 'T3MoriDeployment'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$log = Join-Path $logDir 'update.log'
Start-Transcript -Path $log -Append | Out-Null

function Run([string]$program, [string[]]$arguments) {
    Write-Host ">> $program $($arguments -join ' ')" -ForegroundColor Cyan
    & $program @arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$program failed (exit code $LASTEXITCODE)."
    }
}

function Require-Command([string]$name) {
    if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
        throw "Missing $name. Follow the one-time setup instructions in deploy\wife\README.md."
    }
}

function Create-Shortcut([string]$name, [string]$target, [string]$workingDirectory) {
    $desktop = [Environment]::GetFolderPath('Desktop')
    $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $desktop "$name.lnk"))
    $shortcut.TargetPath = $target
    $shortcut.WorkingDirectory = $workingDirectory
    $shortcut.Save()
}

try {
    Set-Location $root
    foreach ($command in @('git', 'node', 'pnpm', 'python')) { Require-Command $command }

    # A rebuild cannot refresh an open Mori window; ensure no user data is lost.
    $moriProcesses = @(Get-CimInstance Win32_Process -Filter "Name = 'Monku no Mori.exe'")
    if ($moriProcesses.Count -gt 0) {
        throw 'Close Monku no Mori before updating, then click Update T3 + Mori again.'
    }

    $branch = (& git branch --show-current).Trim()
    if ($LASTEXITCODE -ne 0 -or $branch -ne 'main') {
        throw "Expected checkout on branch main; found '$branch'. No changes made."
    }
    & git diff --quiet
    if ($LASTEXITCODE -ne 0) { throw 'Tracked local edits exist. Refusing to overwrite them with a pull.' }
    & git diff --cached --quiet
    if ($LASTEXITCODE -ne 0) { throw 'Staged local edits exist. Refusing to pull.' }

    Write-Host '1/4  Getting the latest committed source...' -ForegroundColor Green
    Run git @('fetch', 'origin', 'main')
    Run git @('merge', '--ff-only', 'FETCH_HEAD')

    Write-Host '2/4  Installing/updating dependencies...' -ForegroundColor Green
    Run pnpm @('install', '--frozen-lockfile')
    $vp = Join-Path $root 'node_modules\.bin\vp.cmd'
    if (-not (Test-Path $vp)) { throw "Vite+ runner is missing after pnpm install: $vp" }

    Write-Host '3/4  Building Monku no Mori...' -ForegroundColor Green
    Push-Location (Join-Path $root 'apps\mori-web')
    try { Run $vp @('build') }
    finally { Pop-Location }

    Write-Host '4/4  Building/restarting T3 Code...' -ForegroundColor Green
    $t3Exe = Join-Path $root '.electron-runtime\windows-custom\T3 Code (Custom).exe'
    $hasBrowserStorage = Test-Path (Join-Path $env:APPDATA 't3code-custom\Local Storage\leveldb\CURRENT')

    if ((-not (Test-Path $t3Exe)) -or (-not $hasBrowserStorage)) {
        # On a fresh install there is no browser-session database to back up.
        # Use the existing graceful T3 shutdown helper, then do an initial build.
        $shutdown = "from pathlib import Path; import compile_and_launch_t3 as d; d.stop_custom_app(Path.cwd())"
        Run python @('-c', $shutdown)
        Run python @('compile_t3.py', '--build-only')
        Run python @('launch_t3.py')
    } else {
        # This preserves existing ChatGPT browser sessions via the T3 backup/restart flow.
        # Do not use the default UI-only build: it doesn't activate native/server changes.
        & python compile_and_launch_t3.py --worker --force-build --replace-electron | Tee-Object -Variable output | Out-Host
        $exit = $LASTEXITCODE
        if ($exit -ne 0) { throw "T3 update failed (exit code $exit)." }
        if (($output -join "`n") -match 'Restart canceled') {
            throw 'T3 restart was canceled. Update not completed.'
        }
    }

    Run python @('launch_mori.py')
    $moriExe = Join-Path $root '.electron-runtime\mori-windows\Monku no Mori.exe'
    if (-not (Test-Path $t3Exe) -or -not (Test-Path $moriExe)) {
        throw 'Application runtime missing after build. Check log for details.'
    }

    Create-Shortcut 'T3 Code (Custom)' $t3Exe (Split-Path $t3Exe)
    Create-Shortcut 'Monku no Mori' $moriExe (Split-Path $moriExe)
    Create-Shortcut 'Update T3 + Mori' (Join-Path $PSScriptRoot 'Update-Wife.cmd') $PSScriptRoot
    Write-Host "SUCCESS. Both apps started; shortcuts are on the Desktop. Log: $log" -ForegroundColor Green
}
catch {
    Write-Host "UPDATE FAILED: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "Log: $log" -ForegroundColor Yellow
    exit 1
}
finally {
    Stop-Transcript | Out-Null
}
