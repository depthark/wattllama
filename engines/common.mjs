// Shared helpers for engine adapters. See CONTRIBUTING.md for the adapter interface.

import fs from "node:fs";

export async function getJSON(url, { headers = {}, ms = 3000, method = "GET", body } = {}) {
  const r = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw Object.assign(new Error(`${r.status}`), { status: r.status });
  return r.json();
}

// Follows a growing log file: each call returns the complete lines written since the last
// call. It starts at the current end (older history is not counted twice), starts over
// when the file is replaced by a smaller one, and reads at most 4 MB per call.
// Returns null when the file does not exist.
export function tail(file) {
  let pos = null, rest = "";
  return () => {
    let size;
    try { size = fs.statSync(file).size; } catch { return null; }
    if (pos == null || size < pos) { pos = pos == null ? size : 0; rest = ""; }
    if (size <= pos) return [];
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(Math.min(size - pos, 4 << 20));
      const n = fs.readSync(fd, buf, 0, buf.length, pos);
      pos += n;
      const lines = (rest + buf.toString("utf8", 0, n)).split("\n");
      rest = lines.pop();
      if (rest.length > 1 << 20) rest = "";      // a runaway line without newline: drop it
      return lines;
    } finally { fs.closeSync(fd); }
  };
}

// One llama-server log line -> what it says, or null. "task" identifies the request.
//   { req: 1 }                    a request started on a slot
//   { pp: n, ms }                 n prompt tokens were processed in ms (print_timing)
//   { gen: n, ms }                n tokens were generated in ms (print_timing)
//   { draftAcc, draftGen }        speculative decoding: drafted tokens accepted / proposed
//   { release: n }                the request ended with n tokens in its context; models that
//                                 write no text (classifiers, embeddings) print only this
// Works with and without llama.cpp's log prefix / timestamps and the router's [port] prefix.
//
// Prompts can end up in a log, so a prompt could contain text that looks like these lines.
// The parser therefore accepts only llama.cpp's exact line layout from the start of the line
// ("[port] timestamp level slot <function>: id N | task N | ...", each prefix optional), and
// numbers within sane limits; anything else is ignored.
const LINE = /^(?:\[\d{1,5}\]\s+)?(?:\d+(?:\.\d+){1,4}\s+)?(?:[IWEDT]\s+)?slot\s+(launch_slot_|print_timing|release): id\s+\d+ \| task (\d+) \| (.*)$/;
const sane = (n, max) => Number.isFinite(n) && n >= 0 && n <= max;
export function parseLlamaLine(l) {
  const h = LINE.exec(String(l).replace(/\s+$/, ""));      // logs written through PowerShell end lines in \r\r
  if (!h) return null;
  const [, fn, taskStr, rest] = h;
  const task = Number(taskStr);
  if (fn === "launch_slot_") return /^processing task\b/.test(rest) ? { req: 1, task } : null;
  if (fn === "release") {
    const r = rest.match(/^stop processing: n_tokens = (\d+)/);
    return r && sane(Number(r[1]), 1e8) ? { release: Number(r[1]), task } : null;
  }
  const m = rest.match(/^\s*(prompt )?eval time =\s*([\d.]+) ms \/\s*(\d+) tokens \(/);
  if (m) {
    const ms = Number(m[2]), n = Number(m[3]);
    if (!sane(n, 1e8) || !sane(ms, 7 * 86400_000) || (ms > 0 && n / (ms / 1000) > 1e6)) return null;   // > 1M tok/s: not real
    return m[1] ? { pp: n, ms, task } : { gen: n, ms, task };
  }
  const d = rest.match(/^draft acceptance = [\d.]+ \(\s*(\d+) accepted \/\s*(\d+) generated\)/);
  if (d && sane(Number(d[2]), 1e8) && Number(d[1]) <= Number(d[2])) return { draftAcc: Number(d[1]), draftGen: Number(d[2]), task };
  return null;
}

// Collects the lines of one request (same model and task) into one record and hands it to
// onRequest when the request ends: { ts, model, ctx, nCtx, pp, ppMs, gen, genMs, draftAcc,
// draftGen, cached }. ctx = context depth at the end; cached = prompt tokens reused from the
// cache (depth minus what was computed). Numbers only. Unfinished entries expire after 15 min.
export function requestAssembler(onRequest, { nCtxOf = () => null, now = () => Date.now() } = {}) {
  const open = new Map();
  return (model, kind, x) => {
    if (!x || x.task == null) return;
    const key = `${model}\0${x.task}`;
    let r = open.get(key);
    if (!r) open.set(key, r = { ts: now(), model });
    if (x.pp != null) { r.pp = x.pp; r.ppMs = x.ms; }
    else if (x.gen != null) { r.gen = x.gen; r.genMs = x.ms; }
    else if (x.draftAcc != null) { r.draftAcc = x.draftAcc; r.draftGen = x.draftGen; }
    else if (x.release != null) {
      open.delete(key);
      if (r.genMs == null && r.ppMs == null && kind === "text") return;      // nothing measured
      r.ctx = x.release;
      if (kind !== "text" && r.pp == null) r.pp = x.release;               // classifiers: what they read
      r.cached = Math.max(0, x.release - (r.pp ?? 0) - (r.gen ?? 0));
      r.nCtx = nCtxOf(model);
      onRequest(r);
    }
    if (open.size > 200) { const cut = now() - 15 * 60_000; for (const [k, v] of open) if (v.ts < cut) open.delete(k); }
  };
}

// Polls a llama-server's /slots. Returns { processing, gen, req, nCtx, slots } since the last
// call (gen = tokens decoded, approximate: /slots resets n_decoded when a request ends), or
// null when the server has no /slots (--no-slots). slots = [{ processing, ctx, nCtx, speculative }].
export function slotPoller() {
  const state = new Map();
  return async (url, headers) => {
    let slots;
    try { slots = await getJSON(`${url}`, { headers }); } catch { return null; }
    if (!Array.isArray(slots)) return null;
    let processing = false, gen = 0, req = 0, nCtx = 0;
    const out = [];
    for (const s of slots) {
      const nt = Array.isArray(s.next_token) ? s.next_token[0] : s.next_token;
      const dec = nt?.n_decoded ?? 0;
      const st = state.get(s.id);
      if (s.is_processing && st && st.task === s.id_task) gen += Math.max(0, dec - st.dec);
      else if (s.is_processing) { gen += dec; req++; }       // a new request, or a server seen for the first time
      state.set(s.id, { task: s.id_task, dec });
      if (s.is_processing) processing = true;
      nCtx = Math.max(nCtx, s.n_ctx || 0);
      out.push({ processing: !!s.is_processing, ctx: (s.n_prompt_tokens || 0) + (s.is_processing ? dec : 0),
        nCtx: s.n_ctx || null, speculative: !!s.speculative });
    }
    return { processing, gen, req, nCtx: nCtx || null, slots: out };
  };
}

// Smoothed tokens per second while a model generates.
export function rate(prev, processing, tokens, dt) {
  if (!processing) return 0;
  const r = dt > 0 ? tokens / dt : 0;
  return prev ? 0.5 * prev + 0.5 * r : r;
}

// Command-line flags -> [["flag", "value"], ...] for display. Plumbing flags are left out,
// secrets (--api-key, tokens, TLS keys) are masked and paths shortened to the file name,
// so the page never shows a credential or your folder layout.
// The file name of a Windows or POSIX path on any OS (path.basename on Linux keeps "C:\Users\...").
export const baseName = (p) => String(p).split(/[\\/]/).filter(Boolean).pop() || "";
const SECRET_ARG =/key|token|secret|password|passwd|auth|cred/i;
const SKIP_ARG = new Set(["host", "port", "alias", "log-colors", "no-log-prefix", "no-log-timestamps", "log-verbosity"]);
export function argPairs(a) {
  const out = [];
  for (let i = 0; i < a.length; i++) {
    const s = String(a[i]);
    if (!s.startsWith("-") || /^-\d/.test(s)) continue;
    const k = s.replace(/^--?/, "");
    const v = a[i + 1] != null && !/^--?[a-z]/i.test(String(a[i + 1])) ? String(a[++i]) : "";
    if (SKIP_ARG.has(k)) continue;
    out.push([k, SECRET_ARG.test(k) ? (v ? "••••" : "") : /[\\/]/.test(v) ? baseName(v) : v]);
  }
  return out;
}
