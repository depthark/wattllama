<#
.SYNOPSIS
    Stops WattLlama and removes its scheduled task. Keeps data\ (your history) and .env
    unless -RemoveData is given. Removing the optional firewall rule needs admin.
#>
param([switch]$RemoveData)

$Dir = $PSScriptRoot
Stop-ScheduledTask -TaskName 'WattLlama' -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName 'WattLlama' -Confirm:$false -ErrorAction SilentlyContinue

Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { ($_.Name -eq 'node.exe' -and $_.CommandLine -like "*$Dir\server.mjs*") -or
                   ($_.Name -eq 'powershell.exe' -and $_.CommandLine -like "*$Dir\*.ps1*" -and $_.ProcessId -ne $PID) -or
                   ($_.Name -eq 'nvidia-smi.exe' -and $_.CommandLine -like '*-lms*' -and $_.CommandLine -like '*power.draw*') } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

if (Get-NetFirewallRule -DisplayName 'WattLlama *' -ErrorAction SilentlyContinue) {
    Start-Process powershell.exe -Verb RunAs -Wait -ArgumentList '-NoProfile -Command Remove-NetFirewallRule -DisplayName ''WattLlama *'''
}
if ($RemoveData) { Remove-Item -Recurse -Force (Join-Path $Dir 'data') -ErrorAction SilentlyContinue }
Write-Host 'WattLlama stopped and removed from startup.'
