param(
    [switch]$UpdateAdsSkill,
    [switch]$UpdateSalesPlanSkill
)

# Install bundled workspace Skills without overwriting a user's customized Skill.
# Update each Skill independently so updating Ads never replaces Sales Plan.
$ErrorActionPreference = 'Stop'
$skillNames = @(
    'feishu-amazon-sales-plan',
    'amazon-ads-search-term-relaunch'
)
$targetRoot = Join-Path $HOME '.codex\skills'

foreach ($name in $skillNames) {
    $source = Join-Path $PSScriptRoot ("skills\" + $name)
    $target = Join-Path $targetRoot $name
    $updateThis = ($name -eq 'amazon-ads-search-term-relaunch' -and $UpdateAdsSkill) -or
                  ($name -eq 'feishu-amazon-sales-plan' -and $UpdateSalesPlanSkill)

    if (-not (Test-Path (Join-Path $source 'SKILL.md'))) {
        Write-Warning "Bundled Skill not found, skipping: $name"
        continue
    }

    if (Test-Path $target) {
        if (-not $updateThis) {
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
Write-Host 'Skill installation finished. Existing Skills were preserved unless their specific update switch was supplied.'
Write-Host 'Update only Ads Relaunch with: .\install-skill.ps1 -UpdateAdsSkill'
Write-Host 'Update only Sales Plan with: .\install-skill.ps1 -UpdateSalesPlanSkill'
Write-Host 'Reconnect only accounts that you are authorized to access.'
