# Repo-maintained installer/updater for T3 Code (Custom) + Monku no Mori.
# Launched by T3-Monku-Updater.exe, which embeds this script for first-time clones.
# The first phase fetches main, then executes the current repo copy before building.
param([switch]$AfterFetch)
$ErrorActionPreference = 'Stop'
$repoUrl = 'https://github.com/RancorousGames/t3code.git'
$deployBranch = 'main'
$checkout = Join-Path $env:USERPROFILE 't3code'
$installerHome = Join-Path $env:LOCALAPPDATA 'T3MonkuInstaller'
$logFile = Join-Path $installerHome 'install.log'
$transcriptStarted = $false
$originalPath = $env:Path

function Refresh-Path {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = "$machine;$user;$script:originalPath"
}
function Has-Command([string]$name) {
    return $null -ne (Get-Command $name -ErrorAction SilentlyContinue)
}
function Run([string]$program, [string[]]$arguments) {
    Write-Host (">> " + $program + ' ' + ($arguments -join ' ')) -ForegroundColor DarkCyan
    & $program @arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$program failed with exit code $LASTEXITCODE."
    }
}
function Ensure-WingetPackage([string]$command, [string]$packageId) {
    Refresh-Path
    if (Has-Command $command) { return }
    if (-not (Has-Command 'winget.exe')) {
        throw 'Windows Package Manager (winget) is missing. Install App Installer from the Microsoft Store, then rerun.'
    }
    Write-Host "Installing $packageId..." -ForegroundColor Cyan
    Run 'winget.exe' @('install', '--id', $packageId, '--exact', '--source', 'winget', '--accept-package-agreements', '--accept-source-agreements')
    Refresh-Path
    if (-not (Has-Command $command)) {
        throw "$packageId installed but $command is not yet on PATH. Open a NEW PowerShell window and rerun this script."
    }
}
function Run-Python([string[]]$arguments) {
    Run $script:pythonProgram ($script:pythonPrefix + $arguments)
}
function Add-Shortcut([string]$name, [string]$target, [string]$arguments = '') {
    $desktop = [Environment]::GetFolderPath('Desktop')
    $link = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $desktop "$name.lnk"))
    $link.TargetPath = $target
    $link.Arguments = $arguments
    $link.WorkingDirectory = Split-Path -Parent $target
    $link.Save()
}

try {
    New-Item -Path $installerHome -ItemType Directory -Force | Out-Null
    Start-Transcript -Path $logFile -Append | Out-Null
    $transcriptStarted = $true
    Write-Host 'T3 Code + Monku no Mori — installer/updater' -ForegroundColor Green
    Write-Host "Repository: $repoUrl ($deployBranch)"
    Write-Host "Install folder: $checkout"

    # Avoid updating source/build output underneath an open Monku window.
    if (@(Get-CimInstance Win32_Process -Filter "Name = 'Monku no Mori.exe'").Count -gt 0) {
        throw 'Monku no Mori is open. Save your work and close it before updating.'
    }

    # These are installed only if absent; sign-in prompts, if any, stay on her PC.
    Ensure-WingetPackage 'git.exe' 'Git.Git'
    Ensure-WingetPackage 'node.exe' 'OpenJS.NodeJS'
    $nodeVersionText = (& node.exe --version).Trim().TrimStart('v')
    try { $nodeVersion = [version]$nodeVersionText } catch { throw "Unrecognized Node.js version: $nodeVersionText" }
    if ($nodeVersion.Major -lt 24) {
        throw "Node.js $nodeVersion is too old. Update Node.js to 24+ (recommended 26) and rerun this installer."
    }
    Refresh-Path
    # Windows may expose a Microsoft Store python.exe alias; prefer the official
    # Python launcher and pin the version expected by this checkout.
    $havePython313 = $false
    if (Has-Command 'py.exe') {
        try {
            & py.exe -3.13 --version 2>$null | Out-Null
            $havePython313 = ($LASTEXITCODE -eq 0)
        } catch { $havePython313 = $false }
    }
    if (-not $havePython313) {
        if (-not (Has-Command 'winget.exe')) { throw 'winget is needed to install Python 3.13.' }
        Run 'winget.exe' @('install', '--id', 'Python.Python.3.13', '--exact', '--source', 'winget', '--accept-package-agreements', '--accept-source-agreements')
        Refresh-Path
    }
    if (Has-Command 'py.exe') {
        $script:pythonProgram = 'py.exe'
        $script:pythonPrefix = @('-3.13')
    } elseif (Has-Command 'python.exe') {
        $script:pythonProgram = 'python.exe'
        $script:pythonPrefix = @()
    } else {
        throw 'Python 3.13 was installed but cannot be found yet. Open a new PowerShell window and rerun.'
    }
    Run-Python @('--version')

    if (-not (Has-Command 'npm.cmd')) {
        throw 'npm was not found after Node.js installation. Open a new PowerShell window and rerun.'
    }
    $wantedPnpm = '12.14.0'
    $installedPnpm = if (Has-Command 'pnpm.cmd') { (& pnpm.cmd --version 2>$null).Trim() } else { '' }
    if ($installedPnpm -ne $wantedPnpm) {
        Write-Host "Installing pnpm $wantedPnpm..." -ForegroundColor Cyan
        Run 'npm.cmd' @('install', '--global', "pnpm@$wantedPnpm")
        Refresh-Path
    }
    if (-not (Has-Command 'pnpm.cmd')) {
        throw 'pnpm was installed but is not on PATH. Open a new PowerShell window and rerun.'
    }

    if (-not $AfterFetch -and -not (Test-Path (Join-Path $checkout '.git'))) {
        if (Test-Path $checkout) {
            throw "Destination exists but is not a Git checkout: $checkout. Rename it rather than deleting its contents."
        }
        Write-Host 'Cloning the application source from GitHub...' -ForegroundColor Cyan
        Run 'git.exe' @('clone', '--branch', $deployBranch, $repoUrl, $checkout)
    } elseif (-not $AfterFetch) {
        $remote = (& git.exe -C $checkout remote get-url origin).Trim()
        if ($LASTEXITCODE -ne 0 -or $remote -notmatch 'github\.com[:/]RancorousGames/t3code(?:\.git)?$') {
            throw "The existing checkout has an unexpected Git remote: $remote. Not modifying it."
        }
        $branch = (& git.exe -C $checkout branch --show-current).Trim()
        if ($LASTEXITCODE -ne 0 -or $branch -notin @('main', 'wife-deploy')) {
            throw "Expected main or legacy wife-deploy branch; found '$branch'. Not modifying this checkout."
        }
        & git.exe -C $checkout diff --quiet
        if ($LASTEXITCODE -ne 0) { throw 'Local tracked edits found. Commit or stash them before updating.' }
        & git.exe -C $checkout diff --cached --quiet
        if ($LASTEXITCODE -ne 0) { throw 'Staged Git changes found. Commit or stash them before updating.' }
        Write-Host "Updating source from GitHub branch $deployBranch..." -ForegroundColor Cyan
        Run 'git.exe' @('-C', $checkout, 'fetch', 'origin', $deployBranch)
        # Older PCs may still be on wife-deploy. Fast-forward it to main without
        # a destructive checkout, then future updates always target main.
        Run 'git.exe' @('-C', $checkout, 'merge', '--ff-only', 'FETCH_HEAD')
    }

    if (-not $AfterFetch) {
        # The currently executing bootstrap might be old: load the script just
        # fetched from GitHub, not a stale copy from someone's desktop.
        $latestScript = Join-Path $checkout 'deploy\wife\Install-T3-Monku.ps1'
        if (-not (Test-Path $latestScript)) {
            throw "This checkout does not contain the repo installer: $latestScript"
        }
        if ($transcriptStarted) { Stop-Transcript | Out-Null; $transcriptStarted = $false }
        & (Join-Path $PSHOME 'powershell.exe') -NoProfile -ExecutionPolicy Bypass -File $latestScript -AfterFetch
        exit $LASTEXITCODE
    }

    foreach ($relative in @('compile_t3.py', 'launch_t3.py', 'launch_mori.py', 'apps\mori-web\package.json', 'apps\mori-desktop\main.cjs')) {
        if (-not (Test-Path (Join-Path $checkout $relative))) {
            throw "The deployment branch does not contain $relative. Publish the latest code to main first."
        }
    }
    $revision = (& git.exe -C $checkout rev-parse --short HEAD).Trim()
    Write-Host "Checked out GitHub revision: $revision" -ForegroundColor Green

    Push-Location $checkout
    try {
        Write-Host 'Installing source dependencies...' -ForegroundColor Cyan
        Run 'pnpm.cmd' @('install', '--frozen-lockfile')
        Write-Host 'Building Monku no Mori...' -ForegroundColor Cyan
        Run 'pnpm.cmd' @('--filter', '@t3tools/mori-web', 'build')

        $t3Exe = Join-Path $checkout '.electron-runtime\windows-custom\T3 Code (Custom).exe'
        $profileStore = Join-Path $env:APPDATA 't3code-custom\Local Storage\leveldb\CURRENT'
        if ((Test-Path $t3Exe) -and (Test-Path $profileStore)) {
            # Existing app: use its native session backup and controlled rebuild/restart.
            Write-Host 'Building/updating T3 while preserving its ChatGPT session storage...' -ForegroundColor Cyan
            Run-Python @('compile_and_launch_t3.py', '--worker', '--force-build', '--replace-electron')
        } else {
            # Fresh PC: no browser session database exists to back up.
            Write-Host 'Preparing T3 for first launch...' -ForegroundColor Cyan
            Run-Python @('compile_t3.py', '--build-only')
            Run-Python @('launch_t3.py')
        }
        Write-Host 'Starting Monku no Mori...' -ForegroundColor Cyan
        Run-Python @('launch_mori.py')
    } finally {
        Pop-Location
    }

    $t3Exe = Join-Path $checkout '.electron-runtime\windows-custom\T3 Code (Custom).exe'
    $moriExe = Join-Path $checkout '.electron-runtime\mori-windows\Monku no Mori.exe'
    if (-not (Test-Path $t3Exe) -or -not (Test-Path $moriExe)) {
        throw 'A built application executable is missing. See install.log for details.'
    }

    # The launcher itself is versioned in this checkout. A desktop shortcut
    # points to it, so updating Git also updates the next updater launch.
    $updaterExe = Join-Path $checkout 'deploy\wife\T3-Monku-Updater.exe'
    if (-not (Test-Path $updaterExe)) { throw "Missing repo updater executable: $updaterExe" }
    Add-Shortcut 'T3 Code (Custom)' $t3Exe
    Add-Shortcut 'Monku no Mori' $moriExe
    Add-Shortcut 'Update T3 and Monku' $updaterExe

    Write-Host ''
    Write-Host 'SUCCESS: Both apps are installed/updated and launched.' -ForegroundColor Green
    Write-Host 'Desktop shortcuts created for T3, Monku and Update T3 and Monku.'
    Write-Host 'The updater and its future behavior are now maintained in deploy/wife in this Git checkout.'
    Write-Host 'To connect remotely: T3 > Settings > Sharing & access > T3 Connect.'
    Write-Host 'Sign in to ChatGPT/Google separately on this computer. Account tokens are not copied.'
    Write-Host "Log: $logFile"
} catch {
    Write-Host ''
    Write-Host "INSTALLATION STOPPED: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "Log: $logFile" -ForegroundColor Yellow
    if ($transcriptStarted) { Stop-Transcript | Out-Null; $transcriptStarted = $false }
    # The EXE keeps the error visible; never block unattended updates on stdin.
    exit 1
} finally {
    if ($transcriptStarted) { Stop-Transcript | Out-Null }
}
