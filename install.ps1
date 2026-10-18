<#
.SYNOPSIS
    Installs WattLlama for the current user: creates .env, registers a scheduled task
    that starts it at logon, starts it now and opens the page. No admin rights needed
    (except -AllowLan, which adds one firewall rule).

.PARAMETER AllowLan
    Also serve the page to other devices on your network (phone, laptop): sets
    DASH_HOST=0.0.0.0 and adds an inbound firewall rule for the port (asks for admin).

.PARAMETER NoOpen
    Do not open the page in the browser at the end.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\install.ps1
#>
param([switch]$AllowLan, [switch]$NoOpen)

$ErrorActionPreference = 'Stop'
$Dir      = $PSScriptRoot
$TaskName = 'WattLlama'

# --- Node.js 22.13+ (built-in SQLite) ---
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw 'Node.js not found. Install Node.js 22.13 or newer: winget install OpenJS.NodeJS.LTS' }
$v = [version]((& node -p 'process.versions.node').Trim())
if ($v -lt [version]'22.13.0') { throw "Node.js $v is too old; 22.13 or newer is required (winget upgrade OpenJS.NodeJS.LTS)." }
Write-Host "Node.js $v  OK"

# --- .env ---
$envFile = Join-Path $Dir '.env'
if (-not (Test-Path $envFile)) {
    Copy-Item (Join-Path $Dir '.env.example') $envFile
    Write-Host 'Created .env from .env.example'
}
$port = 8091
$m = Select-String -Path $envFile -Pattern '^\s*DASH_PORT\s*=\s*(\d+)' | Select-Object -First 1
if ($m) { $port = [int]$m.Matches[0].Groups[1].Value }

if ($AllowLan) {
    $text = [IO.File]::ReadAllText($envFile)
    $text = if ($text -match '(?m)^\s*DASH_HOST\s*=') { $text -replace '(?m)^\s*DASH_HOST\s*=.*$', 'DASH_HOST=0.0.0.0' } else { $text + "`r`nDASH_HOST=0.0.0.0`r`n" }
    # Anyone on the network could otherwise read it: require a random token.
    if ($text -notmatch '(?m)^\s*DASH_TOKEN\s*=\s*\S') {
        $bytes = New-Object byte[] 16
        [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
        $new = -join ($bytes | ForEach-Object { $_.ToString('x2') })
        $text = if ($text -match '(?m)^\s*DASH_TOKEN\s*=') { $text -replace '(?m)^\s*DASH_TOKEN\s*=.*$', "DASH_TOKEN=$new" } else { $text + "`r`nDASH_TOKEN=$new`r`n" }
    }
    $token = [regex]::Match($text, '(?m)^\s*DASH_TOKEN\s*=\s*(\S+)').Groups[1].Value
    [IO.File]::WriteAllText($envFile, $text, (New-Object Text.UTF8Encoding $false))
    $rule = "netsh advfirewall firewall add rule name=`"WattLlama $port`" dir=in action=allow protocol=TCP localport=$port profile=private"
    Start-Process powershell.exe -Verb RunAs -Wait -ArgumentList "-NoProfile -Command $rule"
    Write-Host "LAN access on: firewall rule 'WattLlama $port' (private networks only)"
    $ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.PrefixOrigin -in 'Dhcp', 'Manual' } | Select-Object -First 1).IPAddress
    Write-Host "Open this once on your phone (it remembers the token): http://${ip}:$port/?token=$token"
}

# --- what this PC can measure ---
$gpu = Get-Command nvidia-smi -ErrorAction SilentlyContinue
Write-Host ('GPU power:      ' + $(if ($gpu) { 'nvidia-smi found, measured' } else { 'no NVIDIA GPU, counted in DASH_REST_W' }))
$line = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$Dir\sampler.ps1" -IntervalMs 1000 -Count 2 | Select-Object -Last 1
$cpuW = ("$line" -split ',')[0]
Write-Host ('CPU power:      ' + $(if ($cpuW -and $cpuW -ne 'nan') { "Windows Energy Meter, measured ($cpuW W now)" } else { 'not exposed by Windows here, estimated from load (DASH_CPU_MAX_W)' }))

# --- scheduled task at logon, current user, no admin ---
$action   = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Dir\start.ps1`""
$trigger  = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$trigger.Delay = 'PT30S'
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Force `
    -Description "WattLlama power + token dashboard on http://127.0.0.1:$port" | Out-Null
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Start-ScheduledTask -TaskName $TaskName
Write-Host "Scheduled task '$TaskName' registered (starts at logon) and started"

$url = "http://127.0.0.1:$port"
$deadline = (Get-Date).AddSeconds(20)
while ((Get-Date) -lt $deadline) {
    try { Invoke-WebRequest "$url/api/live" -UseBasicParsing -TimeoutSec 2 | Out-Null; break } catch { Start-Sleep 1 }
}
Write-Host "`nWattLlama is running: $url"
if (-not $NoOpen) { Start-Process $url }
