param([switch]$UpdateExisting)

# Install the bundled workspace Skills into the current user's Codex profile.
# Existing personal Skills are preserved unless -UpdateExisting is explicitly supplied.
$ErrorActionPreference = 'Stop'
$skillNames = @(
    'feishu-amazon-sales-plan',
    'amazon-ads-search-term-relaunch'
)
$targetRoot = Join-Path $HOME '.codex\skills'

foreach ($name in $skillNames) {
    $source = Join-Path $PSScriptRoot ("skills\" + $name)
    $target = Join-Path $targetRoot $name

    if (-not (Test-Path (Join-Path $source 'SKILL.md'))) {
        Write-Warning "Bundled Skill not found, skipping: $name"
        continue
    }

    if (Test-Path $target) {
        if (-not $UpdateExisting) {
            Write-Host "Skill already exists; preserved without overwrite: $target"
            continue
        }
        Remove-Item -Path $target -Recurse -Force
    }

    New-Item -ItemType Directory -Path $targetRoot -Force | Out-Null
    Copy-Item -Path $source -Destination $target -Recurse
    Write-Host "Installed: $name -> $target"
}

Write-Host ''
Write-Host 'Skill installation finished. Existing personal Skills were not overwritten.'
Write-Host 'To intentionally replace bundled versions, rerun with: .\install-skill.ps1 -UpdateExisting'
Write-Host 'Reconnect only accounts that you are authorized to access.'
