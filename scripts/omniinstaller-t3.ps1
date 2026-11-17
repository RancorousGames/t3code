param(
    [Parameter(Mandatory)]
    [ValidateSet('checkNode', 'checkVp', 'checkRust', 'checkMsvc', 'build', 'install', 'detectVersion', 'uninstall')]
    [string]$Action
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
if ($Action -eq 'checkNode') {
    if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) { exit 10 }
    $required = (Get-Content -LiteralPath (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json).engines.node
    $actual = & node.exe --version
    if ($LASTEXITCODE -ne 0 -or "$actual" -ne "v$required") {
        Write-Output "This checkout requires Node.js $required (found $actual)."
        exit 10
    }
    exit 0
}
if ($Action -eq 'checkVp') {
    if (-not (Get-Command vp -ErrorAction SilentlyContinue)) { exit 10 }
    & vp --version *> $null
    if ($LASTEXITCODE -ne 0) { exit 10 }
    exit 0
}
if ($Action -eq 'checkRust') {
    if (-not (Get-Command cargo.exe -ErrorAction SilentlyContinue) -or
        -not (Get-Command rustc.exe -ErrorAction SilentlyContinue)) { exit 10 }
    $lib = & rustc.exe --print target-libdir --target x86_64-pc-windows-msvc
    if ($LASTEXITCODE -ne 0 -or -not $lib -or -not (Test-Path -LiteralPath $lib -PathType Container)) { exit 10 }
    exit 0
}
if ($Action -eq 'checkMsvc') {
    # Match the x64 desktop packager's Windows preflight before running vp install.
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
    if (-not (Test-Path -LiteralPath $vswhere -PathType Leaf)) { exit 10 }
    $vs = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if (-not $vs) { exit 10 }
    $sdk = Get-ItemPropertyValue 'HKLM:\SOFTWARE\Microsoft\Windows Kits\Installed Roots' -Name KitsRoot10 -ErrorAction SilentlyContinue
    if (-not $sdk -or -not (Test-Path -LiteralPath (Join-Path $sdk 'Lib'))) { exit 10 }
    $toolset = Get-ChildItem -LiteralPath (Join-Path $vs 'VC/Tools/MSVC') -Directory -ErrorAction SilentlyContinue |
        Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
    if (-not $toolset -or -not (Test-Path -LiteralPath (Join-Path $toolset.FullName 'lib/spectre/x64'))) { exit 10 }
    exit 0
}

$dest = $env:OMNIINSTALLER_INSTALL_DIR
$version = $env:OMNIINSTALLER_SOURCE_VERSION
if (-not $dest -or $env:OMNIINSTALLER_APP_ID -ne 'dev.rancorousgames.t3code') {
    throw 'T3 Code installer context is incomplete.'
}
$app = Join-Path $dest 'app'
$marker = Join-Path $app '.omniinstaller-version'
$exe = Join-Path $app 'T3 Code.exe'
$cache = Join-Path $env:LOCALAPPDATA "OmniInstaller\BuildCache\dev.rancorousgames.t3code\$version"
$artifact = Join-Path $cache 'win-unpacked'

switch ($Action) {
    'build' {
        Push-Location $repo
        try {
            $env:CI = 'true'
            & vp install --frozen-lockfile
            if ($LASTEXITCODE -ne 0) { throw 'T3 Code dependency installation failed.' }
            $env:T3CODE_DESKTOP_UPDATE_REPOSITORY = 'RancorousGames/t3code'
            & vp run dist:desktop:artifact --platform win --target dir --arch x64 --output-dir $cache --verbose
            if ($LASTEXITCODE -ne 0) { throw 'T3 Code desktop build failed.' }
            if (-not (Test-Path -LiteralPath (Join-Path $artifact 'T3 Code.exe') -PathType Leaf)) {
                throw 'T3 Code desktop build did not produce win-unpacked/T3 Code.exe.'
            }
        }
        finally { Pop-Location }
    }
    'install' {
        if (-not (Test-Path -LiteralPath (Join-Path $artifact 'T3 Code.exe') -PathType Leaf)) {
            throw 'No staged build for this T3 Code revision.'
        }
        $existing = Test-Path -LiteralPath $app
        if ($existing -and -not (Test-Path -LiteralPath $marker -PathType Leaf)) {
            throw 'The destination already has an unmanaged app directory. Choose another install folder.'
        }
        New-Item -ItemType Directory -Path $dest -Force | Out-Null
        $id = [guid]::NewGuid().ToString('N')
        $stage = Join-Path $dest ".t3-stage-$id"
        $backup = Join-Path $dest ".t3-backup-$id"
        try {
            Copy-Item -LiteralPath $artifact -Destination $stage -Recurse
            Set-Content -LiteralPath (Join-Path $stage '.omniinstaller-version') -Value $version -Encoding ASCII
            if ($existing) { Move-Item -LiteralPath $app -Destination $backup }
            try { Move-Item -LiteralPath $stage -Destination $app }
            catch {
                if (Test-Path -LiteralPath $backup) { Move-Item -LiteralPath $backup -Destination $app }
                throw
            }
            if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Recurse -Force }
        }
        finally {
            if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
        }
    }
    'detectVersion' {
        if (-not (Test-Path -LiteralPath $exe -PathType Leaf) -or
            -not (Test-Path -LiteralPath $marker -PathType Leaf)) { exit 10 }
        $installed = (Get-Content -LiteralPath $marker -Raw).Trim()
        if (-not $installed) { exit 10 }
        Write-Output $installed
    }
    'uninstall' {
        if (Test-Path -LiteralPath $marker -PathType Leaf) {
            Remove-Item -LiteralPath $app -Recurse -Force
        }
    }
}
