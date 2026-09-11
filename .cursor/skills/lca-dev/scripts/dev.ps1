# Hot-reload dev session via lca CLI (single port, detached).
param(
  [int]$Port = $(if ($env:LCA_PORT) { [int]$env:LCA_PORT } else { 3747 }),
  [string]$RepoRoot = ""
)

$ErrorActionPreference = "Stop"
$env:LCA_PORT = "$Port"

& (Join-Path $PSScriptRoot "_lca.ps1") -RepoRoot $RepoRoot -LcaArgs @("up", "dev")
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$base = "http://127.0.0.1:$Port/"
try {
  $r = Invoke-WebRequest -Uri $base -TimeoutSec 2 -UseBasicParsing
  if ($r.StatusCode -eq 200) { Start-Process $base }
} catch {
  # best-effort browser open
}
