// WattLlama: what your PC (Windows or Linux) draws, how much energy it used over time,
// and how much of that went into local LLM generation.
//
// Every 2 s, with no drivers and no admin rights:
//   GPU      nvidia-smi (streaming), measured watts / temperature / VRAM, every NVIDIA card
//   CPU+RAM  RAPL energy counters (Windows "Energy Meter" / Linux powercap), measured watts;
//            without them, an estimate from CPU utilisation (DASH_CPU_MAX_W)
//   rest     motherboard, disks, fans: DASH_REST_W, then the PSU loss (DASH_PSU_EFF)
//   LLM      llama.cpp and other engines (engines/): is it generating, how many tokens
// One row per minute goes to SQLite (data/power.db); one page shows it.

import http from "node:http";
import { spawn, execFile } from "node:child_process";
import os from "node:os";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ENGINES } from "./engines/index.mjs";
import { createAlerts } from "./alerts.mjs";
import { openDatabase } from "./db.mjs";
// Everything that differs between Windows and Linux lives in platform/.
const PLATFORM = await import(process.platform === "win32" ? "./platform/windows.mjs" : "./platform/linux.mjs");

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`Node.js 22.13 or newer is required (node:sqlite); this is ${process.version}.`);
  process.exit(1);
}
const { DatabaseSync } = await import("node:sqlite");

const DIR = path.dirname(fileURLToPath(import.meta.url));
loadEnv(path.join(DIR, ".env"));

// node server.mjs --test-alert: send one test message to DASH_ALERT_WEBHOOK and exit.
if (process.argv.includes("--test-alert")) {
  const a = createAlerts({ env: process.env, db: new DatabaseSync(":memory:"), log: (...m) => console.log(...m) });
  const s = a.settings();
  if (!s.webhook || s.webhook === "invalid") { console.log("DASH_ALERT_WEBHOOK is not set or not valid (see .env.example)."); process.exit(1); }
  const ok = await a.test();
  console.log(ok ? `Test alert sent (${s.webhook}).` : "Test alert failed, see above.");
  process.exit(ok ? 0 : 1);
}

const CFG = {
  host: process.env.DASH_HOST || "127.0.0.1",
  port: Number(process.env.DASH_PORT || 8091),
  restW: Number(process.env.DASH_REST_W || 35),
  psuEff: Number(process.env.DASH_PSU_EFF || 0.88),
  cpuMaxW: Number(process.env.DASH_CPU_MAX_W || 65),
  intervalMs: Number(process.env.DASH_INTERVAL_MS || 2000),
  // Optional: what a kWh costs you (all-in: energy, distribution, fees, tax) and its currency.
  // Unset = watts and kWh only.
  price: ((p) => Number.isFinite(p) && p > 0 && p < 1000 ? p : null)(parseFloat(String(process.env.DASH_PRICE_PER_KWH || "").replace(",", "."))),
  currency: String(process.env.DASH_CURRENCY || "").trim().slice(0, 8),
  dataDir: path.resolve(DIR, process.env.DASH_DATA_DIR || "data"),
};

// .env: a later line for the same setting wins (as when you add one at the end, and as
// install.ps1 / install.sh read it); a real environment variable wins over the file.
function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  const vals = new Map();
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) vals.set(m[1], m[2].replace(/^"(.*)"$/, "$1"));
  }
  for (const [k, v] of vals) if (!(k in process.env)) process.env[k] = v;
}

const log = (...a) => console.log(new Date().toISOString(), ...a);
const num = (s) => { const v = parseFloat(String(s).trim()); return Number.isFinite(v) ? v : null; };

// ---------- streaming samplers ----------

const children = new Set();
process.on("exit", () => { for (const p of children) p.kill(); });

function stream(name, cmd, args, onLine, { giveUpOnMissing = false } = {}) {
  const start = () => {
    let done = false;
    const again = (why) => {
      if (done) return;
      done = true;
      log(`${name} ${why}, restarting in 10 s`);
      setTimeout(start, 10_000);
    };
    const p = spawn(cmd, args, { windowsHide: true });
    children.add(p);
    let buf = "";
    p.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) { try { onLine(line); } catch (e) { log(`${name}: ${e.message}`); } }
      }
    });
    p.on("exit", (code) => { children.delete(p); again(`exited (${code})`); });
    p.on("error", (e) => {
      if (giveUpOnMissing && e.code === "ENOENT") { done = true; log(`${name} not found, skipping`); return; }
      again(`failed: ${e.message}`);
    });
  };
  start();
}

const live = {
  gpus: new Map(),       // index -> nvidia-smi reading, see below
  cpu: null,             // { t, pkgW, dramW, util, mhz, zoneC, diskR, diskW, measured }
  lhm: null,             // { t, groups: [{ hardware, sensors: [{ name, kind, value, unit }] }], cpuTemp }
  lhmGpus: [],           // AMD / Intel GPUs read from LibreHardwareMonitor, same shape as gpus
  llm: { t: 0, reachable: false, processing: false, models: [], engines: [] },
  sysW: null,
};

// Lowest power limit WattLlama accepts: 60 % of the card's default, and never below the
// driver's own minimum. The driver range is already safe (a power cap is not an undervolt:
// it only slows the card down); the extra margin keeps it from feeling broken.
const safeFloor = (min, def) => min == null ? null : Math.max(Math.ceil(min), def ? Math.ceil(def * 0.6 / 5) * 5 : 0);

// nvidia-smi clocks_event_reasons bits: why the GPU is not at full clocks right now.
const THROTTLE = [[0x4, "power cap"], [0x8, "HW slowdown"], [0x20, "thermal (SW)"], [0x40, "thermal (HW)"],
  [0x80, "power brake"], [0x2, "app clocks"], [0x10, "sync boost"], [0x100, "display clocks"], [0x1, "idle"]];
const throttleText = (hex) => {
  const v = parseInt(hex, 16);
  return Number.isFinite(v) && v ? THROTTLE.filter(([b]) => v & b).map(([, t]) => t) : [];
};

const GPU_FIELDS = ["index", "name", "temperature.gpu", "power.draw", "memory.used", "memory.total", "utilization.gpu",
  "fan.speed", "clocks.sm", "clocks.mem", "power.limit", "power.default_limit", "power.min_limit", "power.max_limit",
  "clocks_event_reasons.active", "pstate", "pcie.link.gen.current", "pcie.link.width.current", "utilization.memory"];
stream("nvidia-smi", "nvidia-smi", [
  `--query-gpu=${GPU_FIELDS.join(",")}`, "--format=csv,noheader,nounits", "-lms", String(CFG.intervalMs),
], (line) => {
  const f = line.split(",").map((s) => s.trim());
  if (f.length < GPU_FIELDS.length) return;
  const power = num(f[3]);
  if (power == null) return;
  live.gpus.set(f[0], { t: Date.now(), index: f[0], name: f[1], temp: num(f[2]), power,
    vramUsed: num(f[4]), vramTotal: num(f[5]), util: num(f[6]), fan: num(f[7]), clockSm: num(f[8]), clockMem: num(f[9]),
    limit: num(f[10]), limitDefault: num(f[11]), limitMin: num(f[12]), limitMax: num(f[13]),
    throttle: throttleText(f[14]), pstate: f[15], pcie: num(f[16]) ? `Gen${f[16]} x${f[17]}` : null, memUtil: num(f[18]),
    safeMin: safeFloor(num(f[12]), num(f[11])) });
}, { giveUpOnMissing: true });

PLATFORM.startCpuSampler({ intervalMs: CFG.intervalMs, dir: DIR, stream, num, onSample: ({ pkg, dram, util, mhz, zone, diskR, diskW }) => {
  if (util == null && pkg == null) return;
  const u = Math.min(util ?? 0, 100);
  const measured = pkg != null;
  // Without RAPL: idle ~15 % of the CPU's max package power, rising linearly with load.
  const pkgW = measured ? pkg : CFG.cpuMaxW * (0.15 + 0.85 * u / 100);
  live.cpu = { t: Date.now(), pkgW, dramW: dram ?? 0, util: u, mhz, zoneC: zone != null && zone > 0 && zone < 120 ? zone : null,
    diskR, diskW, measured };
} });

// Optional: LibreHardwareMonitor's web server (Options > Remote Web Server) has what
// Windows does not give without a driver: CPU core temperatures, fans, motherboard,
// SSD temperatures. Its data.json is a tree; leaves with a unit are sensors.
const LHM_URL = (process.env.DASH_LHM_URL || "").replace(/\/$/, "");
async function pollLHM() {
  if (!LHM_URL) return;
  try {
    const root = await (await fetch(`${LHM_URL}/data.json`, { signal: AbortSignal.timeout(3000) })).json();
    const groups = new Map(), gpuHw = new Map();
    const walk = (node, hardware, depth) => {
      const hw = depth === 2 ? node.Text : hardware;      // root > computer > hardware > group > sensor
      for (const c of node.Children || []) walk(c, hw, depth + 1);
      if (node.Children?.length || !hw) return;
      const m = String(node.Value || "").match(/^(-?[\d.,]+)\s*(°C|RPM|W|%|MHz|V|GB|MB|MB\/s|KB\/s)$/);
      if (!m) return;
      const unit = m[2], value = Number(m[1].replace(",", "."));
      const kind = { "°C": "temperature", RPM: "fan", W: "power", "%": "load", MHz: "clock", V: "voltage" }[unit] || "data";
      const vendor = String(node.SensorId || "").match(/^\/gpu-(amd|intel)/)?.[1];
      if (vendor) {      // AMD / Intel GPUs: nvidia-smi does not see them, Windows has no watts for them
        if (!gpuHw.has(hw)) gpuHw.set(hw, { vendor, sensors: [] });
        gpuHw.get(hw).sensors.push({ name: node.Text, kind, value, unit });
      }
      if (!["temperature", "fan"].includes(kind)) return;     // the rest is already measured above
      if (!groups.has(hw)) groups.set(hw, []);
      groups.get(hw).push({ name: node.Text, kind, value, unit });
    };
    walk(root, null, 0);
    live.lhmGpus = lhmGpus(gpuHw);
    const all = [...groups.values()].flat();
    // CPU temperature: Intel "CPU Package", AMD "Core (Tctl/Tdie)", else the hottest core.
    const cpuGroup = [...groups].find(([hw]) => /intel|amd|ryzen|core|cpu/i.test(hw) && !/nvidia|radeon rx|geforce/i.test(hw));
    const cpuSensors = cpuGroup ? cpuGroup[1].filter((s) => s.kind === "temperature") : [];
    const pkg = cpuSensors.find((s) => /package|tctl|tdie/i.test(s.name)) || cpuSensors.sort((a, b) => b.value - a.value)[0];
    live.lhm = { t: Date.now(), cpuTemp: pkg?.value ?? null, count: all.length,
      groups: [...groups].map(([hardware, sensors]) => ({ hardware, sensors })) };
  } catch {
    live.lhm = live.lhm && Date.now() - live.lhm.t < 30_000 ? live.lhm : null;
    if (!live.lhm) live.lhmGpus = [];
  }
}

// Integrated graphics draw from the CPU package, which RAPL already measures: skip them.
const INTEGRATED_GPU = /radeon\(tm\) graphics|radeon graphics|vega \d+ graphics|\b(uhd|iris|hd) graphics|intel\(r\) graphics|arc\(tm\) graphics|780m|880m|890m/i;
function lhmGpus(gpuHw) {
  const out = [];
  let i = 0;
  for (const [name, { vendor, sensors }] of gpuHw) {
    if (INTEGRATED_GPU.test(name)) continue;
    const of = (kind) => sensors.filter((s) => s.kind === kind);
    const pw = of("power"), pick = (list, re) => list.find((s) => re.test(s.name));
    const power = (pick(pw, /package|total|board|^gpu power$/i) || pw.sort((a, b) => b.value - a.value)[0])?.value;
    if (power == null) continue;
    const temps = of("temperature");
    const mem = (re) => { const s = pick(sensors.filter((x) => x.unit === "MB" || x.unit === "GB"), re); return s ? s.value * (s.unit === "GB" ? 1024 : 1) : null; };
    out.push({ t: Date.now(), index: `${vendor}${i++}`, name, power, source: "LibreHardwareMonitor",
      temp: (pick(temps, /core|edge|^gpu$/i) || temps[0])?.value ?? null,
      util: pick(of("load"), /core|^gpu$|3d/i)?.value ?? null,
      fan: null, vramUsed: mem(/memory used|vram used|dedicated memory used/i), vramTotal: mem(/memory total|vram total|dedicated memory total/i),
      clockSm: pick(of("clock"), /core|shader|gpu/i)?.value ?? null, clockMem: pick(of("clock"), /memory/i)?.value ?? null,
      limit: null, limitMin: null, throttle: [] });
  }
  return out;
}
if (LHM_URL) setInterval(pollLHM, 5000);

// Linux reads the same kind of sensors natively (hwmon), every 5 s, unless LHM is configured.
const NATIVE_SENSORS = !LHM_URL && PLATFORM.readSensors;
async function pollNative() {
  try {
    const r = await PLATFORM.readSensors();
    live.lhm = { t: Date.now(), cpuTemp: r.cpuTemp, groups: r.groups, count: r.groups.reduce((a, g) => a + g.sensors.length, 0) };
    live.lhmGpus = r.gpus;
  } catch (e) { log("sensors", e.message); }
}
if (NATIVE_SENSORS) { pollNative(); setInterval(pollNative, 5000); }

function gpuTotals(now) {
  let power = 0, temp = null, vramUsed = 0, vramTotal = 0, util = 0, n = 0, limit = 0, fan = null;
  for (const g of [...live.gpus.values(), ...live.lhmGpus]) {
    if (now - g.t > 15_000) continue;
    n++; power += g.power; vramUsed += g.vramUsed ?? 0; vramTotal += g.vramTotal ?? 0; limit += g.limit ?? 0;
    util = Math.max(util, g.util ?? 0);
    if (g.fan != null) fan = Math.max(fan ?? 0, g.fan);
    if (g.temp != null) temp = Math.max(temp ?? 0, g.temp);
  }
  return n ? { n, power, temp, vramUsed, vramTotal, util, limit, fan } : null;
}

// ---------- inference engines ----------
//
// Each adapter in engines/ (llama.cpp, ...) reports its loaded models, whether each one is
// generating right now, and the tokens it handled. Everything is tracked per model: a
// router can run several at once (a chat model on the GPU next to a small classifier on
// the CPU), and each gets its own status, tokens, busy time and runs.

const pending = new Map();          // model -> { gen, pp, req } not yet written
const addTokens = (model, gen, pp, req = 0) => {
  const p = pending.get(model) || { gen: 0, pp: 0, req: 0 };
  p.gen += gen; p.pp += pp; p.req += req; pending.set(model, p);
};

const wanted = (process.env.DASH_ENGINES || "auto").toLowerCase().split(",").map((s) => s.trim());
const engines = ENGINES
  .filter((E) => wanted.includes("auto") || wanted.includes(E.name.toLowerCase()))
  .map((E) => { try { return E.create({ env: process.env, addTokens, addRequest: (r) => saveRequest(E.name, r), log, stream }); } catch (e) { log(`${E.name}: ${e.message}`); return null; } })
  .filter(Boolean)
  .map((e) => Object.assign(e, { state: { reachable: false, retryAt: 0, models: [], tokenSource: "none" } }));

// An engine that is not running is asked again every 10 s only, so it costs nothing.
async function pollEngine(e, now) {
  if (!e.state.reachable && now < e.state.retryAt) return;
  try {
    const r = await e.poll();
    e.state = { reachable: true, retryAt: 0, models: r.models, tokenSource: r.tokenSource, note: r.note };
  } catch {
    e.state = { reachable: false, retryAt: now + 10_000, models: [], tokenSource: "none" };
  }
}

async function pollLLM() {
  const now = Date.now();
  await Promise.all(engines.map((e) => pollEngine(e, now)));
  const models = engines.flatMap((e) => e.state.models.map((m) => ({ ...m, engine: e.name })));
  live.llm = { t: now, reachable: engines.some((e) => e.state.reachable), processing: models.some((m) => m.processing),
    models, engines: engines.map((e) => ({ name: e.name, reachable: e.state.reachable, tokenSource: e.state.tokenSource, note: e.state.note })) };
}

// ---------- minute rows ----------

// --demo: a separate database pre-filled with 14 days of made-up history, so the page can
// be tried (and screenshotted) right away. Live numbers are still real.
const DEMO = process.argv.includes("--demo");
// db: the writer (this process only). rdb: read-only, for everything the page asks.
// Permissions, WAL, integrity check, migrations, backups: see db.mjs.
const { db, rdb, maintenance } = openDatabase({ dir: CFG.dataDir, demo: DEMO, log });
// m columns in INSERT order (the later ones come from migrations): CPU temperature (null
// without a sensor), GPU power limit, GPU fan %, effective CPU clock, RAM in use (MB).
const M_COLS = ["ts", "secs", "gpu_w", "cpu_w", "dram_w", "sys_w", "gpu_t", "gpu_tmax", "gpu_util", "cpu_util", "vram",
  "active_s", "wh", "wh_active", "wh_gpu", "gen_tok", "pp_tok", "cpu_t", "cpu_tmax", "gpu_pl", "gpu_fan", "cpu_mhz", "ram_used"];
setTimeout(maintenance, 5 * 60_000);            // first backup a few minutes after start, then every 6 h
setInterval(maintenance, 6 * 3600_000);
const upsert = db.prepare(`INSERT OR REPLACE INTO m (${M_COLS.join(",")}) VALUES (${M_COLS.map(() => "?").join(",")})`);
const upsertMM = db.prepare(`INSERT OR REPLACE INTO mm VALUES (?,?,?,?,?,?,?)`);
const insertRun = db.prepare(`INSERT OR REPLACE INTO runs VALUES (?,?,?,?,?,?,?,?)`);
const alerts = createAlerts({ env: process.env, db, readDb: rdb, log });

// Per-request details from the engines (llama.cpp / Ollama logs, LM Studio stats): numbers only,
// each checked to be a sane non-negative number before it is stored.
const insertRequest = db.prepare(`INSERT INTO requests (ts, model, engine, ctx, n_ctx, pp_tok, pp_ms, gen_tok, gen_ms, draft_acc, draft_gen, cached)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
function saveRequest(engine, r) {
  const n = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 1e12 ? v : null;
  try {
    insertRequest.run(n(r.ts) ?? Date.now(), String(r.model || "").slice(0, 200), engine, n(r.ctx), n(r.nCtx), n(r.pp), n(r.ppMs),
      n(r.gen), n(r.genMs), n(r.draftAcc), n(r.draftGen), n(r.cached));
  } catch (e) { log("requests", e.message); }
}
let todayWh = { t: 0, wh: 0 };      // today's energy for the budget alerts, re-read once a minute
const openRuns = new Map();
const RUN_GAP_MS = 15_000;

function closeRun(model) {
  const r = openRuns.get(model);
  if (r) insertRun.run(r.start, r.last, model, r.active, r.wh, r.gen, r.pp, r.req);
  openRuns.delete(model);
}
const closeAllRuns = () => { for (const m of [...openRuns.keys()]) closeRun(m); };

const newBucket = (ts) => ({ ts, secs: 0, gpuW: 0, cpuW: 0, dramW: 0, sysW: 0, gpuT: 0, gpuTmax: 0,
  gpuUtil: 0, cpuUtil: 0, vram: 0, active: 0, wh: 0, whActive: 0, whGpu: 0, gen: 0, pp: 0, models: new Map(),
  cpuT: 0, cpuTsecs: 0, cpuTmax: null, gpuPl: 0, gpuFan: 0, cpuMhz: 0, ram: 0 });
const modelBucket = () => ({ active: 0, wh: 0, gen: 0, pp: 0, req: 0 });

// A restart inside a minute continues that minute's rows instead of overwriting them.
function resumeBucket(ts) {
  const b = newBucket(ts);
  for (const r of db.prepare("SELECT * FROM mm WHERE ts = ?").all(ts)) {
    b.models.set(r.model, { active: r.active_s, wh: r.wh, gen: r.gen_tok, pp: r.pp_tok, req: r.req || 0 });
  }
  const r = db.prepare("SELECT * FROM m WHERE ts = ?").get(ts);
  if (!r) return b;
  const s = r.secs;
  return Object.assign(b, { secs: s, gpuW: r.gpu_w * s, cpuW: r.cpu_w * s, dramW: r.dram_w * s, sysW: r.sys_w * s,
    gpuT: r.gpu_t * s, gpuTmax: r.gpu_tmax, gpuUtil: r.gpu_util * s, cpuUtil: r.cpu_util * s, vram: r.vram,
    active: r.active_s, wh: r.wh, whActive: r.wh_active, whGpu: r.wh_gpu, gen: r.gen_tok, pp: r.pp_tok,
    cpuT: (r.cpu_t ?? 0) * s, cpuTsecs: r.cpu_t == null ? 0 : s, cpuTmax: r.cpu_tmax, gpuPl: (r.gpu_pl ?? 0) * s,
    gpuFan: (r.gpu_fan ?? 0) * s, cpuMhz: (r.cpu_mhz ?? 0) * s, ram: r.ram_used ?? 0 });
}

if (DEMO) seedDemo();

function seedDemo() {
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const now = Math.floor(Date.now() / 60_000) * 60_000;
  const CHAT = "Qwen3.6-35B-A3B-Q4_K_M", SMALL = "d1-3B-Q4_K_M";
  db.exec("BEGIN");
  let open = null;
  for (let ts = now - 14 * 86400_000; ts < now; ts += 60_000) {
    const d = new Date(ts), h = d.getHours() + d.getMinutes() / 60, day = d.getDay();
    if (h > 1.5 && h < 8 && rnd() > 0.02) continue;                 // PC off at night
    const busyP = (day === 0 || day === 6 ? 0.5 : 0.3) * (Math.sin((h - 9) / 24 * 2 * Math.PI) * 0.5 + 0.5) + (h > 20 ? 0.25 : 0);
    const busy = open ? rnd() > 0.15 : rnd() < busyP * 0.25;
    const act = busy ? 30 + rnd() * 30 : 0;
    const small = busy && rnd() < 0.3 ? 2 + rnd() * 4 : 0;
    const gpu = 16 + (act / 60) * (150 + rnd() * 40), cpu = 12 + rnd() * 6 + (act / 60) * (40 + rnd() * 20) + small, dram = 1.3 + (act / 60);
    const sys = (gpu + cpu + dram + CFG.restW) / CFG.psuEff, wh = sys / 60, gen = Math.round(act * (45 + rnd() * 15));
    const pp = act ? Math.round(rnd() * 3000) : 0, spp = Math.round(small * 60);
    const cpuT = 38 + (act / 60) * 24 + rnd() * 4;
    upsert.run(ts, 60, gpu, cpu, dram, sys, 42 + (act / 60) * 22, 44 + (act / 60) * 24, act / 60 * 90, 8 + act / 60 * 40,
      11800, Math.max(act, small), wh, act || small ? wh : 0, gpu / 60, gen + (small ? 2 : 0), pp + spp,
      cpuT, cpuT + 6, 200, act ? 35 + rnd() * 20 : 0, 2400 + (act / 60) * 1800, 19000 + rnd() * 1500);
    if (act) upsertMM.run(ts, CHAT, act, wh, gen, pp, 1);
    if (small) upsertMM.run(ts, SMALL, small, wh * small / 60, 0, spp, 3);
    if (busy) {
      open ??= { start: ts, active: 0, wh: 0, gen: 0, pp: 0 };
      Object.assign(open, { last: ts + 60_000, active: open.active + act, wh: open.wh + wh, gen: open.gen + gen, pp: open.pp + pp });
      if (small) insertRun.run(ts + 5000, ts + 5000 + small * 1000, SMALL, small, wh * small / 60, 0, spp, 3);
    } else if (open) {
      insertRun.run(open.start, open.last, CHAT, open.active, open.wh, open.gen, open.pp, Math.round(open.active / 40));
      open = null;
    }
  }
  // Sample requests: generation slows and prefill speeds up with depth, MTP accepts ~65 %.
  for (let i = 0; i < 400; i++) {
    const ts = now - rnd() * 7 * 86400_000, ctx = Math.round(1500 + rnd() * rnd() * 60000), gen = Math.round(80 + rnd() * 900);
    const pp = Math.round(rnd() < 0.7 ? 20 + rnd() * 400 : 2000 + rnd() * 20000), dacc = Math.round(gen * (0.55 + rnd() * 0.2));
    insertRequest.run(ts, CHAT, "llama.cpp", ctx, 65536, pp, pp / (950 - ctx * 0.004 + rnd() * 80) * 1000,
      gen, gen / (56 - ctx * 0.00022 - rnd() * 4) * 1000, dacc, Math.round(dacc / (0.6 + rnd() * 0.12)), Math.max(0, ctx - pp - gen));
  }
  db.exec("COMMIT");
  log("demo: seeded 14 days of sample history");
}

let bucket = null;
function flush() {
  const b = bucket;
  if (!b || b.secs <= 0) return;
  const avg = (v) => v / b.secs;
  upsert.run(b.ts, b.secs, avg(b.gpuW), avg(b.cpuW), avg(b.dramW), avg(b.sysW), avg(b.gpuT), b.gpuTmax,
    avg(b.gpuUtil), avg(b.cpuUtil), b.vram, b.active, b.wh, b.whActive, b.whGpu, b.gen, b.pp,
    b.cpuTsecs ? b.cpuT / b.cpuTsecs : null, b.cpuTmax, avg(b.gpuPl) || null, avg(b.gpuFan), avg(b.cpuMhz) || null, b.ram);
  for (const [model, x] of b.models) upsertMM.run(b.ts, model, x.active, x.wh, x.gen, x.pp, x.req);
}

let lastTick = Date.now();
async function tick() {
  await pollLLM();
  const now = Date.now();
  const dt = Math.min((now - lastTick) / 1000, 10);   // a sleeping PC must not count as running
  lastTick = now;
  const c = live.cpu;
  if (!c || now - c.t > 15_000) return;
  const g = gpuTotals(now);
  const gpuW = g?.power ?? 0;

  const sysW = (gpuW + c.pkgW + c.dramW + CFG.restW) / CFG.psuEff;
  live.sysW = sysW;
  const ts = Math.floor(now / 60_000) * 60_000;
  if (!bucket || bucket.ts !== ts) { flush(); bucket = resumeBucket(ts); }
  const b = bucket;
  b.secs += dt;
  b.gpuW += gpuW * dt; b.cpuW += c.pkgW * dt; b.dramW += c.dramW * dt; b.sysW += sysW * dt;
  b.gpuT += (g?.temp ?? 0) * dt; b.gpuTmax = Math.max(b.gpuTmax, g?.temp ?? 0);
  b.gpuUtil += (g?.util ?? 0) * dt; b.cpuUtil += c.util * dt; b.vram = Math.max(b.vram, g?.vramUsed ?? 0);
  b.gpuPl += (g?.limit ?? 0) * dt; b.gpuFan += (g?.fan ?? 0) * dt; b.cpuMhz += (c.mhz ?? 0) * dt;
  b.ram = Math.max(b.ram, (os.totalmem() - os.freemem()) / 1048576);
  const cpuT = live.lhm && now - live.lhm.t < 15_000 ? live.lhm.cpuTemp : null;
  if (cpuT != null) { b.cpuT += cpuT * dt; b.cpuTsecs += dt; b.cpuTmax = Math.max(b.cpuTmax ?? 0, cpuT); }
  const wh = (sysW * dt) / 3600;
  b.wh += wh; b.whGpu += (gpuW * dt) / 3600;
  // Busy time per model: polled (processing) or, for engines that only report a request
  // once it is finished (LM Studio), its exact duration (busySec), credited now at the
  // current power. Whole-PC busy time stays within the minute's seconds.
  const mb = (id) => { let x = b.models.get(id); if (!x) b.models.set(id, x = modelBucket()); return x; };
  let pcBusy = 0;
  for (const m of live.llm.models || []) {
    const s = m.processing ? dt : Math.min(m.busySec || 0, 3600);
    if (s <= 0) continue;
    const e = (sysW * s) / 3600;
    pcBusy = Math.max(pcBusy, s);
    const x = mb(m.id); x.active += s; x.wh += e;
    let r = openRuns.get(m.id);
    if (!r) openRuns.set(m.id, r = { start: now - (m.processing ? 0 : s * 1000), last: now, active: 0, wh: 0, gen: 0, pp: 0, req: 0 });
    r.last = now; r.active += s; r.wh += e;
  }
  if (pcBusy > 0) {
    const s = Math.min(pcBusy, Math.max(0, b.secs - b.active));
    b.active += s; b.whActive += (sysW * s) / 3600;
  }
  for (const [id, r] of openRuns) if (now - r.last > RUN_GAP_MS) closeRun(id);
  for (const [id, p] of pending) {     // log lines land just after a reply ends
    const x = mb(id); x.gen += p.gen; x.pp += p.pp; x.req += p.req;
    b.gen += p.gen; b.pp += p.pp;
    const r = openRuns.get(id);
    if (r) { r.gen += p.gen; r.pp += p.pp; r.req += p.req; }
  }
  pending.clear();

  if (now - todayWh.t > 60_000) { const d = new Date(); d.setHours(0, 0, 0, 0); todayWh = { t: now, wh: period(d.getTime()).wh }; }
  alerts.check({ gpus: [...live.gpus.values(), ...live.lhmGpus].filter((x) => now - x.t < 15_000), cpuTemp: cpuT,
    engines: live.llm.engines, models: live.llm.models, todayWh: todayWh.wh, price: CFG.price, currency: CFG.currency });
}

setInterval(() => { tick().catch((e) => log("tick", e.message)); }, CFG.intervalMs);
setInterval(() => { try { flush(); } catch (e) { log("flush", e.message); } }, 10_000);

// ---------- queries ----------

const RANGES = { "1h": [3600, 60], "6h": [6 * 3600, 60], "24h": [86400, 300], "7d": [7 * 86400, 1800], "30d": [30 * 86400, 7200] };

function series(range) {
  if (!RANGES[range]) range = "24h";
  const [span, step] = RANGES[range];
  const from = Date.now() - span * 1000, stepMs = step * 1000;
  const rows = rdb.prepare(`SELECT (ts / ${stepMs}) * ${stepMs} AS t, SUM(secs) s,
      SUM(gpu_w*secs)/SUM(secs) gpu, SUM((cpu_w+dram_w)*secs)/SUM(secs) cpu, SUM(sys_w*secs)/SUM(secs) sys,
      MAX(gpu_tmax) tmax, SUM(gpu_t*secs)/SUM(secs) tavg, SUM(active_s) act,
      MAX(cpu_tmax) ctmax, AVG(cpu_t) ctavg, AVG(gpu_pl) pl, AVG(gpu_fan) fan, AVG(cpu_mhz) mhz, MAX(ram_used) ram,
      SUM(wh) wh, SUM(wh_active) wha, SUM(gen_tok) gen
    FROM m WHERE ts >= ? GROUP BY t ORDER BY t`).all(from);
  return { range, step, from, rows };
}

// Day x hour grid in local time (DST: a repeated hour adds into the same cell).
// model: one model's tokens / busy time / energy while busy; empty = all models.
function heatmap(days, model) {
  days = Math.min(Math.max(Number(days) || 7, 1), 90);
  const start = new Date(); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - (days - 1));
  const rows = model
    ? rdb.prepare("SELECT ts, gen_tok, wh AS wh_active, active_s, 0 AS wh FROM mm WHERE ts >= ? AND model = ?").all(start.getTime(), model)
    : rdb.prepare("SELECT ts, gen_tok, wh, wh_active, active_s FROM m WHERE ts >= ?").all(start.getTime());
  const key = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const map = new Map();
  for (let i = 0; i < days; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    map.set(key(d), Array.from({ length: 24 }, () => ({ gen: 0, wh: 0, wha: 0, act: 0 })));
  }
  for (const r of rows) {
    const d = new Date(r.ts), cell = map.get(key(d))?.[d.getHours()];
    if (!cell) continue;
    cell.gen += r.gen_tok; cell.wh += model ? r.wh_active : r.wh; cell.wha += r.wh_active; cell.act += r.active_s;
  }
  return { model: model || null, days: [...map].reverse().map(([date, hours]) => ({ date, hours })) };
}

// Idle baseline: 20th percentile of whole minutes with no generation, last 7 days.
function idleBaseline() {
  const v = rdb.prepare(`SELECT sys_w FROM m WHERE ts >= ? AND active_s = 0 AND secs >= 50 ORDER BY sys_w`)
    .all(Date.now() - 7 * 86400_000).map((r) => r.sys_w);
  return v.length >= 5 ? v[Math.floor(v.length * 0.2)] : null;
}

function period(from, to = Date.now() + 60_000) {
  return rdb.prepare(`SELECT COALESCE(SUM(secs),0) secs, COALESCE(SUM(wh),0) wh, COALESCE(SUM(wh_active),0) wha,
      COALESCE(SUM(active_s),0) act, COALESCE(SUM(gen_tok),0) gen, COALESCE(SUM(pp_tok),0) pp
    FROM m WHERE ts >= ? AND ts < ?`).get(from, to);
}

// Per model: tokens, busy time and whole-PC energy while it was busy.
function perModel(from, to = Date.now() + 60_000) {
  return rdb.prepare(`SELECT model, SUM(active_s) act, SUM(wh) wh, SUM(gen_tok) gen, SUM(pp_tok) pp, SUM(req) req
    FROM mm WHERE ts >= ? AND ts < ? GROUP BY model ORDER BY SUM(active_s) DESC`).all(from, to);
}

// Report: one row per local day plus per-model totals, for a fixed list of periods.
const REPORT_PERIODS = ["this-month", "last-month", "7d", "30d", "this-year", "last-year", "all"];
function reportRange(p) {
  const now = new Date(), d0 = new Date(now); d0.setHours(0, 0, 0, 0);
  const end = Date.now() + 60_000;
  switch (p) {
    case "last-month": return [new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime(), new Date(now.getFullYear(), now.getMonth(), 1).getTime()];
    case "7d": return [d0.getTime() - 6 * 86400_000, end];
    case "30d": return [d0.getTime() - 29 * 86400_000, end];
    case "this-year": return [new Date(now.getFullYear(), 0, 1).getTime(), end];
    case "last-year": return [new Date(now.getFullYear() - 1, 0, 1).getTime(), new Date(now.getFullYear(), 0, 1).getTime()];
    case "all": return [0, end];
    default: return [new Date(now.getFullYear(), now.getMonth(), 1).getTime(), end];
  }
}
function report(p) {
  if (!REPORT_PERIODS.includes(p)) p = "this-month";
  const [from, to] = reportRange(p);
  const days = rdb.prepare(`SELECT date(ts / 1000, 'unixepoch', 'localtime') day, SUM(secs) secs, SUM(wh) wh, SUM(wh_active) wha,
      SUM(active_s) act, SUM(gen_tok) gen, SUM(pp_tok) pp, MAX(gpu_tmax) gpu_tmax, MAX(cpu_tmax) cpu_tmax
    FROM m WHERE ts >= ? AND ts < ? GROUP BY day ORDER BY day`).all(from, to);
  return { period: p, from, to: Math.min(to, Date.now()), price: CFG.price, currency: CFG.currency,
    total: period(from, to), days, models: perModel(from, to) };
}

function reportCSV(res, sendHeaders, p) {
  const r = report(p);
  const cost = (wh) => CFG.price ? (wh / 1000 * CFG.price).toFixed(2) : "";
  const cur = CFG.price ? ` (${CFG.currency || "cost"})` : "";
  const q = (s) => /[",\r\n]/.test(s) || /^[=+\-@]/.test(s) ? `"${String(s).replace(/^([=+\-@])/, "'$1").replace(/"/g, '""')}"` : s;
  const lines = [`WattLlama report,${r.period},${new Date(r.from).toISOString()},${new Date(r.to).toISOString()}`, "",
    `day,PC on (h),energy (kWh),LLM energy (kWh),LLM busy (h),generated tokens,prompt tokens,GPU max (°C),CPU max (°C)${CFG.price ? `,cost${cur},LLM cost${cur}` : ""}`];
  for (const d of r.days) lines.push([d.day, (d.secs / 3600).toFixed(2), (d.wh / 1000).toFixed(3), (d.wha / 1000).toFixed(3), (d.act / 3600).toFixed(2),
    d.gen, d.pp, d.gpu_tmax ?? "", d.cpu_tmax == null ? "" : d.cpu_tmax.toFixed(0), ...(CFG.price ? [cost(d.wh), cost(d.wha)] : [])].join(","));
  const t = r.total;
  lines.push(["total", (t.secs / 3600).toFixed(2), (t.wh / 1000).toFixed(3), (t.wha / 1000).toFixed(3), (t.act / 3600).toFixed(2), t.gen, t.pp, "", "",
    ...(CFG.price ? [cost(t.wh), cost(t.wha)] : [])].join(","));
  lines.push("", `model,requests,generated tokens,prompt tokens,busy (h),energy while busy (kWh),Wh per 1k tokens${CFG.price ? `,cost${cur}` : ""}`);
  for (const m of r.models) lines.push([q(m.model), m.req, m.gen, m.pp, (m.act / 3600).toFixed(2), (m.wh / 1000).toFixed(3),
    m.gen ? (m.wh / (m.gen / 1000)).toFixed(2) : "", ...(CFG.price ? [cost(m.wh)] : [])].join(","));
  if (CFG.price) lines.push("", `price per kWh,${CFG.price},${q(CFG.currency)}`);
  sendHeaders({ "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="wattllama-report-${r.period}.csv"` });
  res.end("﻿" + lines.join("\r\n") + "\r\n");      // BOM + CRLF: Excel opens it with the right characters
}

function summary() {
  const d = new Date(); d.setHours(0, 0, 0, 0);
  const today = d.getTime();
  return {
    models: { today: perModel(today), week: perModel(Date.now() - 7 * 86400_000), all: perModel(0) },
    restW: CFG.restW, psuEff: CFG.psuEff, idleW: idleBaseline(), price: CFG.price, currency: CFG.currency,
    first: rdb.prepare("SELECT MIN(ts) t FROM m").get().t,
    today: period(today), yesterday: period(today - 86400_000, today),
    week: period(Date.now() - 7 * 86400_000),
    month: period(new Date(d.getFullYear(), d.getMonth(), 1).getTime()), all: period(0),
  };
}

function liveView() {
  const now = Date.now();
  const c = live.cpu;
  const fresh = (x) => x && now - x.t < 15_000;
  return {
    t: now, sysW: live.sysW,
    gpu: gpuTotals(now),
    gpus: [...live.gpus.values(), ...live.lhmGpus].filter(fresh).map(({ t, ...g }) => g),
    cpu: fresh(c) && { power: c.pkgW, dram: c.dramW, util: c.util, measured: c.measured, mhz: c.mhz, zoneC: c.zoneC,
      temp: fresh(live.lhm) ? live.lhm.cpuTemp : null },
    ram: { used: os.totalmem() - os.freemem(), total: os.totalmem() },
    disk: fresh(c) ? { read: c.diskR, write: c.diskW } : null,
    sensors: fresh(live.lhm) ? live.lhm.groups : null,
    lhm: LHM_URL ? (fresh(live.lhm) ? "ok" : "unreachable") : NATIVE_SENSORS ? "native" : "off",
    platform: PLATFORM.name,
    control: CONTROL,
    llm: engines.length ? live.llm : null,
    alerts: alerts.active(),
  };
}

// Energy efficiency per GPU power limit: the "same speed for 100 W less" check.
// Minutes in which something was generated, grouped by the limit in force (5 W steps).
function efficiency() {
  return rdb.prepare(`SELECT CAST(ROUND(gpu_pl / 5.0) * 5 AS INTEGER) pl, SUM(gen_tok) gen, SUM(active_s) act,
      SUM(wh_active) wh, SUM(gpu_w * active_s) / SUM(active_s) gpuw, COUNT(*) minutes
    FROM m WHERE gen_tok > 0 AND active_s > 0 AND gpu_pl IS NOT NULL GROUP BY pl ORDER BY pl DESC`).all();
}

// ---------- setup: model parameters, pi, scheduled tasks ----------

const piDir = process.env.DASH_PI_DIR || path.join(os.homedir(), ".pi", "agent");
const taskPatterns = process.env.DASH_TASKS || "";
const cache = new Map();

async function cached(key, ms, fn) {
  const c = cache.get(key);
  if (c && Date.now() - c.t < ms) return c.v;
  const v = await fn().catch((e) => ({ error: e.message }));
  cache.set(key, { t: Date.now(), v });
  return v;
}

const run$ = (cmd, args, opts = {}) => new Promise((resolve, reject) =>
  execFile(cmd, args, { windowsHide: true, timeout: 20_000, ...opts }, (e, out) => e ? reject(e) : resolve(out)));

const readJSON = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
const listDir = (d, dirs) => { try { return fs.readdirSync(d, { withFileTypes: true })
  .filter((e) => (dirs ? e.isDirectory() || e.isSymbolicLink() : e.isFile() && /\.(ts|js|mjs)$/.test(e.name)))
  .map((e) => e.name); } catch { return []; } };
const expand = (p) => path.resolve(p.replace(/^~(?=$|[\\/])/, os.homedir()));

// pi (https://github.com/badlogic/pi-mono) settings, allow-listed: never auth.json,
// never API keys or provider URLs.
async function piSetup() {
  const s = readJSON(path.join(piDir, "settings.json"));
  if (!s) return null;
  const models = readJSON(path.join(piDir, "models.json"));
  const extDirs = [path.join(piDir, "extensions"), ...(s.extensions || []).map(expand)];
  const skillDirs = [path.join(piDir, "skills"), ...(s.skills || []).map(expand)];
  const version = await cached("pi-version", 3600_000, async () =>
    (await run$(process.env.ComSpec || "cmd.exe", ["/d", "/c", "pi", "--version"])).trim());
  return {
    version: typeof version === "string" ? version : null,
    provider: s.defaultProvider, model: s.defaultModel, thinking: s.defaultThinkingLevel,
    tools: s.defaultTools || [], enabledModels: s.enabledModels || [],
    compaction: s.compaction && { enabled: s.compaction.enabled, reserveTokens: s.compaction.reserveTokens,
      keepRecentTokens: s.compaction.keepRecentTokens },
    retry: s.retry?.enabled,
    packages: (s.packages || []).map((p) => String(typeof p === "string" ? p : p.source || p.name || "").replace(/^npm:/, "")),
    extensions: [...new Set(extDirs.flatMap((d) => listDir(d, false)))],
    skills: [...new Set(skillDirs.flatMap((d) => listDir(d, true)))],
    providers: Object.entries(models?.providers || {}).map(([name, p]) => ({ name, models: (p.models || []).map((m) => m.id) })),
  };
}

async function tasksSetup() {
  if (!taskPatterns) return null;
  return PLATFORM.scheduledTasks(taskPatterns, { run$, dir: DIR });
}

async function setup() {
  return {
    engines: await Promise.all(engines.filter((e) => e.state.reachable && e.setup).map(async (e) =>
      ({ engine: e.name, ...(await cached(`engine:${e.name}`, 30_000, e.setup)) }))),
    pi: await cached("pi", 60_000, piSetup),
    tasks: await cached("tasks", 60_000, tasksSetup),
  };
}

// "Share your result": one model's all-time numbers plus the hardware names, for the
// community results table. Nothing is sent anywhere: the page shows a preview and the
// user decides to open a GitHub issue with it. No host name, user name or path.
const VERSION = readJSON(path.join(DIR, "package.json"))?.version || "dev";
const engineOf = new Map();          // model -> engine name, learnt while it is loaded
function share() {
  for (const m of live.llm.models || []) engineOf.set(m.id, m.engine);
  const gpus = [...live.gpus.values(), ...live.lhmGpus].map((g) => g.name);
  const models = rdb.prepare(`SELECT mm.model, SUM(mm.gen_tok) gen, SUM(mm.active_s) act, SUM(mm.wh) wh,
      SUM(m.gpu_pl * mm.active_s) / NULLIF(SUM(CASE WHEN m.gpu_pl IS NULL THEN 0 ELSE mm.active_s END), 0) pl
    FROM mm LEFT JOIN m ON m.ts = mm.ts WHERE mm.gen_tok > 0 GROUP BY mm.model HAVING SUM(mm.gen_tok) >= 1000 ORDER BY gen DESC`).all()
    .map((r) => ({ model: r.model, engine: engineOf.get(r.model) || "",
      quant: r.model.match(/(?:^|[-_.:])((?:UD-)?(?:IQ\d_[A-Z0-9_]+|Q\d(?:_[A-Z0-9]+)*|F16|BF16|FP16|MXFP4|\d-?bit))(?=$|[-_.:])/i)?.[1] || "",
      tokens: r.gen, tokPerS: r.act > 0 ? r.gen / r.act : null, whPer1k: r.wh / (r.gen / 1000),
      powerLimit: r.pl ? Math.round(r.pl) : null }));
  return { version: VERSION, os: PLATFORM.osName(), cpu: os.cpus()[0]?.model.trim().replace(/\s+/g, " ") || "",
    ramGB: Math.round(os.totalmem() / 1073741824), gpus, psuEff: CFG.psuEff, restW: CFG.restW, models };
}

// CSV export: one table, streamed row by row (memory stays flat even for months of data).
// The table and range come from fixed lists, never from the URL as SQL.
const EXPORTS = {
  minutes: ["m", "ts"], models: ["mm", "ts"], runs: ["runs", "start"],
};
const EXPORT_RANGES = { "24h": 86400, "7d": 7 * 86400, "30d": 30 * 86400, all: null };
function exportCSV(res, sendHeaders, what, range) {
  const [table, tcol] = EXPORTS[what] || EXPORTS.minutes;
  const span = EXPORT_RANGES[range] === undefined ? EXPORT_RANGES["30d"] : EXPORT_RANGES[range];
  const from = span == null ? 0 : Date.now() - span * 1000;
  const cols = rdb.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  const cell = (v) => v == null ? "" : typeof v === "number" ? (Number.isInteger(v) ? String(v) : String(+v.toFixed(4)))
    : /[",\r\n]/.test(v) || /^[=+\-@]/.test(v) ? `"${String(v).replace(/^([=+\-@])/, "'$1").replace(/"/g, '""')}"` : v;   // no spreadsheet formulas
  sendHeaders({ "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename="wattllama-${what in EXPORTS ? what : "minutes"}-${range in EXPORT_RANGES ? range : "30d"}.csv"` });
  res.write(["time", ...cols].join(",") + "\n");
  let chunk = "";
  for (const r of rdb.prepare(`SELECT * FROM ${table} WHERE ${tcol} >= ? ORDER BY ${tcol}`).iterate(from)) {
    chunk += [new Date(r[tcol]).toISOString(), ...cols.map((c) => cell(r[c]))].join(",") + "\n";
    if (chunk.length > 64 << 10) { res.write(chunk); chunk = ""; }
  }
  res.end(chunk);
}

// Requests of one model (or all) in a fixed range, newest first, for the inference details.
const REQ_RANGES = { "24h": 86400, "7d": 7 * 86400, "30d": 30 * 86400 };
function requests(model, range) {
  if (!REQ_RANGES[range]) range = "24h";
  const from = Date.now() - REQ_RANGES[range] * 1000;
  const rows = model
    ? rdb.prepare("SELECT * FROM requests WHERE ts >= ? AND model = ? ORDER BY ts DESC LIMIT 3000").all(from, String(model).slice(0, 200))
    : rdb.prepare("SELECT * FROM requests WHERE ts >= ? ORDER BY ts DESC LIMIT 3000").all(from);
  const models = rdb.prepare("SELECT model, engine, COUNT(*) n FROM requests WHERE ts >= ? GROUP BY model, engine ORDER BY n DESC").all(from);
  return { range, model: model || null, models, rows };
}

function runs(limit = 40) {
  const rows = rdb.prepare("SELECT * FROM runs ORDER BY start DESC LIMIT ?").all(limit);
  for (const [model, r] of openRuns) rows.unshift({ start: r.start, end: r.last, model, active_s: r.active,
    wh: r.wh, gen_tok: r.gen, pp_tok: r.pp, req: r.req, open: true });
  return rows;
}

// ---------- http ----------

// Security model: read-only, GET only, a fixed list of files (no path ever comes from
// the URL), strict Content-Security-Policy, and a Host check against DNS rebinding:
// a web page you visit cannot point its own domain at 127.0.0.1 and read this API.
// With DASH_TOKEN set (install.ps1 -AllowLan does it), every request also needs the token.

const PUBLIC = path.join(DIR, "public");
const STATIC = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
  "/logo.svg": ["logo.svg", "image/svg+xml"],
};
const SECURITY_HEADERS = {
  "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; "
    + "img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "cache-control": "no-store",
};

const TOKEN = process.env.DASH_TOKEN || "";
const CONTROL = process.env.DASH_ALLOW_POWER_LIMIT === "1";

// The only thing WattLlama can change, off unless DASH_ALLOW_POWER_LIMIT=1: the NVIDIA
// power limit (what undervolting videos use to get the same speed for less power).
// Accepted only from this PC, only from WattLlama's own page, only within the card's
// own min..max, and the OS still asks you (UAC on Windows, polkit on Linux). Resets at reboot.
let controlBusy = false;
const isLoopback = (a) => a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";

async function readBody(req, limit = 1024) {
  let body = "";
  for await (const chunk of req) { body += chunk; if (body.length > limit) throw new Error("too large"); }
  return body;
}

async function setPowerLimit(req) {
  if (!CONTROL) return [403, { error: "Power limit control is off (DASH_ALLOW_POWER_LIMIT=1 in .env)." }];
  if (!isLoopback(req.socket.remoteAddress)) return [403, { error: "Only from this PC." }];
  if (req.headers.origin !== `http://${req.headers.host}` || req.headers["x-wattllama"] !== "1"
    || !String(req.headers["content-type"]).startsWith("application/json")) return [403, { error: "Not from the WattLlama page." }];
  if (controlBusy) return [409, { error: "A change is already waiting for confirmation." }];
  const body = JSON.parse(await readBody(req));
  const g = live.gpus.get(String(body.gpu));
  if (!g || g.limitMin == null || g.limitMax == null || g.limitDefault == null) return [400, { error: "Unknown GPU or no power limit support." }];
  const watts = body.reset ? Math.round(g.limitDefault) : Number(body.watts);
  if (!Number.isInteger(watts) || watts < g.safeMin || watts > Math.floor(g.limitMax)) {
    return [400, { error: `Limit must be ${g.safeMin}-${Math.floor(g.limitMax)} W.` }];
  }
  const index = Number(g.index);
  if (!Number.isInteger(index) || index < 0) return [400, { error: "Bad GPU index." }];
  controlBusy = true;
  try {
    // Numbers only, validated above; nvidia-smi -pl needs admin rights.
    const [cmd, args] = PLATFORM.powerLimitCommand(index, watts);
    let code = 0;
    try { await run$(cmd, args, { timeout: 120_000 }); }
    catch (e) { code = e.code ?? 1; }
    log(`power limit GPU ${index} -> ${watts} W: ${code === 0 ? "done" : "cancelled or failed"}`);
    return code === 0 ? [200, { ok: true, gpu: index, watts }] : [409, { error: `Cancelled in ${PLATFORM.elevation}, or nvidia-smi refused.` }];
  } finally { controlBusy = false; }
}
const extraHosts = (process.env.DASH_ALLOWED_HOSTS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

// IP literals (how a phone reaches the PC), localhost, this PC's name; never a foreign domain.
function hostAllowed(hostHeader) {
  if (!hostHeader) return false;
  const host = hostHeader.toLowerCase().replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === os.hostname().toLowerCase() || extraHosts.includes(host)) return true;
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || /^[0-9a-f:]+$/.test(host) && host.includes(":");
}

// Brute force and flooding. Wrong tokens: after 10 within 10 minutes the address is locked out
// for 15 minutes (the token is 128 random bits, so guessing was hopeless anyway; this also keeps
// the log quiet). Any other address than this PC: at most 600 requests a minute (the page needs
// about 40). Memory stays bounded.
const failures = new Map();        // ip -> { n, first, until }
const hits = new Map();            // ip -> { n, first }
const lockedOut = (ip, now) => (failures.get(ip)?.until ?? 0) > now;
function authFailed(ip, now) {
  const f = failures.get(ip);
  const x = f && now - f.first < 10 * 60_000 ? f : { n: 0, first: now, until: 0 };
  x.n++;
  if (x.n >= 10 && !x.until) { x.until = now + 15 * 60_000; log(`too many wrong tokens from ${ip}: locked out for 15 minutes`); }
  failures.set(ip, x);
  if (failures.size > 10_000) failures.clear();
}
function flooding(ip, now) {
  if (isLoopback(ip)) return false;
  const h = hits.get(ip);
  const x = h && now - h.first < 60_000 ? h : { n: 0, first: now };
  x.n++;
  hits.set(ip, x);
  if (hits.size > 10_000) hits.clear();
  return x.n > 600;
}

function tokenOk(req, u) {
  if (!TOKEN) return true;
  const given = [
    u.searchParams.get("token"),
    (req.headers.authorization || "").replace(/^Bearer\s+/i, ""),
    (req.headers.cookie || "").match(/(?:^|;\s*)wl_token=([^;]+)/)?.[1],
  ].filter(Boolean);
  const want = Buffer.from(TOKEN);
  return given.some((g) => { const b = Buffer.from(decodeURIComponent(g)); return b.length === want.length && crypto.timingSafeEqual(b, want); });
}

const httpServer = http.createServer(async (req, res) => {
  const send = (code, type, body, extra = {}) => {
    res.writeHead(code, { ...SECURITY_HEADERS, "content-type": type, ...extra });
    res.end(req.method === "HEAD" ? undefined : body);
  };
  const json = (o) => send(200, "application/json; charset=utf-8", JSON.stringify(o));
  try {
    const u = new URL(req.url, "http://localhost");
    const isControl = req.method === "POST" && u.pathname === "/api/gpu/power-limit";
    if (req.method !== "GET" && req.method !== "HEAD" && !isControl) return send(405, "text/plain", "read-only", { allow: "GET, HEAD" });
    if (!hostAllowed(req.headers.host)) return send(403, "text/plain", "Host not allowed");
    const ip = req.socket.remoteAddress || "", now = Date.now();
    if (flooding(ip, now)) return send(429, "text/plain", "too many requests", { "retry-after": "60" });
    if (TOKEN && lockedOut(ip, now)) return send(429, "text/plain", "too many wrong tokens, try again later", { "retry-after": "900" });
    if (!tokenOk(req, u)) { authFailed(ip, now); return send(401, "text/plain", "Open the link with ?token=… from install.ps1, once."); }
    failures.delete(ip);
    if (isControl) {
      const [code, out] = await setPowerLimit(req).catch((e) => [400, { error: e.message }]);
      return send(code, "application/json; charset=utf-8", JSON.stringify(out));
    }
    if (TOKEN && u.searchParams.has("token")) {   // remember it in a cookie, drop it from the address bar
      return send(302, "text/plain", "", { location: "/",
        "set-cookie": `wl_token=${encodeURIComponent(TOKEN)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000` });
    }
    const file = STATIC[u.pathname];
    if (file) return send(200, file[1], fs.readFileSync(path.join(PUBLIC, file[0])));
    if (u.pathname === "/api/live") return json(liveView());
    if (u.pathname === "/api/series") return json(series(u.searchParams.get("range")));
    if (u.pathname === "/api/summary") return json(summary());
    if (u.pathname === "/api/runs") return json(runs());
    if (u.pathname === "/api/heatmap") return json(heatmap(u.searchParams.get("days"), u.searchParams.get("model")));
    if (u.pathname === "/api/setup") return json(await setup());
    if (u.pathname === "/api/efficiency") return json(efficiency());
    if (u.pathname === "/api/requests") return json(requests(u.searchParams.get("model"), u.searchParams.get("range")));
    if (u.pathname === "/api/alerts") return json({ active: alerts.active(), events: alerts.list(100), settings: alerts.settings() });
    if (u.pathname === "/api/share") return json(share());
    if (u.pathname === "/api/report") return json(report(u.searchParams.get("period")));
    if (u.pathname === "/api/report.csv") {
      if (req.method === "HEAD") return send(200, "text/csv; charset=utf-8", "");
      return reportCSV(res, (h) => res.writeHead(200, { ...SECURITY_HEADERS, ...h }), u.searchParams.get("period"));
    }
    if (u.pathname === "/api/export.csv") {
      if (req.method === "HEAD") return send(200, "text/csv; charset=utf-8", "");
      return exportCSV(res, (h) => res.writeHead(200, { ...SECURITY_HEADERS, ...h }), u.searchParams.get("data"), u.searchParams.get("range"));
    }
    send(404, "text/plain", "not found");
  } catch (e) {
    log("http", e.message);
    if (res.headersSent) res.end(); else send(500, "text/plain", "internal error");
  }
}).on("error", (e) => {
  log(e.code === "EADDRINUSE" ? `port ${CFG.port} is in use: set DASH_PORT in .env` : `server: ${e.message}`);
  process.exit(1);
});
// Slow or idle clients cannot hold connections open (slowloris), and there is a ceiling on them.
httpServer.headersTimeout = 10_000;
httpServer.requestTimeout = 30_000;
httpServer.keepAliveTimeout = 5_000;
httpServer.maxConnections = 64;
httpServer.listen(CFG.port, CFG.host, () => {
  // The real port (DASH_PORT=0 lets the OS pick one, as the tests do).
  log(`WattLlama on http://${CFG.host}:${httpServer.address().port}${TOKEN ? " (token required)" : ""}`);
  if (CFG.host !== "127.0.0.1" && CFG.host !== "localhost" && !TOKEN) log("warning: reachable from the network without DASH_TOKEN");
});

// Never take the PC down with us: an unexpected error is logged, the minute is saved,
// and start.ps1 starts a fresh process 10 s later.
process.on("unhandledRejection", (e) => log("unhandled", e?.message || e));
process.on("uncaughtException", (e) => { log("fatal", e?.stack || e); try { flush(); closeAllRuns(); } catch {} process.exit(1); });

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { flush(); closeAllRuns(); process.exit(0); });
