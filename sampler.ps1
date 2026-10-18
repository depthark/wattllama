<#
.SYNOPSIS
    Streams CPU and system readings, one CSV line per interval:
        <cpuPackageW>,<dramW>,<cpuUtil%>,<cpuMHz>,<thermalZoneC>,<diskReadBps>,<diskWriteBps>
    A value the machine does not expose is written as "nan".

.DESCRIPTION
    Uses the Windows PDH API with ENGLISH counter names (PdhAddEnglishCounter), so it
    works on every display language; typeperf and Get-Counter only accept the
    localised names. The "Energy Meter" counters are Windows' own RAPL readout
    (Windows 10 1809+ / 11 on CPUs that report it). The thermal zone is the ACPI
    zone the firmware reports, which on many desktops is not the CPU core.
    Read-only, no driver, no admin rights.
#>
param([int]$IntervalMs = 2000, [int]$Count = 0)   # Count > 0: stop after that many lines

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class PdhLite {
    [StructLayout(LayoutKind.Explicit)]
    public struct Value { [FieldOffset(0)] public uint Status; [FieldOffset(8)] public double Double; }

    [DllImport("pdh.dll", CharSet = CharSet.Unicode)]
    static extern int PdhOpenQueryW(string source, IntPtr user, out IntPtr query);
    [DllImport("pdh.dll", CharSet = CharSet.Unicode)]
    static extern int PdhAddEnglishCounterW(IntPtr query, string path, IntPtr user, out IntPtr counter);
    [DllImport("pdh.dll")]
    static extern int PdhCollectQueryData(IntPtr query);
    [DllImport("pdh.dll")]
    static extern int PdhGetFormattedCounterValue(IntPtr counter, uint format, IntPtr type, out Value value);
    [DllImport("pdh.dll", CharSet = CharSet.Unicode)]
    static extern int PdhGetFormattedCounterArrayW(IntPtr counter, uint format, ref uint size, out uint count, IntPtr buffer);

    const uint PDH_FMT_DOUBLE = 0x200, PDH_FMT_NOCAP100 = 0x8000;
    const int PDH_MORE_DATA = unchecked((int)0x800007D2);
    static IntPtr query;

    public static void Open() { PdhOpenQueryW(null, IntPtr.Zero, out query); }

    // IntPtr.Zero when the counter does not exist on this machine.
    public static IntPtr Add(string path) {
        IntPtr c;
        return PdhAddEnglishCounterW(query, path, IntPtr.Zero, out c) == 0 ? c : IntPtr.Zero;
    }

    public static void Collect() { PdhCollectQueryData(query); }

    public static double Read(IntPtr counter) {
        if (counter == IntPtr.Zero) return double.NaN;
        Value v;
        if (PdhGetFormattedCounterValue(counter, PDH_FMT_DOUBLE | PDH_FMT_NOCAP100, IntPtr.Zero, out v) != 0) return double.NaN;
        return v.Status == 0 ? v.Double : double.NaN;
    }

    // Highest value over all instances of a wildcard counter, e.g. every thermal zone.
    public static double ReadMax(IntPtr counter) {
        if (counter == IntPtr.Zero) return double.NaN;
        uint size = 0, count;
        if (PdhGetFormattedCounterArrayW(counter, PDH_FMT_DOUBLE, ref size, out count, IntPtr.Zero) != PDH_MORE_DATA) return double.NaN;
        IntPtr buf = Marshal.AllocHGlobal((int)size);
        try {
            if (PdhGetFormattedCounterArrayW(counter, PDH_FMT_DOUBLE, ref size, out count, buf) != 0) return double.NaN;
            int item = IntPtr.Size + 16;   // { wchar* name; PDH_FMT_COUNTERVALUE value }
            double max = double.NaN;
            for (int i = 0; i < count; i++) {
                IntPtr p = IntPtr.Add(buf, i * item + IntPtr.Size);
                if (Marshal.ReadInt32(p) != 0) continue;
                double d = BitConverter.Int64BitsToDouble(Marshal.ReadInt64(p, 8));
                if (double.IsNaN(max) || d > max) max = d;
            }
            return max;
        } finally { Marshal.FreeHGlobal(buf); }
    }
}
'@

[PdhLite]::Open()
$pkg   = [PdhLite]::Add('\Energy Meter(RAPL_Package0_PKG)\Power')    # milliwatts
$dram  = [PdhLite]::Add('\Energy Meter(RAPL_Package0_DRAM)\Power')   # milliwatts
$util  = [PdhLite]::Add('\Processor Information(_Total)\% Processor Utility')
if ($util -eq [IntPtr]::Zero) { $util = [PdhLite]::Add('\Processor(_Total)\% Processor Time') }   # older Windows 10
$freq  = [PdhLite]::Add('\Processor Information(_Total)\Processor Frequency')         # nominal MHz
$perf  = [PdhLite]::Add('\Processor Information(_Total)\% Processor Performance')     # actual vs nominal
$zone  = [PdhLite]::Add('\Thermal Zone Information(*)\High Precision Temperature')     # tenths of kelvin
$dread = [PdhLite]::Add('\PhysicalDisk(_Total)\Disk Read Bytes/sec')
$dwrit = [PdhLite]::Add('\PhysicalDisk(_Total)\Disk Write Bytes/sec')

$inv = [Globalization.CultureInfo]::InvariantCulture
function Fmt([double]$v) {
    if ([double]::IsNaN($v) -or [double]::IsInfinity($v)) { return 'nan' }
    return $v.ToString('0.###', $inv)
}

[PdhLite]::Collect()   # rate counters need two samples
$out = [Console]::Out
$n = 0
while ($Count -le 0 -or $n -lt $Count) {
    $n++
    Start-Sleep -Milliseconds $IntervalMs
    [PdhLite]::Collect()
    $mhz = [PdhLite]::Read($freq) * [PdhLite]::Read($perf) / 100
    $tz  = [PdhLite]::ReadMax($zone) / 10 - 273.15
    $fields = @(
        (Fmt ([PdhLite]::Read($pkg) / 1000)), (Fmt ([PdhLite]::Read($dram) / 1000)), (Fmt ([PdhLite]::Read($util))),
        (Fmt $mhz), (Fmt $tz), (Fmt ([PdhLite]::Read($dread))), (Fmt ([PdhLite]::Read($dwrit)))
    )
    $out.WriteLine($fields -join ',')
    $out.Flush()
}
