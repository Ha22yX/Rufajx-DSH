[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$sourceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$buildRoot = Join-Path $env:LOCALAPPDATA 'RufaDSH\development\workspace'
if ($sourceRoot.TrimEnd('\') -eq [IO.Path]::GetFullPath($buildRoot).TrimEnd('\')) {
    throw 'Run this script from the canonical project, not its build cache.'
}
New-Item -ItemType Directory -Path $buildRoot -Force | Out-Null
$rootFiles = @('package.json', 'package-lock.json', '.gitignore', 'AGENTS.md', 'README.md', 'upstream.lock.json', 'preinstalled.lock.json', 'tsconfig.json')
foreach ($name in $rootFiles) {
    $source = Join-Path $sourceRoot $name
    if (Test-Path -LiteralPath $source -PathType Leaf) {
        if ($name -eq 'package-lock.json') {
            try {
                $lock = Get-Content -Raw -LiteralPath $source | ConvertFrom-Json -AsHashtable -ErrorAction Stop
                if (-not $lock.lockfileVersion) { throw 'Incomplete lockfile' }
            } catch {
                Write-Warning 'Skipping incomplete canonical package-lock.json; coordinator is refreshing it.'
                continue
            }
        }
        Copy-Item -LiteralPath $source -Destination (Join-Path $buildRoot $name) -Force
    }
}
foreach ($name in @('apps', 'packages', 'docs', 'infra', 'scripts', 'tests', 'patches', 'preinstalled')) {
    $source = Join-Path $sourceRoot $name
    if (Test-Path -LiteralPath $source -PathType Container) {
        & robocopy $source (Join-Path $buildRoot $name) /E /R:1 /W:1 /XD node_modules dist coverage .git release artifacts data backups /XF '*.log' '.env' '.env.local' '.env.production' '*.sqlite' '*.sqlite-wal' '*.sqlite-shm' '*.db' /NFL /NDL /NJH /NJS /NP
        if ($LASTEXITCODE -ge 8) { throw "Source copy failed: $name ($LASTEXITCODE)" }
    }
}
Write-Output "Build workspace: $buildRoot"
Write-Output 'Copies source only; no files are deleted and no secrets are copied. Install/build/test in this local cache.'
exit 0
