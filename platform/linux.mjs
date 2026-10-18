// Linux: everything is read from /proc and /sys in-process (no child process per sample).
//   CPU load            /proc/stat
//   CPU clock           /sys/devices/system/cpu/cpu*/cpufreq/scaling_cur_freq (else /proc/cpuinfo)
//   CPU + RAM power     RAPL (/sys/class/powercap). Since Linux 5.10 its counters are readable by
//                       root only (CVE-2020-8694), so either the optional root helper from
//                       install.sh --rapl publishes coarse 2-second watts in /run/wattllama/rapl,
//                       or, where the counters are readable, they are read directly.
//   disk I/O            /proc/diskstats (whole disks)
//   ACPI zone           /sys/class/thermal (acpitz)
//   sensors             /sys/class/hwmon: CPU, NVMe, motherboard temperatures, fans, and AMD /
//                       Intel GPU power, load and VRAM, with no extra software (LHM's job on Windows)
//   scheduled tasks     systemd timers (user and system)
//   power limit         pkexec nvidia-smi -pl (a polkit password prompt, like UAC)

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export const name = "linux";

const readText = (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return null; } };
const readNum = (f) => { const t = readText(f); const v = t == null ? NaN : Number(t.trim()); return Number.isFinite(v) ? v : null; };
const list = (d) => { try { return fs.readdirSync(d); } catch { return []; } };

export function osName(root = "/") {
  const t = readText(path.join(root, "etc/os-release")) || "";
  const v = t.match(/^PRETTY_NAME="?([^"\n]*)"?/m)?.[1] || "Linux";
  return v.replace(/[^\w .()/+-]/g, "").slice(0, 60);
}

// ---------- CPU, RAM, disk ----------

function cpuTimes(root) {
  const l = (readText(path.join(root, "proc/stat")) || "").split("\n")[0].trim().split(/\s+/).slice(1).map(Number);
  if (l.length < 4) return null;
  const idle = l[3] + (l[4] || 0);
  return { idle, total: l.slice(0, 8).reduce((a, b) => a + (b || 0), 0) };
}

function cpuMhz(root) {
  const base = path.join(root, "sys/devices/system/cpu");
  const v = list(base).filter((d) => /^cpu\d+$/.test(d)).map((d) => readNum(path.join(base, d, "cpufreq/scaling_cur_freq"))).filter((x) => x > 0);
  if (v.length) return v.reduce((a, b) => a + b, 0) / v.length / 1000;
  const m = [...(readText(path.join(root, "proc/cpuinfo")) || "").matchAll(/^cpu MHz\s*:\s*([\d.]+)/gm)].map((x) => Number(x[1]));
  return m.length ? m.reduce((a, b) => a + b, 0) / m.length : null;
}

// Whole disks only (no partitions, loop, ram or zram devices), bytes read / written.
function diskBytes(root) {
  const disks = new Set(list(path.join(root, "sys/block")).filter((d) => !/^(loop|ram|zram|dm-|md|sr|fd)/.test(d)));
  let r = 0, w = 0, any = false;
  for (const line of (readText(path.join(root, "proc/diskstats")) || "").split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10 || !disks.has(f[2])) continue;
    r += Number(f[5]) * 512; w += Number(f[9]) * 512; any = true;
  }
  return any ? { r, w } : null;
}

function acpiZone(root) {
  const base = path.join(root, "sys/class/thermal");
  for (const z of list(base).filter((d) => d.startsWith("thermal_zone"))) {
    if ((readText(path.join(base, z, "type")) || "").trim() === "acpitz") {
      const t = readNum(path.join(base, z, "temp"));
      if (t != null) return t / 1000;
    }
  }
  return null;
}

// RAPL zones: packages (intel-rapl:N, also used for AMD) and their "dram" subzones.
export function raplZones(root = "/") {
  const base = path.join(root, "sys/class/powercap");
  const zones = [];
  for (const z of list(base)) {
    const m = z.match(/^intel-rapl:(\d+)(?::(\d+))?$/);
    if (!m) continue;
    const n = (readText(path.join(base, z, "name")) || "").trim();
    const kind = m[2] == null ? (n.startsWith("package") ? "pkg" : null) : n === "dram" ? "dram" : null;
    if (kind) zones.push({ kind, file: path.join(base, z, "energy_uj"), max: readNum(path.join(base, z, "max_energy_range_uj")) });
  }
  return zones;
}

// Watts from the root helper's file "pkgW dramW epochSeconds", if fresh.
function helperWatts(root) {
  const f = (readText(path.join(root, "run/wattllama/rapl")) || "").trim().split(/\s+/).map(Number);
  if (f.length < 3 || !f.every(Number.isFinite) || Date.now() / 1000 - f[2] > 10) return null;
  return { pkg: f[0], dram: f[1] > 0 ? f[1] : null };
}

export function startCpuSampler({ intervalMs, onSample, root = "/" }) {
  const zones = raplZones(root);
  let prev = null;
  const sample = () => {
    const t = Date.now(), cpu = cpuTimes(root), disk = diskBytes(root);
    const energy = zones.map((z) => ({ ...z, e: readNum(z.file) }));        // null when not readable (root only)
    if (prev) {
      const dt = (t - prev.t) / 1000;
      const util = cpu && prev.cpu && cpu.total > prev.cpu.total ? 100 * (1 - (cpu.idle - prev.cpu.idle) / (cpu.total - prev.cpu.total)) : null;
      let pkg = null, dram = null;
      const h = helperWatts(root);
      if (h) ({ pkg, dram } = h);
      else if (energy.length && energy.every((z) => z.e != null)) {
        for (const [i, z] of energy.entries()) {
          const p = prev.energy[i]?.e;
          if (p == null) continue;
          let d = z.e - p;
          if (d < 0 && z.max) d += z.max;                                    // counter wrapped
          const w = d / 1e6 / dt;
          if (z.kind === "pkg") pkg = (pkg ?? 0) + w; else dram = (dram ?? 0) + w;
        }
      }
      onSample({ pkg, dram, util: util == null ? null : Math.max(0, Math.min(100, util)), mhz: cpuMhz(root), zone: acpiZone(root),
        diskR: disk && prev.disk ? Math.max(0, (disk.r - prev.disk.r) / dt) : null, diskW: disk && prev.disk ? Math.max(0, (disk.w - prev.disk.w) / dt) : null });
    }
    prev = { t, cpu, disk, energy };
  };
  sample();
  return setInterval(() => { try { sample(); } catch {} }, intervalMs);
}

// ---------- hwmon sensors ----------

const LABEL = { coretemp: "CPU (Intel)", k10temp: "CPU (AMD)", zenpower: "CPU (AMD)", nvme: "NVMe SSD", amdgpu: "AMD GPU",
  i915: "Intel GPU", xe: "Intel GPU", acpitz: "ACPI", drivetemp: "Disk" };
const prevEnergy = new Map();      // Intel GPUs report energy (µJ), not power

async function readOne(f) { try { return (await fsp.readFile(f, "utf8")).trim(); } catch { return null; } }
async function readNumA(f) { const t = await readOne(f); const v = t == null ? NaN : Number(t); return Number.isFinite(v) ? v : null; }

// -> { groups: [{ hardware, sensors: [{ name, kind, value, unit }] }], cpuTemp, gpus: [...] }
export async function readSensors(root = "/") {
  const base = path.join(root, "sys/class/hwmon");
  const groups = [], gpus = [];
  let cpuTemp = null;
  const n = {}, gpuIdx = {};
  for (const h of list(base).sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)))) {
    const dir = path.join(base, h);
    const chip = await readOne(path.join(dir, "name"));
    if (!chip || chip === "nvidia" || chip.startsWith("nouveau")) continue;       // NVIDIA comes from nvidia-smi
    const files = list(dir);
    const sensors = [];
    for (const f of files) {
      const m = f.match(/^(temp|fan)(\d+)_input$/);
      if (!m) continue;
      const v = await readNumA(path.join(dir, f));
      if (v == null || (m[1] === "temp" && (v <= -40000 || v >= 150000))) continue;
      const label = await readOne(path.join(dir, `${m[1]}${m[2]}_label`));
      sensors.push(m[1] === "temp" ? { name: label || `temp ${m[2]}`, kind: "temperature", value: v / 1000, unit: "°C" }
        : { name: label || `fan ${m[2]}`, kind: "fan", value: v, unit: "RPM" });
    }
    n[chip] = (n[chip] || 0) + 1;
    const hardware = `${LABEL[chip] || chip}${n[chip] > 1 ? ` ${n[chip]}` : ""}`;
    if (chip === "coretemp" || chip === "k10temp" || chip === "zenpower") {
      const pkg = sensors.find((s) => /package|tctl|tdie/i.test(s.name)) || [...sensors].sort((a, b) => b.value - a.value)[0];
      if (pkg && cpuTemp == null) cpuTemp = pkg.value;
    }
    if (["amdgpu", "i915", "xe"].includes(chip)) {
      const g = await gpuFromHwmon(chip, dir, sensors, hardware, gpuIdx[chip] || 0);
      if (g) { gpus.push(g); gpuIdx[chip] = (gpuIdx[chip] || 0) + 1; }
      if (g && sensors.length) { groups.push({ hardware: g.name, sensors }); continue; }
    }
    if (sensors.length) groups.push({ hardware, sensors });
  }
  return { groups, cpuTemp, gpus };
}

// AMD (amdgpu) and Intel (i915 / xe) GPUs. Integrated graphics are skipped: their power is
// part of the CPU package, which RAPL already measures.
async function gpuFromHwmon(chip, dir, sensors, hardware, i) {
  const dev = path.join(dir, "device");
  const vramTotal = await readNumA(path.join(dev, "mem_info_vram_total"));
  if (chip === "amdgpu" && vramTotal != null && vramTotal < 3 * 1024 ** 3) return null;          // APU carve-out
  if (chip !== "amdgpu" && !list(path.join(dev, "drm")).length) return null;
  if (chip === "i915" && vramTotal == null && !(await readOne(path.join(dev, "lmem_total_bytes")))) return null;   // iGPU
  let power = await readNumA(path.join(dir, "power1_average")) ?? await readNumA(path.join(dir, "power1_input"));
  if (power != null) power /= 1e6;
  else {
    const e = await readNumA(path.join(dir, "energy1_input"));
    if (e != null) {
      const p = prevEnergy.get(dir), t = Date.now();
      prevEnergy.set(dir, { e, t });
      if (p && t > p.t && e >= p.e) power = (e - p.e) / 1e6 / ((t - p.t) / 1000);
    }
  }
  if (power == null) return null;
  const product = (await readOne(path.join(dev, "product_name"))) || hardware;
  const temp = sensors.find((s) => s.kind === "temperature" && /edge|gpu|pkg/i.test(s.name)) || sensors.find((s) => s.kind === "temperature");
  const fanRpm = sensors.find((s) => s.kind === "fan");
  const sclk = await readNumA(path.join(dir, "freq1_input")), mclk = await readNumA(path.join(dir, "freq2_input"));
  const vramUsed = await readNumA(path.join(dev, "mem_info_vram_used"));
  return { t: Date.now(), index: `${chip}${i}`, name: product, power, source: "Linux hwmon",
    temp: temp?.value ?? null, util: await readNumA(path.join(dev, "gpu_busy_percent")), fan: null, fanRpm: fanRpm?.value ?? null,
    vramUsed: vramUsed == null ? null : vramUsed / 1048576, vramTotal: vramTotal == null ? null : vramTotal / 1048576,
    clockSm: sclk == null ? null : Math.round(sclk / 1e6), clockMem: mclk == null ? null : Math.round(mclk / 1e6),
    limit: null, limitMin: null, throttle: [] };
}

// ---------- systemd timers ----------

// Patterns like "backup*,llm-update" match timer names (without ".timer").
export async function scheduledTasks(patterns, { run$ }) {
  const res = patterns.split(",").map((p) => p.trim()).filter(Boolean)
    .map((p) => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i"));
  const out = [];
  for (const scope of [["--user"], []]) {
    let units;
    try { units = JSON.parse(await run$("systemctl", [...scope, "list-timers", "--all", "--output=json", "--no-pager"])); } catch { continue; }
    for (const u of units || []) {
      const timer = String(u.unit || ""), base = timer.replace(/\.timer$/, "");
      if (!res.some((r) => r.test(base))) continue;
      const svc = String(u.activates || `${base}.service`);
      let props = {};
      try {
        const txt = await run$("systemctl", [...scope, "show", timer, svc, "-p", "TimersCalendar,TimersMonotonic,UnitFileState,ActiveState,Result,ExecMainStatus,Id", "--no-pager"]);
        for (const block of txt.split(/\n\n/)) {
          const kv = Object.fromEntries(block.split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
          props[kv.Id] = kv;
        }
      } catch {}
      const t = props[timer] || {}, s = props[svc] || {};
      const cal = (t.TimersCalendar || "").match(/OnCalendar=([^;]+)/)?.[1]?.trim();
      const mono = (t.TimersMonotonic || "").match(/(OnBootUSec|OnStartupUSec|OnUnitActiveUSec|OnActiveUSec)=([^;]+)/);
      const us = (v) => v ? new Date(Number(v) / 1000).toISOString() : null;
      out.push({ name: base, state: t.UnitFileState === "disabled" ? "Disabled" : s.ActiveState === "active" || s.ActiveState === "activating" ? "Running" : "Ready",
        schedule: cal || (mono ? `${mono[1].replace("USec", "")} ${mono[2].trim()}` : "–"),
        lastRun: us(u.last), nextRun: us(u.next),
        lastResult: !u.last ? 267011 : s.Result === "success" || s.ExecMainStatus === "0" ? 0 : Number(s.ExecMainStatus) || 1 });
    }
  }
  return out;
}

// ---------- NVIDIA power limit ----------

// pkexec asks for the password in a polkit dialog (the desktop's UAC); index and watts are
// validated integers, passed as separate arguments (no shell).
export function powerLimitCommand(index, watts) {
  return ["pkexec", ["nvidia-smi", "-i", String(index), "-pl", String(watts)]];
}
export const elevation = "the password prompt";
