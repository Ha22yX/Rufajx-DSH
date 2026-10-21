param([Parameter(Mandatory=$true)][string]$OutputDirectory, [string]$TrustSource, [string]$IconPath)
$ErrorActionPreference='Stop'
$sourceRoot=Join-Path $PSScriptRoot 'updater'
if (-not $TrustSource) { $TrustSource=Join-Path $sourceRoot 'UpdateTrust.cs' }
$outputRoot=[IO.Path]::GetFullPath($OutputDirectory)
[IO.Directory]::CreateDirectory($outputRoot) | Out-Null
$compiler=Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
$output=Join-Path $outputRoot 'Rufajx-DSH.exe'
$iconOptions=@()
if ($IconPath) { $iconOptions=@("/win32icon:$([IO.Path]::GetFullPath($IconPath))") }
& $compiler /nologo /target:winexe /platform:x64 /optimize+ "/out:$output" "/win32manifest:$(Join-Path $sourceRoot 'app.manifest')" @iconOptions /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll (Join-Path $sourceRoot 'Bootstrap.cs') (Join-Path $sourceRoot 'AssemblyInfo.cs') $TrustSource
if ($LASTEXITCODE -ne 0) { throw 'Updater compilation failed' }
Copy-Item -LiteralPath (Join-Path $sourceRoot 'Rufajx-DSH.exe.config') -Destination $outputRoot
Get-FileHash -LiteralPath $output -Algorithm SHA256 | Select-Object Hash,Path
