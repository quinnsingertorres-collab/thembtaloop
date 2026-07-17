# deploy.ps1
# Deploys "In the Loop" by committing and pushing to git.
# Vercel is connected to this repo and auto-deploys on push to the
# tracked branch (same pattern as the bot's deployment) - this script
# doesn't call Vercel directly, it just gets your changes onto that branch.
#
# Usage:
#   .\deploy.ps1
#   .\deploy.ps1 -Message "Fixed bunching detection for terminus stops"

param(
    [string]$Message = "Update tracker - $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
)

$ErrorActionPreference = "Stop"

function Write-Step($text) {
    Write-Host ""
    Write-Host "==> $text" -ForegroundColor Cyan
}

# Confirm we're actually inside a git repo before doing anything else.
try {
    git rev-parse --is-inside-work-tree | Out-Null
} catch {
    Write-Host "This folder isn't a git repository. Run this script from inside your cloned repo." -ForegroundColor Red
    exit 1
}

Write-Step "Current branch and status"
$branch = git rev-parse --abbrev-ref HEAD
Write-Host "Branch: $branch"
git status --short

$changes = git status --porcelain
if (-not $changes) {
    Write-Host ""
    Write-Host "No changes to deploy - working tree is clean." -ForegroundColor Yellow
    exit 0
}

Write-Step "Staging all changes"
git add -A

Write-Step "Committing"
Write-Host "Message: $Message"
git commit -m "$Message"

Write-Step "Pushing to origin/$branch"
git push origin $branch

Write-Host ""
Write-Host "Pushed. Vercel should pick this up automatically - check your Vercel dashboard for build/deploy status." -ForegroundColor Green
