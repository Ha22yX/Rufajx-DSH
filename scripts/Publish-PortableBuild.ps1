[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$source = Join-Path $env:LOCALAPPDATA 'RufaDSH\development\workspace\apps\client\release\win-unpacked'
$destination = Join-Path $projectRoot 'build\Rufa-DSH'
$targetExe = Join-Path $destination '如发机械 DSH.exe'
foreach ($relative in @('如发机械 DSH.exe', 'resources\app.asar', 'resources\company-config.json', 'resources\node\node.exe', 'resources\harness\rufa-runtime.json', 'resources\company-plugins\company-model.mjs')) {
    if (-not (Test-Path -LiteralPath (Join-Path $source $relative) -PathType Leaf)) {
        throw "Incomplete desktop build: $relative"
    }
}
$running = Get-Process -Name '如发机械 DSH' -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $targetExe }
if ($running) { throw 'Close the project portable application before updating its files.' }
New-Item -ItemType Directory -Path $destination -Force | Out-Null
& robocopy $source $destination /E /COPY:DT /DCOPY:T /FFT /MT:16 /R:1 /W:1 /NFL /NDL /NJH /NP
if ($LASTEXITCODE -ge 8) { throw "Portable build copy failed: $LASTEXITCODE" }
foreach ($relative in @('如发机械 DSH.exe', 'resources\app.asar', 'resources\company-config.json', 'resources\node\node.exe')) {
    $expected = (Get-FileHash -LiteralPath (Join-Path $source $relative) -Algorithm SHA256).Hash
    $actual = (Get-FileHash -LiteralPath (Join-Path $destination $relative) -Algorithm SHA256).Hash
    if ($expected -ne $actual) { throw "Portable build verification failed: $relative" }
}
Write-Output "Portable build ready: $targetExe"
exit 0
