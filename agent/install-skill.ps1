# Install the checked-in general sales-plan skill into the current user's Codex.
# Never overwrites an existing skill; credentials are not copied.
$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot 'skills\feishu-amazon-sales-plan'
$target = Join-Path $HOME '.codex\skills\feishu-amazon-sales-plan'
if (-not (Test-Path $source)) { throw "Bundled skill not found: $source" }
if (Test-Path $target) {
    Write-Host "Sales-plan Skill already exists. Not overwriting: $target"
    exit 0
}
New-Item -ItemType Directory -Path (Split-Path $target -Parent) -Force | Out-Null
Copy-Item -Path $source -Destination $target -Recurse
Write-Host "Skill installed at: $target"
Write-Host 'Next, reconnect only accounts that you are authorized to access.'