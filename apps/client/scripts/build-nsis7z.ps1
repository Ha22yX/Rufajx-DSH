param(
  [Parameter(Mandatory=$true)][string]$SevenZip,
  [Parameter(Mandatory=$true)][string]$Node,
  [string]$VisualStudio = 'D:/Program Files/Microsoft Visual Studio/18/Community',
  [string]$Toolset = 'v145',
  [string]$WindowsSdk = '10.0.26100.0'
)
$ErrorActionPreference = 'Stop'
$rufaSource = Join-Path $PSScriptRoot '../preinstalled/installer'
$rufaBuild = Join-Path $env:TEMP ('rufa-nsis7z-build-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $rufaBuild | Out-Null
$rufaArchives = @{
  '7z1900-src.7z' = '9BA70A5E8485CF9061B30A2A84FE741DE5AEB8DD271AAB8889DA0E9B3BF1868E'
  'Nsis7z_19.00.7z' = '6F2F3730049926F40442EE0C8B7D3E3DEE7ACE544D82467FF8059EA3F4201C58'
}
foreach ($rufaName in $rufaArchives.Keys) {
  $rufaArchive = Join-Path $rufaSource $rufaName
  if ((Get-FileHash -LiteralPath $rufaArchive).Hash -ne $rufaArchives[$rufaName]) { throw "Source checksum mismatch: $rufaName" }
}
& $SevenZip x (Join-Path $rufaSource '7z1900-src.7z') "-o$rufaBuild/engine" -y > "$rufaBuild/extract-engine.log"
if ($LASTEXITCODE -ne 0) { throw 'Engine source extraction failed' }
& $SevenZip x (Join-Path $rufaSource 'Nsis7z_19.00.7z') "-o$rufaBuild/plugin" -y > "$rufaBuild/extract-plugin.log"
if ($LASTEXITCODE -ne 0) { throw 'Plugin source extraction failed' }
Copy-Item -Path "$rufaBuild/plugin/Contrib/nsis7z/*" -Destination "$rufaBuild/engine" -Recurse -Force
& $Node (Join-Path $PSScriptRoot 'patch-nsis7z.mjs') "$rufaBuild/engine"
if ($LASTEXITCODE -ne 0) { throw 'Plugin source patch failed' }
$rufaProject = "$rufaBuild/engine/CPP/7zip/Bundles/Nsis7z/Nsis7z.vcxproj"
& (Join-Path $VisualStudio 'MSBuild/Current/Bin/MSBuild.exe') $rufaProject /m /nologo /verbosity:minimal '/p:Configuration=Release Unicode' /p:Platform=Win32 "/p:PlatformToolset=$Toolset" "/p:WindowsTargetPlatformVersion=$WindowsSdk" "/p:OutDir=$rufaBuild/output/" "/p:IntDir=$rufaBuild/obj/" /p:LinkIncremental=false "/flp:logfile=$rufaBuild/build.log;verbosity=normal"
if ($LASTEXITCODE -ne 0) { throw "Plugin build failed; see $rufaBuild/build.log" }
$rufaOutput = Join-Path $rufaSource 'x86-unicode'
New-Item -ItemType Directory -Path $rufaOutput -Force | Out-Null
Copy-Item -LiteralPath "$rufaBuild/output/nsis7z.dll" -Destination (Join-Path $rufaOutput 'RufaNsis7z.dll')
Get-FileHash -LiteralPath (Join-Path $rufaOutput 'RufaNsis7z.dll') | Select-Object Path,Hash | ConvertTo-Json
Write-Output "Build evidence: $rufaBuild"
