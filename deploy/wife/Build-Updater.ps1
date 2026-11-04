# Builds the small Windows executable used for first installs and later updates.
# The script is embedded so one EXE works before Git or the repo is present.
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) {
    $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
}
if (-not (Test-Path $csc)) { throw 'Windows .NET Framework compiler (csc.exe) is unavailable.' }
$source = Join-Path $root 'UpdaterLauncher.cs'
$script = Join-Path $root 'Install-T3-Monku.ps1'
$icon = Join-Path $root '..\..\apps\mori-desktop\assets\monku.ico'
$target = Join-Path $root 'T3-Monku-Updater.exe'
& $csc '/nologo' '/target:winexe' '/optimize+' ('/out:' + $target) ('/resource:' + $script + ',MoriInstallScript') ('/win32icon:' + $icon) '/reference:System.Windows.Forms.dll' '/reference:System.Drawing.dll' $source
if ($LASTEXITCODE -ne 0) { throw "Updater EXE compile failed ($LASTEXITCODE)." }
Write-Host "Built $target" -ForegroundColor Green
