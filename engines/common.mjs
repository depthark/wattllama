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

// One llama-server log line -> what it says about tokens, or null.
//   { req: 1 }        a request started on a slot
//   { pp: n }         n prompt tokens were processed (print_timing)
//   { gen: n }        n tokens were generated (print_timing)
//   { release: n }    a slot finished with n tokens in its context; models that write no
//                     text (classifiers, embeddings) print no timings, only this
// Works with and without llama.cpp's log prefix / timestamps and the router's [port] prefix.
export function parseLlamaLine(l) {
  if (!l.includes("slot")) return null;
  if (/launch_slot_.*processing task/.test(l)) return { req: 1 };
  const m = l.match(/print_timing:.*\|\s+(prompt )?eval time =\s*[\d.]+ ms \/\s*(\d+) tokens/);
  if (m) return m[1] ? { pp: Number(m[2]) } : { gen: Number(m[2]) };
  const r = l.match(/release:.*n_tokens = (\d+)/);
  if (r) return { release: Number(r[1]) };
  return null;
}

// Polls a llama-server's /slots. Returns { processing, gen, req } since the last call
// (gen = tokens decoded, approximate: /slots resets n_decoded when a request ends), or
// null when the server has no /slots (--no-slots).
export function slotPoller() {
  const state = new Map();
  return async (url, headers) => {
    let slots;
    try { slots = await getJSON(`${url}`, { headers }); } catch { return null; }
    if (!Array.isArray(slots)) return null;
    let processing = false, gen = 0, req = 0;
    for (const s of slots) {
      const nt = Array.isArray(s.next_token) ? s.next_token[0] : s.next_token;
      const dec = nt?.n_decoded ?? 0;
      const st = state.get(s.id);
      if (s.is_processing && st && st.task === s.id_task) gen += Math.max(0, dec - st.dec);
      else if (s.is_processing) { gen += dec; req++; }       // a new request, or a server seen for the first time
      state.set(s.id, { task: s.id_task, dec });
      if (s.is_processing) processing = true;
    }
    return { processing, gen, req };
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
