# =============================================================================
# Register WhatsApp Bridge to auto-start on login via Task Scheduler
# =============================================================================
# Run this ONCE (as Administrator for best results):
#   powershell -ExecutionPolicy Bypass -File install-task.ps1
#
# This creates a scheduled task that:
#   - Starts the bridge when you log in
#   - Runs hidden (no console window)
#   - Auto-restarts if it stops
# =============================================================================

$taskName = "WhatsApp Antigravity Bridge"
$scriptPath = Join-Path $PSScriptRoot "server.js"
$workingDir = $PSScriptRoot

# Check if task already exists
$existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existingTask) {
    Write-Host ""
    Write-Host "  Task '$taskName' already exists. Removing old one..." -ForegroundColor Yellow
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}

# Create the action: run node server.js
$action = New-ScheduledTaskAction `
    -Execute "node.exe" `
    -Argument "`"$scriptPath`"" `
    -WorkingDirectory $workingDir

# Trigger: on user logon
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

# Settings: restart on failure, don't stop on idle, run indefinitely
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Days 0)

# Register the task
Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description "Bridges WhatsApp messages to Antigravity IDE agent. Auto-starts on login, auto-restarts on failure." `
    -RunLevel Highest

Write-Host ""
Write-Host "  ============================================================" -ForegroundColor Green
Write-Host "  ✅ Task '$taskName' registered successfully!" -ForegroundColor Green
Write-Host "  ============================================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Auto-start on login: YES" -ForegroundColor White
Write-Host "  Auto-restart on crash: YES (every 1 min, up to 999 times)" -ForegroundColor White
Write-Host "  Script: $scriptPath" -ForegroundColor Gray
Write-Host ""

# Start it now
Write-Host "  Starting the task now..." -ForegroundColor Cyan
Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 3

$task = Get-ScheduledTask -TaskName $taskName
Write-Host "  Status: $($task.State)" -ForegroundColor Green
Write-Host ""
Write-Host "  To check status: Get-ScheduledTask -TaskName '$taskName'" -ForegroundColor Gray
Write-Host "  To stop:         Stop-ScheduledTask -TaskName '$taskName'" -ForegroundColor Gray
Write-Host "  To uninstall:    Unregister-ScheduledTask -TaskName '$taskName'" -ForegroundColor Gray
Write-Host ""
