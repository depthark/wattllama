<#
.SYNOPSIS
    Prints the Windows scheduled tasks matching the given names or wildcards as JSON:
    name, state, schedule, last run, last result, next run. Read-only.
.EXAMPLE
    .\tasks.ps1 -Patterns 'Pi*,MorningBrief'
#>
param([string]$Patterns = '')

$ErrorActionPreference = 'SilentlyContinue'
$names = @($Patterns -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })

function Describe-Trigger($t) {
    $kind = $t.CimClass.CimClassName -replace '^MSFT_Task|Trigger$', ''
    $at = if ($t.StartBoundary) { ([datetime]$t.StartBoundary).ToString('HH:mm') } else { '' }
    $text = switch ($kind) {
        'Logon'   { 'at logon' }
        'Boot'    { 'at startup' }
        'Daily'   { if ($t.DaysInterval -gt 1) { "every $($t.DaysInterval) days $at" } else { "daily $at" } }
        'Weekly'  {
            $dayNames = 'Sun','Mon','Tue','Wed','Thu','Fri','Sat'
            $days = @(0..6 | Where-Object { $t.DaysOfWeek -band (1 -shl $_) } | ForEach-Object { $dayNames[$_] }) -join ','
            "weekly $days $at"
        }
        'Time'    { "once $at" }
        default   { $kind.ToLower() }
    }
    $iv = $t.Repetition.Interval
    if ($iv) {
        $span = [System.Xml.XmlConvert]::ToTimeSpan($iv)
        $every = if ($span.TotalHours -ge 1 -and $span.TotalHours % 1 -eq 0) { "$($span.TotalHours) h" } else { "$($span.TotalMinutes) min" }
        $text = if ($kind -eq 'Time') { "every $every from $at" } else { "$text, every $every" }
    }
    if ($t.Delay) { $text += " (+$([System.Xml.XmlConvert]::ToTimeSpan($t.Delay).TotalSeconds) s)" }
    $text
}

$seen = @{}
$out = foreach ($p in $names) {
    foreach ($task in @(Get-ScheduledTask -TaskName $p)) {
        $key = $task.TaskPath + $task.TaskName
        if ($seen[$key]) { continue }
        $seen[$key] = $true
        $info = $task | Get-ScheduledTaskInfo
        [pscustomobject]@{
            name       = $task.TaskName
            state      = "$($task.State)"
            schedule   = (@($task.Triggers | Where-Object { $_.Enabled } | ForEach-Object { Describe-Trigger $_ }) -join '; ')
            lastRun    = if ($info.LastRunTime -and $info.LastRunTime.Year -gt 2000) { $info.LastRunTime.ToString('o') } else { $null }
            lastResult = $info.LastTaskResult
            nextRun    = if ($info.NextRunTime) { $info.NextRunTime.ToString('o') } else { $null }
        }
    }
}
[Console]::OutputEncoding = [Text.Encoding]::UTF8
ConvertTo-Json -InputObject @($out) -Depth 3 -Compress
