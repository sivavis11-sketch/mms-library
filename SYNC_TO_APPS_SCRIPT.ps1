# MMS Library — one-command frontend sync to Apps Script
# Run from the GitHub working copy after pulling the latest branch.
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$appsScript = "D:\MMS LIBRARIAN"

if (!(Test-Path $appsScript)) {
  throw "Apps Script folder not found: $appsScript"
}

Write-Host "Syncing MMS Library frontend..." -ForegroundColor Cyan
Copy-Item "$repoRoot\APPS_SCRIPT_INDEX_SYNC.html" "$appsScript\Index.html" -Force
Copy-Item "$repoRoot\APPS_SCRIPT_API_BRIDGE.gs" "$appsScript\APPS_SCRIPT_API_BRIDGE.gs" -Force

Set-Location $appsScript
clasp push

Write-Host ""
Write-Host "Frontend + API bridge pushed to Apps Script." -ForegroundColor Green
Write-Host "Now redeploy the existing production deployment." -ForegroundColor Yellow
