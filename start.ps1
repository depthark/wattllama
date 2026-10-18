<#
.SYNOPSIS
    Runs WattLlama and restarts it if it exits. The scheduled task created by
    install.ps1 starts this at logon; you can also run it by hand.
#>
$ErrorActionPreference = 'Stop'

$Dir   = $PSScriptRoot
$Data  = Join-Path $Dir 'data'
$Entry = Join-Path $Dir 'server.mjs'
New-Item -ItemType Directory -Force -Path $Data | Out-Null

$Node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $Node) { throw 'Node.js not found. Install Node.js 22.13+ (winget install OpenJS.NodeJS.LTS).' }

# The streaming samplers a killed server leaves behind, recognisable by their arguments.
function Stop-Strays {
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object { ($_.Name -eq 'node.exe' -and $_.CommandLine -like "*$Entry*") -or
                       ($_.Name -eq 'powershell.exe' -and $_.CommandLine -like "*$Dir\sampler.ps1*") -or
                       ($_.Name -eq 'nvidia-smi.exe' -and $_.CommandLine -like '*-lms*' -and $_.CommandLine -like '*power.draw*') } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

while ($true) {
    Stop-Strays
    $p = Start-Process -FilePath $Node -ArgumentList @('--no-warnings', "`"$Entry`"") -WorkingDirectory $Dir `
        -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $Data 'wattllama.log') `
        -RedirectStandardError  (Join-Path $Data 'wattllama.err.log')
    $p.WaitForExit()
    Start-Sleep -Seconds 10
}
