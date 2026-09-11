# Stop daemon or dev stack via lca CLI (cancels active runs in prod).
param(
  [int]$Port = $(if ($env:LCA_PORT) { [int]$env:LCA_PORT } else { 3747 }),
  [string]$RepoRoot = ""
)

$ErrorActionPreference = "Stop"
$env:LCA_PORT = "$Port"

& (Join-Path $PSScriptRoot "_lca.ps1") -RepoRoot $RepoRoot -LcaArgs @("down")
exit $LASTEXITCODE
