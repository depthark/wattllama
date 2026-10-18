// llama.cpp: a single llama-server, or the router (--models-dir / --models-preset) with
// any number of models loaded at once.
//
// "Generating" comes from /slots. Token counts, best source first:
//   1. DASH_LLAMA_LOG: the server's log file; exact (print_timing lines)
//   2. /metrics (server started with --metrics); exact
//   3. /slots; approximate, the last moments of each reply are missed
// In router mode only models that are already loaded are asked, because
// /slots?model=X on an unloaded model would make the router load it.

import { getJSON, tail, parseLlamaLine, slotPoller, rate, argPairs, baseName } from "./common.mjs";

export const name = "llama.cpp";

export function create({ env, addTokens }) {
  const url = (env.DASH_LLAMA_URL ?? "http://127.0.0.1:8080").replace(/\/$/, "");
  if (!url) return null;
  const headers = env.DASH_LLAMA_API_KEY ? { authorization: `Bearer ${env.DASH_LLAMA_API_KEY}` } : {};
  const readLog = env.DASH_LLAMA_LOG ? tail(env.DASH_LLAMA_LOG) : null;
  const kindOf = new Map();       // model -> output modalities ("text", "decisions", ...)
  const portModel = new Map();    // router child port -> model id (log lines start with [port])
  const slots = new Map();        // model -> slotPoller
  const metricState = new Map();
  let singleModel = null, last = { t: 0, models: [] };

  const kind = (m) => (m?.architecture?.output_modalities || ["text"]).join(",");

  async function targets() {
    // Router: /models lists every model with status.value; single server: no status.
    const data = (await getJSON(`${url}/models`, { headers })).data || [];
    if (!data.some((m) => m.status)) {
      singleModel = data[0]?.id || "model";
      kindOf.set(singleModel, kind(data[0]));
      return [{ id: singleModel, q: "" }];
    }
    singleModel = null;
    const loaded = data.filter((m) => m.status?.value === "loaded");
    for (const m of loaded) {
      kindOf.set(m.id, kind(m));
      const a = m.status.args || [];
      const i = a.indexOf("--port");
      if (i >= 0) portModel.set(String(a[i + 1]), m.id);
    }
    return loaded.map((m) => ({ id: m.id, q: `?model=${encodeURIComponent(m.id)}` }));
  }

  function consumeLog() {
    const lines = readLog();
    if (lines == null) return false;
    for (const l of lines) {
      const x = parseLlamaLine(l);
      if (!x) continue;
      const port = l.match(/^\[(\d+)\]/)?.[1];
      const model = port ? portModel.get(port) : singleModel;
      if (!model) continue;
      if (x.req) addTokens(model, 0, 0, 1);
      else if (x.gen != null) addTokens(model, x.gen, 0);
      else if (x.pp != null) addTokens(model, 0, x.pp);
      else if (x.release != null && (kindOf.get(model) || "text") !== "text") addTokens(model, 0, x.release);
    }
    return true;
  }

  async function readMetrics(t) {
    let text;
    try {
      const r = await fetch(`${url}/metrics${t.q}`, { headers, signal: AbortSignal.timeout(3000) });
      if (!r.ok) return false;
      text = await r.text();
    } catch { return false; }
    const val = (n) => Number(text.match(new RegExp(`^llamacpp:${n}\\s+([\\d.e+]+)`, "m"))?.[1] ?? NaN);
    const gen = val("tokens_predicted_total"), pp = val("prompt_tokens_total");
    if (!Number.isFinite(gen)) return false;
    const prev = metricState.get(t.id);
    if (prev) addTokens(t.id, gen >= prev.gen ? gen - prev.gen : gen, pp >= prev.pp ? pp - prev.pp : pp);   // went down: reloaded
    metricState.set(t.id, { gen, pp });
    return true;
  }

  async function poll() {
    const list = await targets();
    const useLog = !!readLog && consumeLog();
    const now = Date.now(), dt = (now - (last.t || now)) / 1000;
    const prev = new Map(last.models.map((m) => [m.id, m]));
    const models = [];
    let anyMetrics = false;
    for (const t of list) {
      const metricsOk = !useLog && (await readMetrics(t));
      anyMetrics ||= metricsOk;
      if (!slots.has(t.id)) slots.set(t.id, slotPoller());
      const s = await slots.get(t.id)(`${url}/slots${t.q}`, headers);   // null: --no-slots
      if (s && !useLog) addTokens(t.id, metricsOk ? 0 : s.gen, 0, s.req);
      models.push({ id: t.id, kind: kindOf.get(t.id) || "text", processing: !!s?.processing,
        genRate: rate(prev.get(t.id)?.genRate, !!s?.processing, s?.gen || 0, dt) });
    }
    last = { t: now, models };
    return { models, tokenSource: useLog ? "log" : anyMetrics ? "metrics" : list.length ? "slots" : "none" };
  }

  // Every model with its status and the exact command-line arguments it runs with
  // (router), or /props for a single server.
  async function setup() {
    const data = (await getJSON(`${url}/models`, { headers })).data || [];
    if (data.some((m) => m.status)) {
      return { mode: "router", models: data.map((m) => ({
        id: m.id, status: m.status?.value, args: argPairs(m.status?.args || []), kind: kind(m),
        ctxTrain: m.meta?.n_ctx_train, params: m.meta?.n_params, size: m.meta?.size })) };
    }
    const p = await getJSON(`${url}/props`, { headers }).catch(() => ({}));
    return { mode: "server", models: [{ id: data[0]?.id, status: "loaded", kind: kind(data[0]),
      args: [["model", baseName(p.model_path || "")], ["ctx-size", p.default_generation_settings?.n_ctx],
        ["build", p.build_info]].filter((x) => x[1]),
      ctxTrain: data[0]?.meta?.n_ctx_train, params: data[0]?.meta?.n_params, size: data[0]?.meta?.size }] };
  }

  return { name, url, poll, setup };
}
