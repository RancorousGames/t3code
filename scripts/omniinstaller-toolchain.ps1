# Cache the build tools without changing the Windows user's PATH.
function Save-ToolDownload($Url, $Path) {
    & curl.exe --fail --silent --show-error --location --retry 2 --connect-timeout 15 --max-time 120 --output $Path $Url
    if ($LASTEXITCODE -ne 0) { throw "Could not download $(Split-Path -Leaf $Url)." }
}

function Expand-ToolArchive($Url, $Hash, $Destination, $Binary, $ArchiveRoot = '') {
    if (Test-Path -LiteralPath (Join-Path $Destination $Binary) -PathType Leaf) { return }
    $stage = $Destination + '-' + [guid]::NewGuid().ToString('N')
    New-Item -ItemType Directory -Path $stage -Force | Out-Null
    try {
        $zip = Join-Path $stage 'tool.zip'
        $unpacked = Join-Path $stage 'unpacked'
        Save-ToolDownload $Url $zip
        if ((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash -ne $Hash) {
            throw "Download checksum mismatch for $(Split-Path -Leaf $Url)."
        }
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        [IO.Compression.ZipFile]::ExtractToDirectory($zip, $unpacked)
        if ($ArchiveRoot) { $unpacked = Join-Path $unpacked $ArchiveRoot }
        if (!(Test-Path -LiteralPath (Join-Path $unpacked $Binary) -PathType Leaf)) {
            throw "Downloaded tool did not contain $Binary."
        }
        Move-Item -LiteralPath $unpacked -Destination $Destination
    }
    finally { Remove-Item -LiteralPath $stage -Recurse -Force }
}

function Initialize-OmniInstallerToolchain($Repository) {
    $package = Get-Content -LiteralPath (Join-Path $Repository 'package.json') -Raw | ConvertFrom-Json
    $nodeVersion = $package.engines.node
    if ($nodeVersion -notmatch '^\d+\.\d+\.\d+$' -or $package.packageManager -notmatch '^pnpm@(\d+\.\d+\.\d+)$') {
        throw 'The checkout must pin exact Node.js and pnpm versions.'
    }
    $pnpmVersion = $Matches[1]
    $tools = Join-Path $env:LOCALAPPDATA 'OmniInstaller/BuildTools/t3code'
    $nodeName = "node-v$nodeVersion-win-x64"
    $nodeFolder = Join-Path $tools $nodeName
    $nodeExe = Join-Path $nodeFolder 'node.exe'
    if (!(Test-Path -LiteralPath $nodeExe -PathType Leaf)) {
        Write-Host "Preparing Node.js $nodeVersion"
        New-Item -ItemType Directory -Path $tools -Force | Out-Null
        $sumsFile = Join-Path $tools "$nodeName-shasums.txt"
        $base = "https://nodejs.org/dist/v$nodeVersion"
        Save-ToolDownload "$base/SHASUMS256.txt" $sumsFile
        $match = Select-String -LiteralPath $sumsFile -Pattern "^([0-9a-f]{64})\s+$([regex]::Escape($nodeName))\.zip$" |
            Select-Object -First 1
        if (!$match) { throw "Node.js $nodeVersion does not list the x64 Windows archive." }
        Expand-ToolArchive "$base/$nodeName.zip" $match.Matches[0].Groups[1].Value $nodeFolder 'node.exe' $nodeName
    }
    $env:Path = "$nodeFolder;$env:Path"
    if ((& $nodeExe --version) -ne "v$nodeVersion") { throw "The Node.js $nodeVersion download could not start." }

    $pythonVersion = '3.13.12'
    $pythonZip = "python-$pythonVersion-embed-amd64.zip"
    $pythonFolder = Join-Path $tools "python-$pythonVersion"
    $pythonHash = '76F238F606250C87C6BEAC75DCCD35EE99070A13490555936ABB6CB64ECCE3D0'
    Expand-ToolArchive "https://www.python.org/ftp/python/$pythonVersion/$pythonZip" $pythonHash $pythonFolder 'python.exe'
    $env:PYTHON = Join-Path $pythonFolder 'python.exe'
    $env:npm_config_python = $env:PYTHON

    $pnpmFolder = Join-Path $tools "pnpm-$pnpmVersion"
    $pnpm = Join-Path $pnpmFolder 'node_modules/@pnpm/exe.win32-x64/pnpm.exe'
    if (!(Test-Path -LiteralPath $pnpm -PathType Leaf)) {
        Write-Host "Preparing pnpm $pnpmVersion"
        $npmArgs = @('install', '--prefix', $pnpmFolder, '--no-audit', '--no-fund',
            '--ignore-scripts', '--fetch-retries=2', '--fetch-timeout=90000', "pnpm@$pnpmVersion")
        & (Join-Path $nodeFolder 'npm.cmd') @npmArgs
        if ($LASTEXITCODE -ne 0) { throw "Package manager setup failed for pnpm $pnpmVersion." }
    }
    $env:Path = "$(Split-Path -Parent $pnpm);$env:Path"
    & $pnpm install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { throw 'T3 Code dependency installation failed.' }
}

function Initialize-OmniInstallerResourceMonitor($Repository) {
    # The source build uses the fork's precompiled native helper for this Rust source tree.
    # Refresh the release and these pins when native/resource-monitor changes.
    $tree = '3fb3d6b36790f07944fa72c8ccfd9eec333d8e7e'
    $hash = '28E7FFEAD3EFF16AF2286E56843006375B83EECAB7A27E02EAFE74B1E20539FD'
    $checkoutTree = & git -C $Repository rev-parse HEAD:native/resource-monitor
    if ($LASTEXITCODE -ne 0 -or $checkoutTree -ne $tree) {
        throw 'This revision needs an updated native resource monitor from the T3 fork publisher.'
    }
    $monitor = Join-Path $Repository 'native/resource-monitor/target/x86_64-pc-windows-msvc/release/t3-resource-monitor.exe'
    if (!(Test-Path -LiteralPath $monitor -PathType Leaf) -or
        (Get-FileHash -LiteralPath $monitor -Algorithm SHA256).Hash -ne $hash) {
        Write-Host 'Preparing the T3 native resource monitor'
        New-Item -ItemType Directory -Path (Split-Path -Parent $monitor) -Force | Out-Null
        $release = "https://github.com/RancorousGames/t3code/releases/download/omniinstaller-monitor-$($tree.Substring(0,12))"
        $staged = "$monitor.download"
        try {
            Save-ToolDownload "$release/t3-resource-monitor.exe" $staged
            if ((Get-FileHash -LiteralPath $staged -Algorithm SHA256).Hash -ne $hash) {
                throw 'The downloaded resource monitor checksum does not match.'
            }
            Move-Item -LiteralPath $staged -Destination $monitor -Force
        }
        finally { Remove-Item -LiteralPath $staged -Force -ErrorAction SilentlyContinue }
    }
    $env:T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR = 'true'
}
