# Start prod daemon via lca CLI; open dashboard when ready.
param(
  [int]$Port = $(if ($env:LCA_PORT) { [int]$env:LCA_PORT } else { 3747 }),
  [string]$RepoRoot = ""
)

$ErrorActionPreference = "Stop"
$env:LCA_PORT = "$Port"

& (Join-Path $PSScriptRoot "_lca.ps1") -RepoRoot $RepoRoot -LcaArgs @("up")
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$base = "http://127.0.0.1:$Port/"
try {
  $h = Invoke-RestMethod -Uri "$base/health" -TimeoutSec 2
  if ($h.ok) { Start-Process $base }
} catch {
  # CLI already reported readiness; browser open is best-effort
}
