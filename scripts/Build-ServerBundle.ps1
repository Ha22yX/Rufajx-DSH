[CmdletBinding()]
param([string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$buildRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ($buildRoot.StartsWith('\\') -or ([IO.DriveInfo]::new([IO.Path]::GetPathRoot($buildRoot))).DriveType -eq 'Network') {
    throw 'Build from the local build workspace, not a network share.'
}
if (-not $OutputDirectory) {
    $OutputDirectory = Join-Path $env:LOCALAPPDATA ('RufaDSH\release\server-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
}
$outputRoot = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $outputRoot) { throw 'Choose a new output directory; existing files will not be replaced.' }
Push-Location $buildRoot
try {
    & npm run build --workspace '@rufa/server'
    if ($LASTEXITCODE -ne 0) { throw 'Server build failed.' }
    New-Item -ItemType Directory -Path (Join-Path $outputRoot 'apps\server'), (Join-Path $outputRoot 'infra') -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $buildRoot 'package.json'), (Join-Path $buildRoot 'package-lock.json') -Destination $outputRoot
    $serverSource = Join-Path $buildRoot 'apps\server'
    $serverTarget = Join-Path $outputRoot 'apps\server'
    Copy-Item -LiteralPath (Join-Path $serverSource 'package.json') -Destination $serverTarget
    Copy-Item -LiteralPath (Join-Path $serverSource 'dist'), (Join-Path $serverSource 'migrations') -Destination $serverTarget -Recurse
    Copy-Item -LiteralPath (Join-Path $buildRoot 'infra\.env.example'), (Join-Path $buildRoot 'infra\README.md'), (Join-Path $buildRoot 'infra\rufa-dsh.service') -Destination (Join-Path $outputRoot 'infra')
    New-Item -ItemType Directory -Path (Join-Path $outputRoot 'docs') | Out-Null
    Copy-Item -LiteralPath (Join-Path $buildRoot 'docs\server.md') -Destination (Join-Path $outputRoot 'docs')
    Push-Location $outputRoot
    try {
        & npm ci --omit=dev --ignore-scripts --workspace '@rufa/server' --include-workspace-root=false
        if ($LASTEXITCODE -ne 0) { throw 'Production dependency installation failed.' }
    } finally { Pop-Location }
    # Runtime entry points use apps/server/dist directly. The npm workspace link
    # is unnecessary in the archive and may refer to an MSIX virtualized path.
    $workspaceLink = Join-Path $outputRoot 'node_modules\@rufa\server'
    $linkInfo = Get-Item -LiteralPath $workspaceLink -Force
    if ($linkInfo.LinkType -notin @('Junction', 'SymbolicLink')) { throw 'Unexpected workspace link type.' }
    Remove-Item -LiteralPath $workspaceLink -Force
    $archive = "$outputRoot.zip"
    Compress-Archive -Path (Join-Path $outputRoot '*') -DestinationPath $archive
    Write-Output "Server directory: $outputRoot"
    Write-Output "Server archive: $archive"
    Write-Output 'Requires Node.js 24.16+. No real credentials or company data are included.'
} finally { Pop-Location }
