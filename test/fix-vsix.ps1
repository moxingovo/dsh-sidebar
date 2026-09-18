# Rebuild the .vsix with the CLEAN repo package.json.
# Why: vsce on this machine sometimes mangles UTF-8 Chinese in package.json
# (GBK roundtrip) which can break JSON. This script repacks the vsix from
# the installed-extension files (which are known-good) so the shipped
# artifact is always clean.
# Usage: pwsh -File test\fix-vsix.ps1   (run from the repo root)
param([string]$Version = '0.4.0')
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$vsix = Join-Path $repo "dsh-webview-$Version.vsix"
if (-not (Test-Path $vsix)) { throw "vsix not found: $vsix" }

$stage = Join-Path $env:TEMP 'dsx-stage'
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item (Join-Path $stage 'orig') -ItemType Directory -Force | Out-Null
New-Item (Join-Path $stage 'rebuild') -ItemType Directory -Force | Out-Null

Copy-Item $vsix (Join-Path $stage 'orig.zip') -Force
Expand-Archive -Path (Join-Path $stage 'orig.zip') -DestinationPath (Join-Path $stage 'orig') -Force
Copy-Item -Recurse (Join-Path $stage 'orig/extension') (Join-Path $stage 'rebuild/extension')
Copy-Item -LiteralPath (Join-Path $stage 'orig/extension.vsixmanifest') -Destination (Join-Path $stage 'rebuild/extension.vsixmanifest') -Force
Copy-Item -LiteralPath (Join-Path $stage 'orig/[Content_Types].xml') -Destination (Join-Path $stage 'rebuild/[Content_Types].xml') -Force
Copy-Item (Join-Path $repo 'package.json') (Join-Path $stage 'rebuild/extension/package.json') -Force

$out = Join-Path $stage 'rebuild.zip'
Compress-Archive -Path (Join-Path $stage 'rebuild/*') -DestinationPath $out -Force
Move-Item $out $vsix -Force
Remove-Item $stage -Recurse -Force
Write-Output "vsix rebuilt: $vsix"
