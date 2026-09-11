# List recent runs grouped by status, with the automation name and timing.
# Read-only; pulls from the live API. Newest first within each status group.
#
#   runs.ps1                 # 20 most recent runs, all statuses
#   runs.ps1 -Limit 50       # widen the window
#   runs.ps1 -Status failed  # only one status
param(
  [int]$Port = $(if ($env:LCA_PORT) { [int]$env:LCA_PORT } else { 3747 }),
  [int]$Limit = 20,
  [string]$Status = ""
)

$ErrorActionPreference = "Stop"
$base = "http://127.0.0.1:$Port"

try {
  $health = Invoke-RestMethod -Uri "$base/health" -TimeoutSec 2
  if (-not $health.ok) { throw "not ok" }
} catch {
  Write-Host "Daemon: DOWN (port $Port) - run up.ps1 first."
  exit 0
}

$runs = @((Invoke-RestMethod -Uri "$base/api/runs?limit=$Limit" -TimeoutSec 5).runs)
$autos = @((Invoke-RestMethod -Uri "$base/api/automations" -TimeoutSec 5).automations)

$nameById = @{}
foreach ($a in $autos) { $nameById[$a.id] = $a.name }

if ($Status) {
  $runs = @($runs | Where-Object { $_.status -eq $Status })
}

if ($runs.Count -eq 0) {
  Write-Host "No runs$(if ($Status) { " with status '$Status'" })."
  exit 0
}

function Get-Elapsed {
  param($run)
  if (-not $run.startedAt) { return "" }
  $start = [datetime]$run.startedAt
  $end = if ($run.endedAt) { [datetime]$run.endedAt } else { (Get-Date).ToUniversalTime() }
  $sec = [int]($end - $start).TotalSeconds
  if ($sec -lt 60) { return "${sec}s" }
  return "{0}m{1:d2}s" -f [int]($sec / 60), ($sec % 60)
}

# Active statuses first so in-flight work is at the top.
$order = @("running", "needs_input", "queued", "completed", "failed", "cancelled")
$groups = $runs | Group-Object status
$sorted = $groups | Sort-Object { $order.IndexOf($_.Name) }

Write-Host "Recent runs (newest first, limit $Limit)$(if ($Status) { " - status '$Status'" }):`n"

foreach ($g in $sorted) {
  Write-Host "$($g.Name.ToUpper()) ($($g.Count))"
  foreach ($r in $g.Group) {
    $short = $r.id.Substring(0, 8)
    $name = if ($nameById.ContainsKey($r.automationId)) { $nameById[$r.automationId] } else { "(deleted) " + $r.automationId.Substring(0, 8) }
    $trig = if ($r.triggerKind) { $r.triggerKind } else { "-" }
    $elapsed = Get-Elapsed $r
    $when = if ($r.startedAt) { ([datetime]$r.startedAt).ToString("MM-dd HH:mm:ss") } else { ([datetime]$r.createdAt).ToString("MM-dd HH:mm:ss") }
    Write-Host ("  {0}  {1,-22} {2,-9} {3,6}  {4}" -f $short, $name, $trig, $elapsed, $when)
  }
  Write-Host ""
}
