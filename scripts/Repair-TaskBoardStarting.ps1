# Recover orphaned TaskBoard Starting reservations after cross-checking the complete
# T3 registry and the durable exact-request spawn journal. Read-only by default.
# Usage:
#   powershell -NoProfile -File scripts/Repair-TaskBoardStarting.ps1
#   powershell -NoProfile -File scripts/Repair-TaskBoardStarting.ps1 -Apply
[CmdletBinding()]
param(
    [switch]$Apply,
    [ValidateRange(30, 1440)][int]$MinimumAgeMinutes = 30,
    [string]$T3Home = '',
    [string]$ReportPath = ''
)
# Registry/session responses intentionally have optional fields (e.g. hasMore).
Set-StrictMode -Off
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
if (-not $T3Home) { $T3Home = Join-Path $repo '.t3' }
$node = (Get-Command node.exe -ErrorAction Stop).Source
$control = Join-Path $PSScriptRoot 'chatgpt-sessions.mjs'
$cli = Join-Path (Split-Path -Parent $repo) 'TaskBoard\packages\task-cli\target\release\taskboard.exe'
$catalogPath = Join-Path $env:APPDATA 'TaskBoard\projects.json'
if (-not (Test-Path -LiteralPath $control) -or -not (Test-Path -LiteralPath $cli) -or
    -not (Test-Path -LiteralPath $catalogPath)) {
    throw 'Missing T3 control, TaskBoard CLI, or TaskBoard project catalog.'
}

function Invoke-T3([hashtable]$request) {
    $json = $request | ConvertTo-Json -Compress -Depth 8
    $output = $json | & $node $control
    if ($LASTEXITCODE -ne 0 -or -not $output) { throw "T3 control failed: $($request.action)" }
    return $output | ConvertFrom-Json
}
function Get-Inventory {
    $inventory = Invoke-T3 @{action='list'; which='all'; includeHidden=$true}
    $sessions = @($inventory.sessions)
    if ($inventory.total -ne $sessions.Count -or
        $inventory.hasMore -eq $true -or $inventory.incomplete -eq $true) {
        throw "Incomplete T3 registry ($($sessions.Count)/$($inventory.total)); no changes allowed."
    }
    return $inventory
}
function Get-Capacity {
    $capacity = Invoke-T3 @{action='caffy'; op='capacity'}
    if ($null -eq $capacity.workingIds -or $null -eq $capacity.unknown -or $capacity.unknown -gt 0) {
        throw 'T3 working-session inventory unverified; no changes allowed.'
    }
    return $capacity
}
function Get-Queue([string]$root) {
    $raw = & $cli --json --root $root task queue list
    if ($LASTEXITCODE -ne 0 -or -not $raw) { throw "TaskBoard queue unavailable: $root" }
    $result = $raw | ConvertFrom-Json
    if ($result.schema -ne 'taskboard-dispatch-queue/v1' -or
        $result.boardRoot.TrimEnd('\') -ine $root.TrimEnd('\')) {
        throw "TaskBoard queue identity mismatch: $root"
    }
    return $result
}
function Get-StartJournal([string]$root, [string]$taskId, [string]$requestId) {
    # Mirror TaskBoardWorkCoordinator.startingSince: sha256(lowercased
    # absolute board path + NUL + task ID), exact requestId must match.
    $bytes = [Text.Encoding]::UTF8.GetBytes($root.ToLowerInvariant() + [char]0 + $taskId)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $hash = [BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
    $file = Join-Path $T3Home "userdata\task-open-locks\$hash.json"
    if (-not (Test-Path -LiteralPath $file)) { return $null }
    try {
        $data = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
        if ($data.requestId -ne $requestId -or
            $data.taskRef.id -ne $taskId -or
            $data.taskRef.board -ine $root) { return $null }
        return (Get-Item -LiteralPath $file).LastWriteTimeUtc
    } catch { return $null }
}

$projects = @((Get-Content -LiteralPath $catalogPath -Raw | ConvertFrom-Json).projects)
# A failed inventory read must abort the entire sweep rather than fall back to
# a partial session roster. Refetch right before *each* mutation.
$inventory = Get-Inventory
$capacity = Get-Capacity
$now = [DateTime]::UtcNow
$report = New-Object 'System.Collections.Generic.List[object]'
foreach ($project in $projects) {
    $queue = Get-Queue $project.path
    foreach ($item in @($queue.items | Where-Object { $_.state -eq 'starting' })) {
        $exact = @($inventory.sessions | Where-Object { $_.spawnRequestId -eq $item.reservationId })
        $otherWorking = @($inventory.sessions | Where-Object {
            $_.binding.taskRef.id -eq $item.taskId -and
            $_.binding.taskRef.board -ieq $project.path -and
            ($_.id -in @($capacity.workingIds) -or $_.activity -eq 'working')
        })
        $startedAt = Get-StartJournal $project.path $item.taskId $item.reservationId
        $ageMinutes = if ($null -ne $startedAt) {
            [Math]::Floor(($now - $startedAt).TotalMinutes)
        } else { $null }
        $status = if ($exact.Count) { 'exact-session-present' }
                  elseif ($otherWorking.Count) { 'task-worker-active' }
                  elseif ($null -eq $startedAt) { 'no-matching-journal' }
                  elseif ($ageMinutes -lt $MinimumAgeMinutes) { 'too-recent' }
                  else { 'orphan-eligible' }
        $outcome = if ($status -eq 'orphan-eligible') { 'candidate' } else { 'untouched' }
        if ($Apply -and $status -eq 'orphan-eligible') {
            # Reconcile with fresh registry, capacity and task metadata to
            # prevent clearing starts whose workers registered during the scan.
            $freshInventory = Get-Inventory
            $freshCapacity = Get-Capacity
            $latest = @( (Get-Queue $project.path).items |
                Where-Object { $_.taskId -eq $item.taskId } )
            $stillExact = @($freshInventory.sessions | Where-Object {
                $_.spawnRequestId -eq $item.reservationId
            })
            $stillActive = @($freshInventory.sessions | Where-Object {
                $_.binding.taskRef.id -eq $item.taskId -and
                $_.binding.taskRef.board -ieq $project.path -and
                ($_.id -in @($freshCapacity.workingIds) -or $_.activity -eq 'working')
            })
            $freshStart = Get-StartJournal $project.path $item.taskId $item.reservationId
            if ($latest.Count -ne 1 -or $latest[0].state -ne 'starting' -or
                $latest[0].reservationId -ne $item.reservationId -or
                $latest[0].queueRequest -ne $item.queueRequest -or
                $stillExact.Count -gt 0 -or $stillActive.Count -gt 0 -or
                $null -eq $freshStart -or
                ([DateTime]::UtcNow - $freshStart).TotalMinutes -lt $MinimumAgeMinutes) {
                $outcome = 'skipped-changed-during-scan'
            } else {
                $raw = & $cli --json --root $project.path task queue abandon $item.taskId `
                    --queue-request $item.queueRequest --request-id $item.reservationId `
                    --reason 'Verified orphaned Starting attempt: exact request absent from full T3 registry after minimum quarantine.' `
                    --verified-no-live-session
                if ($LASTEXITCODE -ne 0) {
                    $outcome = 'failed'
                    Write-Warning "Abandon rejected for $($item.taskId): $raw"
                } else {
                    $outcome = 'requeued'
                }
            }
        }
        $report.Add([pscustomobject]@{
            project = $project.name
            projectPriority = $project.priority
            taskId = $item.taskId
            priority = $item.priority
            ageMinutes = $ageMinutes
            exactSessions = $exact.Count
            exactSessionState = (@($exact | ForEach-Object { "$($_.id):$($_.status)/$($_.activity)" }) -join ',')
            activeTaskWorkers = $otherWorking.Count
            diagnosis = $status
            outcome = $outcome
        })
    }
}
$report | Sort-Object project,taskId | Format-Table -AutoSize | Out-String | Write-Output
if ($ReportPath) {
    $report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $ReportPath -Encoding UTF8
    Write-Output "Wrote report: $ReportPath"
}
Write-Output "Scanned $($projects.Count) project boards; Starting=$($report.Count); orphanCandidates=$(@($report | Where-Object diagnosis -eq 'orphan-eligible').Count); requeued=$(@($report | Where-Object outcome -eq 'requeued').Count)."
