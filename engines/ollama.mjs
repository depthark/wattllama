// Ollama (https://ollama.com). Recent Ollama runs every GGUF model as an upstream
// llama-server child process on a private port and writes that child's output into its
// own log, so WattLlama can read the same exact numbers as for llama.cpp:
//   loaded models          GET /api/ps
//   generating right now   the child's /slots (its port is in the "starting llama-server" log line)
//   token counts           print_timing lines in server.log (exact); without the log, /slots (close)
// Models served by another runner (no llama-server child) show as loaded, without tokens.

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getJSON, tail, parseLlamaLine, slotPoller, rate, argPairs } from "./common.mjs";

export const name = "Ollama";

function baseUrl(env) {
  if (env.DASH_OLLAMA_URL != null) return env.DASH_OLLAMA_URL.replace(/\/$/, "");
  // Ollama's own setting, e.g. "0.0.0.0:11434" or "http://127.0.0.1:11500"
  const h = (env.OLLAMA_HOST || "127.0.0.1:11434").replace(/^https?:\/\//, "").replace(/\/$/, "");
  const [host, port] = h.includes(":") ? [h.slice(0, h.lastIndexOf(":")), h.slice(h.lastIndexOf(":") + 1)] : [h, "11434"];
  return `http://${!host || host === "0.0.0.0" || host === "[::]" ? "127.0.0.1" : host}:${port || 11434}`;
}

const defaultLog = (env) => env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "Ollama", "server.log")
  : path.join(os.homedir(), ".ollama", "logs", "server.log");

// A "starting llama-server" line -> { hash, port, args } (Go's slog quotes the command).
export function parseLaunch(line) {
  if (!line.includes("starting llama-server")) return null;
  const q = line.match(/cmd="((?:[^"\\]|\\.)*)"/);
  let cmd = q ? q[1] : line;
  try { if (q) cmd = JSON.parse(`"${q[1]}"`); } catch {}
  return parseCmd(cmd);
}

// A llama-server command line started by Ollama -> { hash, port, args }.
export function parseCmd(cmd) {
  const hash = cmd.match(/sha256-([0-9a-f]{64})/)?.[1];
  const port = cmd.match(/--port (\d+)/)?.[1];
  if (!hash || !port) return null;
  // Drop the executable path and replace the model path by its blob name before splitting,
  // so no folder name (which may contain spaces or the user name) reaches the page.
  const flags = cmd.slice(cmd.indexOf(" -")).replace(/--model .*?sha256-([0-9a-f]{12})[0-9a-f]{52}/, "--model sha256-$1…");
  return { hash, port, args: argPairs(flags.trim().split(/\s+/)) };
}

export function create({ env, addTokens }) {
  const url = baseUrl(env);
  if (!url) return null;
  const logFile = env.DASH_OLLAMA_LOG ?? defaultLog(env);
  const readLog = logFile ? tail(logFile) : null;
  const launches = new Map();     // blob hash -> { port, args }
  const blobOf = new Map();       // "name@digest" -> { hash, kind }
  const slots = new Map();        // port -> slotPoller
  let last = { t: 0, models: [] }, scanned = false, psSig = "";

  // No server.log (e.g. "ollama serve" in a terminal): read the children's command lines
  // from Windows instead. Only when the set of loaded models changes, so it stays rare.
  function scanProcesses() {
    if (process.platform !== "win32") return;
    const ps = `Get-CimInstance Win32_Process -Filter "Name='llama-server.exe'" | ForEach-Object { $_.CommandLine }`;
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { windowsHide: true, timeout: 15_000 }, (e, out) => {
      if (e) return;
      for (const l of String(out).split(/\r?\n/)) {
        if (!/ollama/i.test(l)) continue;
        const x = parseCmd(l.replace(/"/g, ""));
        if (x) launches.set(x.hash, x);
      }
    });
  }

  // Children started before WattLlama: find their launch lines in the end of the log.
  function scanBack() {
    scanned = true;
    try {
      const size = fs.statSync(logFile).size, n = Math.min(size, 8 << 20);
      const fd = fs.openSync(logFile, "r");
      try {
        const buf = Buffer.alloc(n);
        fs.readSync(fd, buf, 0, n, size - n);
        for (const l of buf.toString("utf8").split("\n")) { const x = parseLaunch(l); if (x) launches.set(x.hash, x); }
      } finally { fs.closeSync(fd); }
    } catch {}
  }

  async function blob(m) {
    const key = `${m.name}@${m.digest}`;
    if (!blobOf.has(key)) {
      const s = await getJSON(`${url}/api/show`, { method: "POST", body: JSON.stringify({ model: m.name }),
        headers: { "content-type": "application/json" } }).catch(() => null);
      if (!s) return null;
      const hash = String(s.modelfile || "").match(/^FROM .*sha256-([0-9a-f]{64})/m)?.[1]
        || String(s.details?.parent_model || "").match(/sha256-([0-9a-f]{64})/)?.[1] || null;
      const caps = s.capabilities || [];
      blobOf.set(key, { hash, kind: caps.includes("completion") || !caps.length ? "text" : caps.includes("embedding") ? "embedding" : caps.join(",") });
    }
    return blobOf.get(key);
  }

  async function poll() {
    const ps = (await getJSON(`${url}/api/ps`)).models || [];
    if (readLog && !scanned) scanBack();
    const lines = readLog ? readLog() : null;
    const tokenLines = [];
    for (const l of lines || []) {
      const x = parseLaunch(l);
      if (x) launches.set(x.hash, x);
      else { const t = parseLlamaLine(l); if (t) tokenLines.push(t); }
    }
    const useLog = lines != null;
    const sig = ps.map((m) => m.name + m.digest).join();
    if (!useLog && sig !== psSig && ps.length) scanProcesses();
    psSig = sig;
    const now = Date.now(), dt = (now - (last.t || now)) / 1000;
    const prev = new Map(last.models.map((m) => [m.id, m]));
    const models = [];
    for (const m of ps) {
      const b = await blob(m);
      const child = b?.hash ? launches.get(b.hash) : null;
      let s = null;
      if (child) {
        if (!slots.has(child.port)) slots.set(child.port, slotPoller());
        s = await slots.get(child.port)(`http://127.0.0.1:${child.port}/slots`, {});
      }
      if (s && !useLog) addTokens(m.name, s.gen, 0, s.req);
      models.push({ id: m.name, kind: b?.kind || "text", processing: !!s?.processing, child: !!child,
        genRate: rate(prev.get(m.name)?.genRate, !!s?.processing, s?.gen || 0, dt) });
    }
    // The log has no per-model prefix: lines go to the model that is (or just was)
    // generating; with one model loaded, that is always right.
    if (tokenLines.length) {
      const busy = models.filter((m) => m.processing || prev.get(m.id)?.processing);
      const to = (busy.length ? busy : models.filter((m) => m.child))[0] || models[0];
      if (to) for (const x of tokenLines) {
        if (x.req) addTokens(to.id, 0, 0, 1);
        else if (x.gen != null) addTokens(to.id, x.gen, 0);
        else if (x.pp != null) addTokens(to.id, 0, x.pp);
        else if (x.release != null && to.kind !== "text") addTokens(to.id, 0, x.release);
      }
    }
    const noChild = models.filter((m) => !m.child).map((m) => m.id);
    for (const m of models) delete m.child;
    last = { t: now, models };
    const note = noChild.length && useLog ?`no token counts for ${noChild.join(", ")} (not run by llama-server)`
      : ps.length && !useLog ? "server.log not found: token counts from /slots, close but not exact" : undefined;
    return { models, tokenSource: useLog ? "log" : ps.length ? "slots" : "none", note };
  }

  async function setup() {
    const [ps, tags] = await Promise.all([getJSON(`${url}/api/ps`), getJSON(`${url}/api/tags`).catch(() => ({ models: [] }))]);
    const loaded = new Map((ps.models || []).map((m) => [m.name, m]));
    const all = [...loaded.values(), ...(tags.models || []).filter((m) => !loaded.has(m.name))];
    const out = [];
    for (const m of all) {
      const isLoaded = loaded.has(m.name);
      const b = isLoaded ? await blob(m) : null;
      const child = b?.hash ? launches.get(b.hash) : null;
      const d = m.details || {};
      out.push({ id: m.name, status: isLoaded ? "loaded" : "unloaded", kind: b?.kind || "text",
        args: isLoaded ? [...(d.quantization_level ? [["quant", d.quantization_level]] : []),
          ...(m.context_length ? [["ctx", String(m.context_length)]] : []),
          ...(child?.args || [])] : [],
        paramsText: d.parameter_size, size: m.size });
    }
    return { mode: "ollama", models: out };
  }

  return { name, url, poll, setup };
}
