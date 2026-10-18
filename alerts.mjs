// Alerts: conditions that held long enough become an event (stored, shown on the page) and,
// only if DASH_ALERT_WEBHOOK is set, a message to Discord, ntfy, Slack or any JSON endpoint.
//
//   gpu-temp      GPU temperature >= DASH_ALERT_GPU_TEMP (83 °C) for 60 s
//   cpu-temp      CPU temperature >= DASH_ALERT_CPU_TEMP (90 °C) for 60 s (needs a CPU sensor)
//   gpu-throttle  the GPU slows down for heat or a hardware reason (not the normal power cap) for 60 s
//   vram          a GPU's memory >= DASH_ALERT_VRAM_PCT (99 %) for 60 s: past that, models page and slow down
//   engine-down   an engine that was running stops answering for 120 s (and "back" when it returns)
//   busy          one model generating without a pause for DASH_ALERT_BUSY_MIN (60) minutes
//   daily-kwh     today's energy passes DASH_ALERT_DAILY_KWH (off unless set), once a day
//   daily-cost    today's cost passes DASH_ALERT_DAILY_COST (off unless set; needs a price), once a day
//
// The same alert fires again only after DASH_ALERT_COOLDOWN_MIN (30) minutes, and at most
// 20 webhook messages go out per hour. Messages carry numbers and model names only.

const DAY = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const numOr = (v, d) => { const n = parseFloat(String(v ?? "").replace(",", ".")); return v === "" ? null : Number.isFinite(n) ? n : d; };
const isPrivateHost = (h) => /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|[^.]+\.local$)/i.test(h);

// Webhook URL -> { url, format } or { error }. HTTPS anywhere; plain HTTP only to this PC or the LAN.
export function parseWebhook(raw, formatHint) {
  if (!raw) return null;
  let u;
  try { u = new URL(raw); } catch { return { error: "DASH_ALERT_WEBHOOK is not a URL" }; }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && isPrivateHost(u.hostname))) {
    return { error: "DASH_ALERT_WEBHOOK must be https:// (plain http only to this PC or the local network)" };
  }
  const h = u.hostname.toLowerCase();
  const format = ["discord", "ntfy", "slack", "json"].includes(formatHint) ? formatHint
    : /(^|\.)discord(app)?\.com$/.test(h) && u.pathname.startsWith("/api/webhooks/") ? "discord"
    : /(^|\.)hooks\.slack\.com$/.test(h) ? "slack"
    : /ntfy/.test(h) ? "ntfy" : "json";
  return { url: u.toString(), host: h, format };
}

// What goes over the wire, per format. Discord mentions are disabled, so a model name can
// never ping anyone.
export function webhookRequest(hook, ev) {
  const icon = ev.level === "ok" ? "✅" : ev.level === "crit" ? "🔥" : "⚠️";
  const text = `${icon} ${ev.title}: ${ev.message}`;
  if (hook.format === "discord") return { headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "WattLlama", content: text.slice(0, 1900), allowed_mentions: { parse: [] } }) };
  if (hook.format === "slack") return { headers: { "content-type": "application/json" }, body: JSON.stringify({ text: text.slice(0, 3000) }) };
  if (hook.format === "ntfy") return { headers: { "content-type": "text/plain; charset=utf-8", title: `WattLlama: ${ev.title}`.replace(/[^\x20-\x7e]/g, ""),
    priority: ev.level === "crit" ? "high" : ev.level === "ok" ? "low" : "default", tags: ev.level === "ok" ? "white_check_mark" : "warning" }, body: ev.message };
  return { headers: { "content-type": "application/json" }, body: JSON.stringify({ source: "wattllama", kind: ev.kind, level: ev.level, title: ev.title, message: ev.message, time: new Date(ev.ts).toISOString() }) };
}

export function createAlerts({ env, db, readDb = db, log, fetchImpl = fetch, now = () => Date.now() }) {
  const cfg = {
    gpuTemp: numOr(env.DASH_ALERT_GPU_TEMP, 83), cpuTemp: numOr(env.DASH_ALERT_CPU_TEMP, 90),
    vramPct: numOr(env.DASH_ALERT_VRAM_PCT, 99), busyMin: numOr(env.DASH_ALERT_BUSY_MIN, 60),
    dailyKwh: numOr(env.DASH_ALERT_DAILY_KWH ?? "", null), dailyCost: numOr(env.DASH_ALERT_DAILY_COST ?? "", null),
    cooldownMs: (numOr(env.DASH_ALERT_COOLDOWN_MIN, 30) ?? 30) * 60_000,
    throttle: env.DASH_ALERT_THROTTLE !== "0", engineDown: env.DASH_ALERT_ENGINE_DOWN !== "0",
    enabled: env.DASH_ALERTS !== "0",
  };
  const hook = parseWebhook(env.DASH_ALERT_WEBHOOK || "", (env.DASH_ALERT_FORMAT || "").toLowerCase());
  if (hook?.error) log(`alerts: ${hook.error}; webhook off`);
  else if (hook) log(`alerts: webhook on (${hook.format}, ${hook.host})`);      // never the full URL: it is a secret

  db.exec(`CREATE TABLE IF NOT EXISTS events (ts INTEGER, kind TEXT, key TEXT, level TEXT, title TEXT, message TEXT, sent INTEGER DEFAULT 0)`);
  db.exec(`CREATE INDEX IF NOT EXISTS events_ts ON events (ts)`);
  const insert = db.prepare(`INSERT INTO events (ts, kind, key, level, title, message, sent) VALUES (?,?,?,?,?,?,?)`);

  const since = new Map();      // condition key -> first time it was true
  const firing = new Map();     // condition key -> { ts, title } while active
  const lastFired = new Map();  // condition key -> time
  const daily = new Set();      // "daily-kwh:2026-10-18"
  const engineSeen = new Set(); // engines that answered at least once
  let sentTimes = [], queue = 0;

  async function send(ev) {
    if (!hook || hook.error) return false;
    const t = now();
    sentTimes = sentTimes.filter((x) => t - x < 3600_000);
    if (sentTimes.length >= 20 || queue >= 5) { log("alerts: webhook rate limit reached, not sent"); return false; }
    sentTimes.push(t); queue++;
    try {
      const r = webhookRequest(hook, ev);
      const res = await fetchImpl(hook.url, { method: "POST", headers: r.headers, body: r.body, signal: AbortSignal.timeout(5000), redirect: "error" });
      if (!res.ok) { log(`alerts: webhook answered ${res.status}`); return false; }
      return true;
    } catch (e) { log(`alerts: webhook failed (${e.name === "TimeoutError" ? "timeout" : e.code || e.name})`); return false; }
    finally { queue--; }
  }

  function emit(kind, key, level, title, message) {
    const ev = { ts: now(), kind, key, level, title, message };
    const info = insert.run(ev.ts, kind, key, level, title, message, 0);
    send(ev).then((ok) => { if (ok) db.prepare("UPDATE events SET sent = 1 WHERE rowid = ?").run(info.lastInsertRowid); }).catch(() => {});
    log(`alert: ${title}: ${message}`);
    return ev;
  }

  // A condition that must hold for holdMs before it fires; "resolved" when it clears.
  function cond(key, active, holdMs, make, { resolve = true } = {}) {
    const t = now();
    if (active) {
      if (!since.has(key)) since.set(key, t);
      if (!firing.has(key) && t - since.get(key) >= holdMs && t - (lastFired.get(key) ?? -Infinity) >= cfg.cooldownMs) {
        const { kind, level = "warn", title, message } = make();
        emit(kind, key, level, title, message);
        firing.set(key, { ts: t, title, kind });
        lastFired.set(key, t);
      }
    } else {
      since.delete(key);
      const f = firing.get(key);
      if (f) {
        firing.delete(key);
        if (resolve) emit(f.kind, key, "ok", `${f.title}: back to normal`, "");
      }
    }
  }

  // s: { gpus, cpuTemp, engines: [{ name, reachable }], models: [{ id, processing }], todayWh, price, currency }
  function check(s) {
    if (!cfg.enabled) return;
    for (const g of s.gpus || []) {
      const name = `GPU ${g.index} (${g.name})`;
      if (cfg.gpuTemp != null) cond(`gpu-temp:${g.index}`, g.temp != null && g.temp >= cfg.gpuTemp, 60_000,
        () => ({ kind: "gpu-temp", level: g.temp >= cfg.gpuTemp + 7 ? "crit" : "warn", title: `${name} is hot`, message: `${g.temp} °C (alert at ${cfg.gpuTemp} °C)` }));
      const bad = (g.throttle || []).filter((x) => /thermal|HW slowdown|power brake/.test(x));
      if (cfg.throttle) cond(`gpu-throttle:${g.index}`, bad.length > 0, 60_000,
        () => ({ kind: "gpu-throttle", title: `${name} is slowing down`, message: `${bad.join(", ")} for over a minute` }));
      if (cfg.vramPct != null && g.vramTotal) {
        const pct = 100 * (g.vramUsed ?? 0) / g.vramTotal;
        cond(`vram:${g.index}`, pct >= cfg.vramPct, 60_000,
          () => ({ kind: "vram", title: `${name} memory is full`, message: `${(g.vramUsed / 1024).toFixed(1)} of ${(g.vramTotal / 1024).toFixed(1)} GB (${pct.toFixed(1)} %): models may spill to system RAM and slow down` }));
      }
    }
    if (cfg.cpuTemp != null) cond("cpu-temp", s.cpuTemp != null && s.cpuTemp >= cfg.cpuTemp, 60_000,
      () => ({ kind: "cpu-temp", level: s.cpuTemp >= cfg.cpuTemp + 7 ? "crit" : "warn", title: "CPU is hot", message: `${Math.round(s.cpuTemp)} °C (alert at ${cfg.cpuTemp} °C)` }));
    if (cfg.engineDown) for (const e of s.engines || []) {
      if (e.reachable) engineSeen.add(e.name);
      if (engineSeen.has(e.name)) cond(`engine-down:${e.name}`, !e.reachable, 120_000,
        () => ({ kind: "engine-down", level: "crit", title: `${e.name} stopped answering`, message: "for over 2 minutes" }));
    }
    if (cfg.busyMin) for (const m of s.models || []) cond(`busy:${m.id}`, !!m.processing, cfg.busyMin * 60_000,
      () => ({ kind: "busy", title: `${m.id} has been generating for ${cfg.busyMin} min without a pause`, message: "a runaway generation or a stuck agent?" }), { resolve: false });
    const day = DAY(new Date(now()));
    if (cfg.dailyKwh != null && s.todayWh / 1000 >= cfg.dailyKwh && !daily.has(`kwh:${day}`)) {
      daily.add(`kwh:${day}`);
      emit("daily-kwh", `daily-kwh:${day}`, "warn", "Daily energy budget reached", `${(s.todayWh / 1000).toFixed(2)} kWh today (budget ${cfg.dailyKwh} kWh)`);
    }
    if (cfg.dailyCost != null && s.price && (s.todayWh / 1000) * s.price >= cfg.dailyCost && !daily.has(`cost:${day}`)) {
      daily.add(`cost:${day}`);
      emit("daily-cost", `daily-cost:${day}`, "warn", "Daily cost budget reached", `${((s.todayWh / 1000) * s.price).toFixed(2)} ${s.currency || ""} today (budget ${cfg.dailyCost} ${s.currency || ""})`.replace(/ +\)/, ")"));
    }
  }

  // Budgets already passed before a restart should not fire again the same day.
  for (const r of db.prepare("SELECT key FROM events WHERE kind IN ('daily-kwh','daily-cost') AND ts >= ?").all(new Date(new Date(now()).setHours(0, 0, 0, 0)).getTime())) {
    daily.add(r.key.replace(/^daily-/, ""));         // "daily-kwh:2026-10-18" -> "kwh:2026-10-18"
  }

  const list = (limit = 50) => readDb.prepare("SELECT ts, kind, level, title, message, sent FROM events ORDER BY ts DESC LIMIT ?").all(Math.min(Math.max(limit, 1), 500));
  const active = () => [...firing.values()].map((f) => ({ since: f.ts, title: f.title, kind: f.kind }));
  const settings = () => ({ enabled: cfg.enabled, gpuTemp: cfg.gpuTemp, cpuTemp: cfg.cpuTemp, vramPct: cfg.vramPct, busyMin: cfg.busyMin,
    dailyKwh: cfg.dailyKwh, dailyCost: cfg.dailyCost, throttle: cfg.throttle, engineDown: cfg.engineDown,
    webhook: hook && !hook.error ? hook.format : hook?.error ? "invalid" : null });     // the format only, never the URL
  const test = async () => send({ ts: now(), kind: "test", level: "ok", title: "Test", message: "WattLlama alerts reach you." });
  return { check, list, active, settings, test, cfg };
}
