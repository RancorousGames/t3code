$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot

function Invoke-Git {
  param([Parameter(Mandatory = $true)][string[]]$Arguments)
  & git -C $repoRoot @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "git $($Arguments -join ' ') failed with exit code $LASTEXITCODE."
  }
}

$branch = (& git -C $repoRoot branch --show-current).Trim()
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($branch)) {
  throw "Could not determine the current branch."
}

$upstreamHead = (& git -C $repoRoot symbolic-ref --quiet --short refs/remotes/upstream/HEAD 2>$null)
if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($upstreamHead)) {
  $baseBranch = $upstreamHead.Trim() -replace '^upstream/', ''
} else {
  & git -C $repoRoot show-ref --verify --quiet refs/remotes/upstream/main
  $hasUpstreamMain = $LASTEXITCODE -eq 0
  & git -C $repoRoot show-ref --verify --quiet refs/remotes/upstream/master
  $hasUpstreamMaster = $LASTEXITCODE -eq 0
  if ($hasUpstreamMain) {
    $baseBranch = "main"
  } elseif ($hasUpstreamMaster) {
    $baseBranch = "master"
  } else {
    throw "Could not find upstream's default branch; fetch upstream and set its HEAD reference."
  }
}

if ($branch -eq $baseBranch) {
  throw "Refusing to rebase and force-push the upstream base branch '$branch'."
}

$dirty = & git -C $repoRoot status --porcelain
if ($LASTEXITCODE -ne 0) {
  throw "Could not inspect the worktree."
}
if (-not [string]::IsNullOrWhiteSpace(($dirty -join "`n"))) {
  throw "Commit or stash worktree changes before running this script."
}

Invoke-Git -Arguments @("fetch", "upstream")
Invoke-Git -Arguments @("fetch", "origin")
Invoke-Git -Arguments @("rebase", "upstream/$baseBranch")
Invoke-Git -Arguments @("push", "--set-upstream", "--force-with-lease", "origin", "HEAD:refs/heads/$branch")
