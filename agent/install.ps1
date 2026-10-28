<#
.SYNOPSIS
  Starts Pitu at logon: hidden, below-normal priority, brought back if it dies.

.EXAMPLE
  .\install.ps1              # register (or update) and start now
  .\install.ps1 -Uninstall   # stop and remove
#>
param(
    [switch]$Uninstall,
    [string]$TaskName = 'Pitu voice assistant'
)

$ErrorActionPreference = 'Stop'
$agentDir = $PSScriptRoot
$pythonw = Join-Path $agentDir '.venv\Scripts\pythonw.exe'
$user = "$env:USERDOMAIN\$env:USERNAME"

if ($Uninstall) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Stop-ScheduledTask -TaskName $TaskName
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "Removed '$TaskName'."
    } else {
        Write-Host "'$TaskName' is not installed."
    }
    return
}

if (-not (Test-Path $pythonw)) {
    throw "Missing $pythonw - create the venv first (see agent\README.md)."
}
if (-not (Test-Path (Join-Path $agentDir '.env'))) {
    Write-Warning 'agent\.env is missing: Pitu will start but can only say that its keys are missing.'
}

$action = New-ScheduledTaskAction -Execute $pythonw -Argument '-m pitu' -WorkingDirectory $agentDir

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
# Audio devices and the network are still coming up right after logon.
$trigger.Delay = 'PT15S'
# Restart-on-failure only covers a failed launch, not a crash later on; a
# repeating trigger with IgnoreNew re-launches a dead agent within 5 minutes.
$trigger.Repetition = (New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5)).Repetition

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
    -Priority 7

$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Host "Installed '$TaskName' and started it. Log: $agentDir\data\logs\pitu.log"
