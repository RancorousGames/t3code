param(
  [ValidateSet("before", "after")]
  [string]$Phase = "before",
  [string]$Root = "D:\SSDProjects\Tools\t3code"
)

$ErrorActionPreference = "Stop"
$timestamp = Get-Date
$processRows = @(Get-CimInstance Win32_Process -Filter "Name = 'T3 Code (Custom).exe'")
$livePids = @($processRows | Select-Object -ExpandProperty ProcessId)
$systemProcesses = @(
  foreach ($item in $processRows) {
    try {
      $live = Get-Process -Id $item.ProcessId -ErrorAction Stop
      [pscustomobject]@{
        pid = $item.ProcessId
        parentPid = $item.ParentProcessId
        type = if ($item.CommandLine -match '--type=([^ ]+)') { $Matches[1] } else { "main-or-server" }
        privateCommitMB = [math]::Round($live.PrivateMemorySize64 / 1MB, 1)
        workingSetMB = [math]::Round($live.WorkingSet64 / 1MB, 1)
      }
    } catch { }
  }
)
$logDir = Join-Path $Root ".t3\userdata\logs"
$logs = @(Get-ChildItem $logDir -File -Filter 'renderer-history.ndjson*' -ErrorAction SilentlyContinue)
$rows = New-Object 'System.Collections.Generic.List[object]'
foreach ($file in $logs) {
  foreach ($line in [IO.File]::ReadLines($file.FullName)) {
    if ($line -notmatch 't3-browser-session:([0-9a-f-]{36})') { continue }
    $sessionId = $Matches[1]
    try {
      $row = $line | ConvertFrom-Json
      if ($row.surface -ne 'preview') { continue }
      $rows.Add([pscustomobject]@{
        sessionId = $sessionId
        webContentsId = $row.webContentsId
        event = $row.event
        timestampMs = $row.timestampUnixMs
        rendererPid = $row.rendererPid
        workingSetBytes = $row.memory.workingSetBytes
      })
    } catch { }
  }
}
# A destroyed guest is never included simply because an older sample exists.
$latestByContents = @($rows | Group-Object webContentsId | ForEach-Object {
  $_.Group | Sort-Object timestampMs | Select-Object -Last 1
})
$cutoff = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - 240000
$active = @($latestByContents | Where-Object {
  $_.event -notin @("destroyed", "render-process-gone") -and
  $_.rendererPid -in $livePids -and $_.timestampMs -gt $cutoff
})
$sessions = @(
  foreach ($group in ($active | Group-Object sessionId)) {
    $renderers = @(
      $group.Group | Group-Object rendererPid | ForEach-Object {
        $_.Group | Sort-Object timestampMs -Descending | Select-Object -First 1
      }
    )
    $workingBytes = [double]0
    foreach ($renderer in $renderers) {
      $workingBytes += [double]$renderer.workingSetBytes
    }
    [pscustomobject]@{
      sessionId = $group.Name
      rendererPids = @($renderers.rendererPid)
      rendererCount = $renderers.Count
      processWorkingSetMB = [math]::Round($workingBytes / 1MB, 1)
    }
  }
)
$rollup = $sessions | Measure-Object processWorkingSetMB -Average -Minimum -Maximum
$processRollup = $systemProcesses | Measure-Object workingSetMB -Sum
$commitRollup = $systemProcesses | Measure-Object privateCommitMB -Sum
# The independent browser host is a different process tree and must be counted
# separately: Chromium and helper children can outlive the T3 Electron root.
$allProcesses = @(Get-CimInstance Win32_Process)
$hostRoots = @($allProcesses | Where-Object {
  ($_.Name -match '^(node|electron)(\.exe)?$') -and
  $_.CommandLine -match 'persistent-chatgpt-(browser-host\.mjs|offscreen-host\.cjs)'
})
$related = @($hostRoots)
for ($pass = 0; $pass -lt 8; $pass++) {
  $new = @($allProcesses | Where-Object {
    $related.ProcessId -contains $_.ParentProcessId -and
    $related.ProcessId -notcontains $_.ProcessId
  })
  if ($new.Count -eq 0) { break }
  $related += $new
}
$detachedProcesses = @(
  foreach ($item in $related) {
    try {
      $live = Get-Process -Id $item.ProcessId -ErrorAction Stop
      [pscustomobject]@{
        pid = $item.ProcessId
        parentPid = $item.ParentProcessId
        type = $item.Name
        privateCommitMB = [math]::Round($live.PrivateMemorySize64 / 1MB, 1)
        workingSetMB = [math]::Round($live.WorkingSet64 / 1MB, 1)
      }
    } catch { }
  }
)
$report = [pscustomobject]@{
  phase = $Phase
  sampledAt = $timestamp.ToString('o')
  caveat = "A renderer may serve multiple pages and historical snapshot times vary. Process working sets include shared resources and are not exact exclusive per-session RAM."
  detachedBrowserHost = [pscustomobject]@{
    processCount = $detachedProcesses.Count
    totalWorkingSetMB = [math]::Round((($detachedProcesses | Measure-Object workingSetMB -Sum).Sum), 1)
    totalPrivateCommitMB = [math]::Round((($detachedProcesses | Measure-Object privateCommitMB -Sum).Sum), 1)
    processes = $detachedProcesses
  }
  app = [pscustomobject]@{
    processCount = $systemProcesses.Count
    totalWorkingSetMB = [math]::Round($processRollup.Sum, 1)
    totalPrivateCommitMB = [math]::Round($commitRollup.Sum, 1)
    processes = $systemProcesses
  }
  liveChatGPT = [pscustomobject]@{
    sessionsMatched = $sessions.Count
    renderersMatched = $active.Count
    perSessionMeanProcessWorkingSetMB = [math]::Round([double]$rollup.Average, 1)
    perSessionMinMB = [math]::Round([double]$rollup.Minimum, 1)
    perSessionMaxMB = [math]::Round([double]$rollup.Maximum, 1)
    sessions = $sessions
  }
}
$folder = Join-Path $Root ".t3\worker-reports"
New-Item -Path $folder -ItemType Directory -Force | Out-Null
$output = Join-Path $folder ("T3-0226-memory-" + $Phase + "-" + $timestamp.ToString("yyyyMMdd-HHmmss") + ".json")
$report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $output -Encoding UTF8
[pscustomobject]@{
  output = $output
  sessionsMatched = $sessions.Count
  meanMB = [math]::Round([double]$rollup.Average, 1)
  minMB = [math]::Round([double]$rollup.Minimum, 1)
  maxMB = [math]::Round([double]$rollup.Maximum, 1)
  totalWorkingSetMB = [math]::Round($processRollup.Sum, 1)
} | Format-List
