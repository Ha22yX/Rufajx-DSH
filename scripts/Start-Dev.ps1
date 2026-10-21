[CmdletBinding()]
param([int]$InspectPort = 0)
$ErrorActionPreference = 'Stop'
if ($InspectPort -ne 0 -and ($InspectPort -lt 1024 -or $InspectPort -gt 65535)) { throw 'Invalid local inspector port.' }
$workspace = Join-Path $env:LOCALAPPDATA 'RufaDSH\development\workspace'
$clientRoot = Join-Path $workspace 'apps\client'
$electron = Join-Path $workspace 'node_modules\electron\dist\electron.exe'
$node = Join-Path $clientRoot 'node-runtime\node.exe'
$tsc = Join-Path $workspace 'node_modules\typescript\bin\tsc'
$runtime = Join-Path $clientRoot 'runtime'
# Native browser modules hot-reload while the host graph stays alive. Never
# replace their version beneath a running desktop; update both on next launch.
$existingClient = Get-CimInstance Win32_Process -Filter "Name = 'electron.exe'" | Where-Object {
    $_.CommandLine -and $_.CommandLine.Contains($clientRoot) -and $_.CommandLine -notmatch '--type='
}
if ($existingClient) { throw 'Development client is still running. Close it before updating its runtime.' }
foreach ($required in @($electron, $node, $tsc, (Join-Path $runtime 'rufa-runtime.json'))) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Existing development dependency missing: $required" }
}
& (Join-Path $PSScriptRoot 'Sync-BuildWorkspace.ps1')
if ($LASTEXITCODE -ne 0) { throw 'Source sync failed.' }
Push-Location $workspace
try {
    Write-Output 'Compiling the company client only; reusing the existing Harness runtime.'
    & $node (Join-Path $PSScriptRoot 'brand-runtime.mjs') $runtime $workspace
    if ($LASTEXITCODE -ne 0) { throw 'Runtime brand customization failed.' }
    & $node (Join-Path $PSScriptRoot 'badge-runtime.mjs') $runtime
    if ($LASTEXITCODE -ne 0) { throw 'Company badge customization failed.' }
    & $node (Join-Path $PSScriptRoot 'history-runtime.mjs') $runtime
    if ($LASTEXITCODE -ne 0) { throw 'Runtime history customization failed.' }
    & $node (Join-Path $clientRoot 'scripts\continuation-runtime.mjs') $runtime
    if ($LASTEXITCODE -ne 0) { throw 'Runtime continuation customization failed.' }
    & $node (Join-Path $clientRoot 'scripts\projects-runtime.mjs') $runtime
    if ($LASTEXITCODE -ne 0) { throw 'Runtime projects customization failed.' }
    & $node (Join-Path $PSScriptRoot 'preinstalled-runtime.mjs') $runtime --sync-wrappers
    if ($LASTEXITCODE -ne 0) { throw 'Preinstalled Office/PDF/OCR plugins are not prepared.' }
    & $node (Join-Path $PSScriptRoot 'sidebar-runtime.mjs') $runtime
    if ($LASTEXITCODE -ne 0) { throw 'Preinstalled Better Sidebar is not prepared.' }
    & $node (Join-Path $PSScriptRoot 'media-preview-runtime.mjs') $runtime
    if ($LASTEXITCODE -ne 0) { throw 'Preinstalled video/audio previews are not prepared.' }
    & $node (Join-Path $PSScriptRoot 'desktop-video-runtime.mjs') $runtime
    if ($LASTEXITCODE -ne 0) { throw 'Preinstalled computer control/video creation runtime is not prepared.' }
    & $node (Join-Path $PSScriptRoot 'solidworks-runtime.mjs') prepare $runtime
    if ($LASTEXITCODE -ne 0) { throw 'Preinstalled SolidWorks toolkit is not prepared.' }
    # The Codex Windows host can virtualize LOCALAPPDATA without making the
    # runtime itself a symlink. Pass its physical path to the strict slim guard.
    $canonicalRuntime = & $node -e "process.stdout.write(require('node:fs').realpathSync.native(process.argv[1]))" $runtime
    if ($LASTEXITCODE -ne 0 -or -not $canonicalRuntime) { throw 'Could not resolve the runtime directory.' }
    & $node (Join-Path $clientRoot 'scripts\runtime-slim.mjs') $canonicalRuntime --apply
    if ($LASTEXITCODE -ne 0) { throw 'Pinned Windows x64 runtime optimization failed.' }
    & $node $tsc -p (Join-Path $clientRoot 'tsconfig.json')
    if ($LASTEXITCODE -ne 0) { throw 'Client compilation failed.' }
    & $node (Join-Path $clientRoot 'scripts\copy-assets.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Client assets copy failed.' }
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    foreach ($testVariable in @('RUFA_TEST_HIDE_WINDOW', 'RUFA_TEST_USER_DATA', 'RUFA_TEST_DIAGNOSTIC', 'RUFA_TEST_SERVER_URL')) {
        Remove-Item "Env:$testVariable" -ErrorAction SilentlyContinue
    }
    $env:RUFA_UPSTREAM_ROOT = $runtime
    Remove-Item Env:RUFA_SERVER_URL -ErrorAction SilentlyContinue
    Write-Output 'Starting development client. Close the app to end this session.'
    $launchArguments = '"{0}"' -f $clientRoot
    if ($InspectPort) { $launchArguments += " --remote-debugging-address=127.0.0.1 --remote-debugging-port=$InspectPort" }
    $process = Start-Process -FilePath $electron -ArgumentList $launchArguments -WorkingDirectory $clientRoot -PassThru
    $process.WaitForExit()
    exit $process.ExitCode
} finally { Pop-Location }
