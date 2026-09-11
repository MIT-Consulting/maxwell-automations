# Reset the lca dev environment to a clean slate, then restart the daemon.
#
# Default: stop the daemon, delete the runtime SQLite DB (runs, events, input
#   requests, dashboard-origin automations, and the workspaces table), then
#   restart. YAML config automations + workspaces re-appear on the next reconcile.
#
# -Purge: ALSO delete this repo's .cursor/automations/*.yaml so the board comes
#   up with zero automations from config too. (Destructive to checked-in fixtures.)
param(
  [int]$Port = $(if ($env:LCA_PORT) { [int]$env:LCA_PORT } else { 3747 }),
  [string]$RepoRoot = "",
  [switch]$Purge
)

$ErrorActionPreference = "Stop"

if (-not $RepoRoot) {
  $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..\..")).Path
}

$scriptDir = $PSScriptRoot
$lcaHome = Join-Path $env:USERPROFILE ".cursor-local-automations"

# 1. Stop the daemon first so the DB file is unlocked and runs are cancelled.
Write-Host "== Stopping daemon =="
powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $scriptDir "down.ps1") -Port $Port
if ($LASTEXITCODE -ne 0) {
  throw "down.ps1 failed (exit $LASTEXITCODE); refusing to wipe the DB while the port is held."
}

# 2. Wipe the runtime DB (and its WAL/SHM sidecars).
Write-Host "== Wiping runtime DB =="
$removed = 0
foreach ($f in @("state.sqlite", "state.sqlite-wal", "state.sqlite-shm")) {
  $p = Join-Path $lcaHome $f
  if (Test-Path $p) {
    Remove-Item -Force $p
    Write-Host "  removed $f"
    $removed++
  }
}
if ($removed -eq 0) { Write-Host "  (no DB files present)" }

# 3. Optionally purge workspace YAML automations from this repo.
if ($Purge) {
  Write-Host "== Purging workspace YAML automations =="
  $autoDir = Join-Path $RepoRoot ".cursor\automations"
  if (Test-Path $autoDir) {
    $yaml = @(Get-ChildItem -Path $autoDir -Recurse -File -Include *.yaml, *.yml)
    foreach ($f in $yaml) {
      Remove-Item -Force $f.FullName
      Write-Host "  purged $($f.Name)"
    }
    if ($yaml.Count -eq 0) { Write-Host "  (no YAML automations found)" }
  } else {
    Write-Host "  (no .cursor/automations dir)"
  }
}

# 4. Restart clean.
Write-Host "== Restarting daemon =="
powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $scriptDir "up.ps1") -Port $Port -RepoRoot $RepoRoot
exit $LASTEXITCODE
