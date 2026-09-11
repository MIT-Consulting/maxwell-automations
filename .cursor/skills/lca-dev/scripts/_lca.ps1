# Shared helper: resolve repo root, ensure CLI is built, invoke lca.
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string[]]$LcaArgs,
  [string]$RepoRoot = ""
)

$ErrorActionPreference = "Stop"

if (-not $RepoRoot) {
  $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..\..")).Path
}

Set-Location $RepoRoot

$cliEntry = Join-Path $RepoRoot "packages\cli\dist\index.js"
if (-not (Test-Path $cliEntry)) {
  Write-Host "Building CLI..."
  npm run build -w @lca/cli
  if (-not (Test-Path $cliEntry)) {
    throw "CLI build failed: $cliEntry not found"
  }
}

& node $cliEntry @LcaArgs
exit $LASTEXITCODE
