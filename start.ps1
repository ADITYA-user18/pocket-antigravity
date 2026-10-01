# =============================================================================
# Start WhatsApp ↔ Antigravity Bridge
# =============================================================================
# Usage:
#   .\start.ps1              → Run normally (for testing)
#   .\start.ps1 -Install     → Install as Windows Service (auto-starts on boot)
#   .\start.ps1 -Uninstall   → Remove the Windows Service
# =============================================================================

param(
    [switch]$Install,
    [switch]$Uninstall
)

Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  WhatsApp <-> Antigravity Bridge" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ""

Set-Location $PSScriptRoot

# Check if .env exists
if (-not (Test-Path ".env")) {
    Write-Host "  [!] .env file not found!" -ForegroundColor Yellow
    Write-Host "  Copying .env.example to .env..." -ForegroundColor Yellow
    Copy-Item ".env.example" ".env"
    Write-Host "  [!] Please edit .env with your credentials" -ForegroundColor Red
    Write-Host "  Then run this script again." -ForegroundColor Red
    Write-Host ""
    notepad ".env"
    exit 1
}

# Check if node_modules exists
if (-not (Test-Path "node_modules")) {
    Write-Host "  Installing dependencies..." -ForegroundColor Yellow
    npm install
    Write-Host ""
}

if ($Install) {
    Write-Host "  Installing as Windows Service..." -ForegroundColor Green
    Write-Host "  (This requires Administrator privileges)" -ForegroundColor Yellow
    Write-Host ""
    node install-service.js
    exit 0
}

if ($Uninstall) {
    Write-Host "  Uninstalling Windows Service..." -ForegroundColor Yellow
    node uninstall-service.js
    exit 0
}

# Normal run (foreground)
Write-Host "  Starting bridge server..." -ForegroundColor Green
Write-Host "  (Press Ctrl+C to stop)" -ForegroundColor Gray
Write-Host ""
node server.js
