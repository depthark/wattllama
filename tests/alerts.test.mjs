import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createAlerts, parseWebhook, webhookRequest } from "../alerts.mjs";

function setup(env = {}, start = new Date(2026, 9, 18, 12, 0, 0).getTime()) {
  let t = start;
  const sent = [];
  const db = new DatabaseSync(":memory:");
  const fetchImpl = async (url, opts) => { sent.push({ url, ...opts }); return { ok: true, status: 204 }; };
  const a = createAlerts({ env, db, log: () => {}, fetchImpl, now: () => t });
  const tick = (s, sec = 2) => { t += sec * 1000; a.check(s); };
  return { a, db, sent, tick, advance: (ms) => { t += ms; }, now: () => t };
}
const gpu = (temp, extra = {}) => ({ index: "0", name: "RTX 4070", temp, vramUsed: 8000, vramTotal: 12282, throttle: [], ...extra });
const flush = () => new Promise((r) => setImmediate(r));

test("a condition must hold for a minute, fires once, then resolves", async () => {
  const { a, tick } = setup();
  for (let i = 0; i < 20; i++) tick({ gpus: [gpu(85)] });        // 40 s
  assert.equal(a.list().length, 0, "not yet: a short spike is not an alert");
  for (let i = 0; i < 15; i++) tick({ gpus: [gpu(86)] });        // past 60 s
  assert.equal(a.list().length, 1);
  assert.equal(a.active().length, 1);
  for (let i = 0; i < 10; i++) tick({ gpus: [gpu(86)] });
  assert.equal(a.list().length, 1, "no repeats while it lasts");
  tick({ gpus: [gpu(70)] });
  assert.equal(a.active().length, 0);
  assert.deepEqual(a.list().map((e) => e.level), ["ok", "warn"]);
});

test("cooldown: the same alert again only after 30 minutes", () => {
  const { a, tick, advance } = setup();
  const hot = () => { for (let i = 0; i < 35; i++) tick({ gpus: [gpu(90)] }); tick({ gpus: [gpu(60)] }); };
  hot(); hot();
  assert.equal(a.list().filter((e) => e.level !== "ok").length, 1);
  advance(31 * 60_000); hot();
  assert.equal(a.list().filter((e) => e.level !== "ok").length, 2);
});

test("critical level well above the threshold; throttle ignores the normal power cap", () => {
  const { a, tick } = setup();
  for (let i = 0; i < 35; i++) tick({ gpus: [gpu(92, { throttle: ["power cap"] })] });
  assert.equal(a.list()[0].level, "crit");
  assert.ok(!a.list().some((e) => e.title.includes("slowing")));
  for (let i = 0; i < 35; i++) tick({ gpus: [gpu(60, { throttle: ["thermal (HW)"] })] });
  assert.ok(a.list().some((e) => e.title.includes("slowing down")));
});

test("VRAM above 99 %", () => {
  const { a, tick } = setup();
  for (let i = 0; i < 35; i++) tick({ gpus: [gpu(60, { vramUsed: 12250 })] });
  assert.match(a.list()[0].message, /12\.0 of 12\.0 GB \(99\.7 %\)/);
});

test("engine down only for engines that were running, after 2 minutes, with 'back to normal'", () => {
  const { a, tick } = setup();
  for (let i = 0; i < 100; i++) tick({ engines: [{ name: "LM Studio", reachable: false }] });
  assert.equal(a.list().length, 0, "never seen running: no alert");
  tick({ engines: [{ name: "llama.cpp", reachable: true }] });
  for (let i = 0; i < 50; i++) tick({ engines: [{ name: "llama.cpp", reachable: false }] });
  assert.equal(a.list().length, 0, "a restart under 2 minutes is quiet");
  for (let i = 0; i < 15; i++) tick({ engines: [{ name: "llama.cpp", reachable: false }] });
  assert.equal(a.list()[0].level, "crit");
  tick({ engines: [{ name: "llama.cpp", reachable: true }] });
  assert.equal(a.list()[0].level, "ok");
});

test("daily budgets fire once a day, also across a restart", () => {
  const s = setup({ DASH_ALERT_DAILY_KWH: "2", DASH_ALERT_DAILY_COST: "10" });
  s.tick({ todayWh: 1500, price: 6, currency: "CZK" });
  assert.equal(s.a.list().length, 0);
  s.tick({ todayWh: 2100, price: 6, currency: "CZK" });
  assert.deepEqual(s.a.list().map((e) => e.title).sort(), ["Daily cost budget reached", "Daily energy budget reached"]);
  s.tick({ todayWh: 3000, price: 6, currency: "CZK" });
  assert.equal(s.a.list().length, 2);
  const again = createAlerts({ env: { DASH_ALERT_DAILY_KWH: "2" }, db: s.db, log: () => {}, now: s.now });
  again.check({ todayWh: 3100 });
  assert.equal(again.list().length, 2, "restart: not again today");
});

test("empty setting turns a rule off; DASH_ALERTS=0 turns all off", () => {
  const { a, tick } = setup({ DASH_ALERT_GPU_TEMP: "" });
  for (let i = 0; i < 40; i++) tick({ gpus: [gpu(99)] });
  assert.equal(a.list().length, 0);
  const off = setup({ DASH_ALERTS: "0" });
  for (let i = 0; i < 40; i++) off.tick({ gpus: [gpu(99, { vramUsed: 12282 })] });
  assert.equal(off.a.list().length, 0);
});

test("webhook URL: https anywhere, http only locally; never exposed", () => {
  assert.equal(parseWebhook("https://discord.com/api/webhooks/1/abc").format, "discord");
  assert.equal(parseWebhook("https://ntfy.sh/my-topic").format, "ntfy");
  assert.equal(parseWebhook("https://hooks.slack.com/services/x").format, "slack");
  assert.equal(parseWebhook("http://192.168.1.5:8080/notify").format, "json");
  assert.ok(parseWebhook("http://example.com/hook").error, "plain http to the internet is refused");
  assert.ok(parseWebhook("file:///etc/passwd").error);
  assert.ok(parseWebhook("not a url").error);
  const { a } = setup({ DASH_ALERT_WEBHOOK: "https://discord.com/api/webhooks/123/SECRET" });
  assert.ok(!JSON.stringify(a.settings()).includes("SECRET"));
  assert.equal(a.settings().webhook, "discord");
});

test("messages: Discord mentions disabled, ntfy headers ASCII, numbers only", async () => {
  const ev = { ts: 0, kind: "busy", level: "warn", title: "@everyone model", message: "x" };
  const d = JSON.parse(webhookRequest({ format: "discord" }, ev).body);
  assert.deepEqual(d.allowed_mentions, { parse: [] });
  const n = webhookRequest({ format: "ntfy" }, { ...ev, title: "GPU 0 is hot 🔥" });
  assert.ok(/^[\x20-\x7e]*$/.test(n.headers.title));
  const { tick, sent } = setup({ DASH_ALERT_WEBHOOK: "https://ntfy.sh/t" });
  for (let i = 0; i < 35; i++) tick({ gpus: [gpu(88)] });
  await flush();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].method, "POST");
  assert.equal(sent[0].redirect, "error", "no redirects to somewhere else");
});

test("at most 20 webhook messages an hour", async () => {
  const { a, tick, sent } = setup({ DASH_ALERT_WEBHOOK: "https://ntfy.sh/t", DASH_ALERT_COOLDOWN_MIN: "0" });
  for (let k = 0; k < 30; k++) {
    for (let i = 0; i < 31; i++) tick({ gpus: [gpu(90)] }, 2);
    tick({ gpus: [gpu(50)] });
    await flush();
  }
  assert.ok(a.list().length >= 50, "events are still recorded on the page");
  assert.equal(sent.length, 20);
});
