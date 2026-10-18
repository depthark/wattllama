// LM Studio (https://lmstudio.ai). Its local server lists the loaded models, and its CLI
// streams one event per prediction ("lms log stream --json"), which carries LM Studio's own
// exact counts (promptTokensCount, predictedTokensCount, tokensPerSecond):
//   loaded models          GET /api/v1/models (or /api/v0/models on older versions)
//   generating right now   between a prediction's input event and its output event
//   token counts           the output event's stats; exact
// The CLI is only started while the server answers, with an explicit --port, so WattLlama
// never launches LM Studio itself. Prompts and replies pass through that stream: they are
// matched with two regular expressions and never stored, logged or shown.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getJSON } from "./common.mjs";

export const name = "LM Studio";

const str = (line, key) => {
  const m = line.match(new RegExp(`"${key}":"((?:[^"\\\\]|\\\\.)*)"`));
  if (!m) return null;
  try { return JSON.parse(`"${m[1]}"`); } catch { return null; }
};

// One line of "lms log stream --json" -> { type: "input" | "output", model, stats? } or null.
// A JSON string never contains an unescaped `"key":"`, so prompt text cannot fake a match.
export function parseEvent(line) {
  const type = line.includes('"type":"llm.prediction.input"') ? "input"
    : line.includes('"type":"llm.prediction.output"') ? "output" : null;
  if (!type) return null;
  const model = str(line, "modelIdentifier");
  if (!model) return null;
  if (type === "input") return { type, model };
  let stats = null;
  const s = line.match(/"stats":(\{[^{}]*\})/);      // flat object of numbers and short strings
  if (s) { try { stats = JSON.parse(s[1]); } catch {} }
  return { type, model, stats };
}

function findLms(env) {
  if (env.DASH_LMSTUDIO_LMS) return env.DASH_LMSTUDIO_LMS;
  const exe = path.join(os.homedir(), ".lmstudio", "bin", process.platform === "win32" ? "lms.exe" : "lms");
  return fs.existsSync(exe) ? exe : null;
}

export function create({ env, addTokens, log }) {
  const url = (env.DASH_LMSTUDIO_URL ?? "http://127.0.0.1:1234").replace(/\/$/, "");
  if (!url) return null;
  const port = new URL(url).port || "1234";
  const isLocal = ["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname);
  const headers = env.DASH_LMSTUDIO_API_KEY ? { authorization: `Bearer ${env.DASH_LMSTUDIO_API_KEY}` } : {};
  const lms = findLms(env);
  const busy = new Map();         // instance id -> since (ms)
  const tps = new Map();          // instance id -> last tokens per second
  let child = null, nextSpawn = 0, streaming = false;
  process.on("exit", () => child?.kill());

  function onLine(line) {
    const e = parseEvent(line);
    if (!e) return;
    if (e.type === "input") { busy.set(e.model, Date.now()); addTokens(e.model, 0, 0, 1); return; }
    busy.delete(e.model);
    if (e.stats) {
      addTokens(e.model, Math.max(0, e.stats.predictedTokensCount || 0), Math.max(0, e.stats.promptTokensCount || 0));
      if (e.stats.tokensPerSecond > 0) tps.set(e.model, e.stats.tokensPerSecond);
    }
  }

  function ensureStream() {
    if (child || !lms || !isLocal || Date.now() < nextSpawn) return;
    nextSpawn = Date.now() + 10_000;
    let p;
    try {
      const args = ["log", "stream", "--port", port, "--source", "model", "--filter", "input,output", "--json"];
      // a .mjs "lms" is run with this Node.js (used by the tests)
      const [cmd, argv] = /\.m?js$/.test(lms) ? [process.execPath, [lms, ...args]] : [lms, args];
      p = spawn(cmd, argv,
        { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    } catch (e) { log?.(`LM Studio: cannot start lms (${e.message})`); return; }
    child = p;
    let buf = "";
    p.stdout.on("data", (d) => {
      streaming = true;
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        try { onLine(line); } catch {}
      }
      if (buf.length > 64 << 20) buf = "";        // a runaway line: drop it
    });
    const gone = () => { if (child === p) { child = null; streaming = false; } };
    p.on("exit", gone);
    p.on("error", gone);
  }

  async function models() {
    try {
      const j = await getJSON(`${url}/api/v1/models`, { headers });
      return (j.models || []).map((m) => ({ key: m.key, type: m.type, instances: (m.loaded_instances || []).map((i) => ({ id: i.id, ctx: i.config?.context_length, parallel: i.config?.parallel, fa: i.config?.flash_attention })),
        quant: m.quantization?.name, params: m.params_string, size: m.size_bytes, format: m.format, arch: m.architecture }));
    } catch (e) {
      if (e.status !== 404) throw e;
      const j = await getJSON(`${url}/api/v0/models`, { headers });         // LM Studio before 0.4
      return (j.data || []).map((m) => ({ key: m.id, type: m.type, instances: m.state === "loaded" ? [{ id: m.id, ctx: m.loaded_context_length }] : [],
        quant: m.quantization, arch: m.arch, format: m.compatibility_type }));
    }
  }

  async function poll() {
    const list = await models();
    ensureStream();
    const now = Date.now();
    const out = [];
    for (const m of list) for (const i of m.instances) {
      const since = busy.get(i.id);
      if (since && now - since > 30 * 60_000) busy.delete(i.id);     // an output event that never came
      const processing = busy.has(i.id);
      out.push({ id: i.id, kind: m.type === "embedding" ? "embedding" : "text", processing, genRate: processing ? tps.get(i.id) || 0 : 0 });
    }
    for (const id of busy.keys()) if (!out.some((m) => m.id === id)) busy.delete(id);   // unloaded
    const note = !lms ? "lms CLI not found (~/.lmstudio/bin): models shown, no token counts"
      : !isLocal ? "token counts need LM Studio on this PC" : undefined;
    return { models: out, tokenSource: streaming || child ? "lms log" : "none", note };
  }

  async function setup() {
    const list = await models();
    const out = [];
    for (const m of list) {
      const base = { kind: m.type === "embedding" ? "embedding" : "text", paramsText: m.params, size: m.size };
      if (!m.instances.length) { out.push({ id: m.key, status: "unloaded", args: [], ...base }); continue; }
      for (const i of m.instances) {
        out.push({ id: i.id, status: "loaded", ...base, args: [["quant", m.quant], ["format", m.format], ["arch", m.arch],
          ["ctx", i.ctx], ["parallel", i.parallel], ["flash-attn", i.fa == null ? null : i.fa ? "on" : "off"]]
          .filter(([, v]) => v != null && v !== "").map(([k, v]) => [k, String(v)]) });
      }
    }
    return { mode: "lmstudio", models: out };
  }

  const stop = () => { nextSpawn = Infinity; child?.kill(); };
  return { name, url, poll, setup, stop };
}
