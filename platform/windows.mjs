// Windows: CPU / RAM / disk from performance counters (sampler.ps1, one long-running
// PowerShell process), scheduled tasks from Task Scheduler (tasks.ps1, on demand), the
// NVIDIA power limit through a UAC prompt. Sensors beyond that need LibreHardwareMonitor.

import os from "node:os";
import path from "node:path";

export const name = "windows";

export function osName() {
  const rel = os.release().split(".").map(Number);
  return rel[0] === 10 ? (rel[2] >= 22000 ? "Windows 11" : "Windows 10") : `Windows ${os.release()}`;
}

// onSample({ pkg, dram, util, mhz, zone, diskR, diskW }), every intervalMs; null = not available.
export function startCpuSampler({ intervalMs, dir, stream, num, onSample }) {
  stream("sampler", "powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(dir, "sampler.ps1"), "-IntervalMs", String(intervalMs),
  ], (line) => {
    const [pkg, dram, util, mhz, zone, diskR, diskW] = line.split(",").map(num);
    onSample({ pkg, dram, util, mhz, zone, diskR, diskW });
  });
}

// No driver-free sensors on Windows: LibreHardwareMonitor (DASH_LHM_URL) covers them.
export const readSensors = null;

export async function scheduledTasks(patterns, { run$, dir }) {
  const out = await run$("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
    path.join(dir, "tasks.ps1"), "-Patterns", patterns]);
  return JSON.parse(out || "[]");
}

// index and watts are validated integers. nvidia-smi -pl needs admin, hence the UAC prompt.
export function powerLimitCommand(index, watts) {
  const ps = `$p = Start-Process -FilePath nvidia-smi -ArgumentList '-i','${index}','-pl','${watts}' -Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $p.ExitCode`;
  return ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps]];
}
export const elevation = "the UAC prompt";
