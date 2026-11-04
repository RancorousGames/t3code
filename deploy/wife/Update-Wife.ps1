# Compatibility entry point for old desktop shortcuts.
# The canonical updater is deploy/wife/Install-T3-Monku.ps1, embedded in
# T3-Monku-Updater.exe for first installs. Never duplicate update logic here.
$ErrorActionPreference = 'Stop'
$installer = Join-Path $PSScriptRoot 'Install-T3-Monku.ps1'
if (-not (Test-Path $installer)) { throw "Missing installer in this checkout: $installer" }
& (Join-Path $PSHOME 'powershell.exe') -NoProfile -ExecutionPolicy Bypass -File $installer
exit $LASTEXITCODE
