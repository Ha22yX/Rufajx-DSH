[CmdletBinding()]
param([string]$BuildRoot = (Join-Path $env:LOCALAPPDATA 'RufaDSH\development\workspace'))
$ErrorActionPreference = 'Stop'
$electronPath = Join-Path $BuildRoot 'node_modules\electron\dist\electron.exe'
$scriptPath = Join-Path $BuildRoot 'apps\client\scripts\smoke-desktop.cjs'
if (-not (Test-Path -LiteralPath $electronPath -PathType Leaf) -or -not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) {
    throw 'Build the local client workspace before running the desktop smoke.'
}
$logRoot = Join-Path ([IO.Path]::GetTempPath()) ('rufa-desktop-run-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $logRoot | Out-Null
$outPath = Join-Path $logRoot 'stdout.log'
$errPath = Join-Path $logRoot 'stderr.log'
# Redirect to durable files: a detached GUI process must not inherit a short-lived tool pipe.
$process = Start-Process -FilePath $electronPath -ArgumentList 'apps/client/scripts/smoke-desktop.cjs' -WorkingDirectory $BuildRoot -WindowStyle Hidden -RedirectStandardOutput $outPath -RedirectStandardError $errPath -PassThru
Write-Output "Desktop smoke PID: $($process.Id); logs: $logRoot"
$process.WaitForExit()
Write-Output "Desktop smoke exit: $($process.ExitCode)"
Get-Content -LiteralPath $outPath
Get-Content -LiteralPath $errPath
exit $process.ExitCode
