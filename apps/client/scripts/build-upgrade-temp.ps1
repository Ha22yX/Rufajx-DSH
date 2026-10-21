param([string]$VisualStudio = 'D:/Program Files/Microsoft Visual Studio/18/Community', [string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$rufaBuild = Join-Path $env:LOCALAPPDATA ('RufaDSH/Build/installer-upgrade-helper/' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $rufaBuild | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'installer-upgrade-temp.cpp') -Destination $rufaBuild
$rufaCompile = @"
@echo off
call "$VisualStudio\VC\Auxiliary\Build\vcvars32.bat" >nul
if errorlevel 1 exit /b 1
cd /d "$rufaBuild"
cl /nologo /std:c++17 /EHsc /O2 /MT /W4 /LD installer-upgrade-temp.cpp /link /OUT:RufaUpgradeTemp.dll advapi32.lib ole32.lib user32.lib
"@
$rufaCompile | Set-Content -LiteralPath "$rufaBuild/build.cmd" -Encoding ascii
& $env:ComSpec /d /c "$rufaBuild/build.cmd" > "$rufaBuild/build.log" 2>&1
if ($LASTEXITCODE -ne 0) { Get-Content -LiteralPath "$rufaBuild/build.log"; throw 'Upgrade helper build failed' }
$rufaOutput = if ($OutputDirectory) { [IO.Path]::GetFullPath($OutputDirectory) } else { Join-Path $PSScriptRoot '../preinstalled/installer/x86-unicode' }
New-Item -ItemType Directory -Path $rufaOutput -Force | Out-Null
Copy-Item -LiteralPath "$rufaBuild/RufaUpgradeTemp.dll" -Destination $rufaOutput -Force
Get-FileHash -LiteralPath (Join-Path $rufaOutput 'RufaUpgradeTemp.dll') | Select-Object Path,Hash | ConvertTo-Json
Write-Output "Build evidence: $rufaBuild"
