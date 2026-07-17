# deploy.ps1
# Deploys "In the Loop" by:
#   1. Copying any updated project files sitting in Downloads into this folder
#   2. Committing and pushing to git
# Vercel is connected to this repo and auto-deploys on push to the tracked
# branch (same pattern as the bot's deployment) - this script doesn't call
# Vercel directly, it just gets your changes onto that branch.
#
# Usage:
#   .\deploy.ps1
#   .\deploy.ps1 -Message "Fixed bunching detection for terminus stops"
#
# If you save your downloaded files somewhere other than the default
# Downloads folder, pass -DownloadsPath to point at it instead:
#   .\deploy.ps1 -DownloadsPath "C:\Users\tbtbo\Desktop"

param(
    [string]$Message = "Update tracker - $(Get-Date -Format 'yyyy-MM-dd HH:mm')",
    [string]$DownloadsPath = "$HOME\Downloads"
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

Write-Step "Checking Downloads for updated project files"

# Known project files this script knows how to sync in automatically.
# Add filenames here if new ones come up.
$filesToSync = @(
    "green-line-tracker.html",
    "sw.js",
    "manifest.json",
    "icon-192.png",
    "icon-512.png",
    "deploy.ps1",
    "setup.ps1"
)

$copiedAny = $false
foreach ($file in $filesToSync) {
    $source = Join-Path $DownloadsPath $file
    if (Test-Path $source) {
        $destination = Join-Path (Get-Location) $file
        $shouldCopy = $true
        if (Test-Path $destination) {
            $sourceTime = (Get-Item $source).LastWriteTime
            $destTime = (Get-Item $destination).LastWriteTime
            # Only copy if the Downloads version is actually newer, so this
            # doesn't clobber a file you've already placed and haven't
            # re-downloaded.
            if ($sourceTime -le $destTime) {
                $shouldCopy = $false
            }
        }
        if ($shouldCopy) {
            Copy-Item -Path $source -Destination $destination -Force
            Write-Host "  Copied $file from Downloads" -ForegroundColor Green
            $copiedAny = $true
        }
    }
}

if (-not $copiedAny) {
    Write-Host "  Nothing newer found in Downloads - using what's already in this folder." -ForegroundColor Yellow
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
