[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$Runtime,
    [Parameter(Mandatory=$true)][string]$NpmCli,
    [string]$Node = 'node',
    [string]$Python = 'python',
    [string]$Cache = (Join-Path $env:LOCALAPPDATA 'RufaDSH\build-cache\preinstalled')
)
$ErrorActionPreference = 'Stop'
$runtimeRoot = [IO.Path]::GetFullPath($Runtime)
if (-not (Test-Path -LiteralPath (Join-Path $runtimeRoot 'rufa-runtime.json'))) { throw 'Materialize the pinned Harness runtime first.' }
$runtimeOwner = if ((Split-Path $runtimeRoot -Leaf) -eq 'runtime') { Split-Path $runtimeRoot -Parent } else { $runtimeRoot }
$busy = Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('node.exe','electron.exe','Rufajx-DSH.exe') -and $_.CommandLine -and $_.CommandLine.Contains($runtimeOwner) }
if ($busy) { throw 'Close the runtime before preparing its bundled plugins.' }
New-Item -ItemType Directory -Force -Path $Cache | Out-Null
if (-not (Test-Path -LiteralPath (Join-Path $runtimeRoot 'rufa-preinstalled.json'))) {
    & $Python (Join-Path $PSScriptRoot 'prepare-company-plugins.py') --runtime $runtimeRoot --cache $Cache
    if ($LASTEXITCODE -ne 0) { throw 'Office/PDF/OCR preparation failed.' }
}
& $Node (Join-Path $PSScriptRoot 'preinstalled-runtime.mjs') $runtimeRoot --sync-wrappers
if ($LASTEXITCODE -ne 0) { throw 'Office/PDF/OCR check failed.' }
foreach ($script in @('sidebar-runtime.mjs','media-preview-runtime.mjs','desktop-video-runtime.mjs')) {
    & $Node (Join-Path $PSScriptRoot $script) $runtimeRoot --prepare --npm-cli $NpmCli --cache-dir $Cache
    if ($LASTEXITCODE -ne 0) { throw "Bundled feature preparation failed: $script" }
}
& $Node (Join-Path $PSScriptRoot 'solidworks-runtime.mjs') prepare $runtimeRoot
if ($LASTEXITCODE -ne 0) { throw 'SolidWorks offline toolkit preparation failed.' }
Write-Output 'All pinned client presets are prepared for offline packaging. Account credentials and personal data were not copied.'
