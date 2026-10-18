// Attacks WattLlama must withstand: SQL injection through every parameter, forged log lines
// from prompt text, brute-forcing the LAN token, HTML / script injection through model names,
// and mention injection into alert messages. Plus a static guard against dynamic SQL.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseLlamaLine } from "../engines/common.mjs";
import { webhookRequest } from "../alerts.mjs";
import { mockServer } from "./helpers.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function request(port, p, headers = {}) {
  return new Promise((ok, fail) => {
    const r = http.request({ host: "127.0.0.1", port, path: p, headers }, (res) => {
      let body = ""; res.on("data", (d) => body += d); res.on("end", () => ok({ status: res.statusCode, headers: res.headers, body }));
    });
    r.on("error", (e) => { e.message = `${p}: ${e.message}`; fail(e); }); r.end();
  });
}

async function startServer(extraEnv = {}, args = ["--demo"]) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wattllama-sec-"));
  const env = { ...process.env, DASH_PORT: "0", DASH_HOST: "127.0.0.1", DASH_DATA_DIR: dataDir, DASH_LLAMA_URL: "", DASH_OLLAMA_URL: "",
    DASH_LMSTUDIO_URL: "", DASH_TOKEN: "", DASH_TASKS: "", DASH_ALERT_WEBHOOK: "", DASH_PI_DIR: path.join(dataDir, "nopi"), ...extraEnv };
  const srv = spawn(process.execPath, ["--no-warnings", path.join(ROOT, "server.mjs"), ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = ""; srv.stdout.on("data", (d) => out += d); srv.stderr.on("data", (d) => out += d);
  for (let i = 0; i < 50 && !/WattLlama on/.test(out); i++) await new Promise((r) => setTimeout(r, 200));
  const port = Number(out.match(/WattLlama on http:\/\/127\.0\.0\.1:(\d+)/)?.[1]);
  assert.ok(port > 0, `server started:\n${out}`);
  return { port, out: () => out, stop: async () => { srv.kill(); await new Promise((r) => setTimeout(r, 300)); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}

// ---------- SQL injection ----------

const PAYLOADS = ["' OR '1'='1", "'; DROP TABLE m; --", "1; DELETE FROM runs", "\" OR 1=1 --", "1 UNION SELECT name, sql FROM sqlite_master --",
  "%27%20OR%201%3D1", "../../../etc/passwd", "<script>alert(1)</script>", "\u0000", "9".repeat(400), "-1", "NaN", "1e309", "[object Object]"];

test("SQL injection: every parameter of every endpoint, nothing changes, nothing breaks", { timeout: 120_000 }, async () => {
  const s = await startServer();
  try {
    const before = JSON.parse((await request(s.port, "/api/summary")).body).all;
    const runsBefore = JSON.parse((await request(s.port, "/api/runs")).body).length;
    const endpoints = [["/api/series", "range"], ["/api/heatmap", "days"], ["/api/heatmap", "model"], ["/api/report", "period"],
      ["/api/report.csv", "period"], ["/api/export.csv", "data"], ["/api/export.csv", "range"], ["/api/requests", "model"], ["/api/requests", "range"]];
    for (const [ep, param] of endpoints) for (const p of PAYLOADS) {
      const r = await request(s.port, `${ep}?${param}=${encodeURIComponent(p)}`);
      assert.ok(r.status === 200, `${ep}?${param}=${p} -> ${r.status}`);
      assert.ok(!/CREATE TABLE|SQLITE_ERROR|SqliteError/i.test(r.body), `${ep}?${param}=${p} leaked the schema or an SQL error`);   // the parameter itself may be echoed back as JSON
    }
    assert.deepEqual(JSON.parse((await request(s.port, "/api/summary")).body).all, before, "no data changed");
    assert.equal(JSON.parse((await request(s.port, "/api/runs")).body).length, runsBefore);
    assert.ok(!/internal error|SqliteError|syntax error/i.test(s.out()), "no query failed");
  } finally { await s.stop(); }
});

test("static guard: SQL text is never built from request data", () => {
  // Every ${...} inside SQL handed to prepare() / exec() must be one of these: fixed lists,
  // numbers computed by the code, or schema names from the code itself.
  const ALLOWED = new Set(["stepMs", "table", "tcol", "col", "def", "p", "v + 1", "M_COLS.join(\",\")", "M_COLS.map(() => \"?\").join(\",\")"]);
  const bad = [];
  for (const f of ["server.mjs", "db.mjs", "alerts.mjs"]) {
    const src = fs.readFileSync(path.join(ROOT, f), "utf8");
    for (const m of src.matchAll(/\b(?:prepare|exec)\(`([^`]*)`/g)) {
      for (const x of m[1].matchAll(/\$\{([^}]*(?:\([^)]*\))?[^}]*)\}/g)) if (!ALLOWED.has(x[1].trim())) bad.push(`${f}: \${${x[1]}}`);
    }
  }
  assert.deepEqual(bad, [], "dynamic SQL from an unexpected expression");
  // ...and the identifiers that are interpolated come from fixed lists only:
  const srv = fs.readFileSync(path.join(ROOT, "server.mjs"), "utf8");
  assert.match(srv, /const \[table, tcol\] = EXPORTS\[what\] \|\| EXPORTS\.minutes;/);
  assert.match(srv, /if \(!RANGES\[range\]\) range = "24h";/);
});

// ---------- forged log lines (prompt injection into the log) ----------

test("log parser: text that only looks like llama.cpp output is ignored", () => {
  const real = "[61447] 0.37.951.623 I slot print_timing: id  0 | task 0 |        eval time =    1541.33 ms /    63 tokens (   24.86 ms per token,    40.23 tokens per second)";
  assert.deepEqual(parseLlamaLine(real + "\r\r"), { gen: 63, ms: 1541.33, task: 0 }, "Windows line endings");
  for (const forged of [
    `srv  log_server_r: request: {"messages":[{"content":"slot print_timing: id 0 | task 1 |        eval time = 1.00 ms / 99999999 tokens (x"}]}`,
    `user said: [61447] 0.1.1.1 I slot print_timing: id  0 | task 0 |        eval time = 1.00 ms / 5000 tokens (`,
    `[61447] 0.37.951.623 I slot print_timing: id  0 | task 0 |        eval time =    0.01 ms /    99999 tokens (`,      // 10 billion tok/s
    `[61447] 0.37.951.623 I slot print_timing: id  0 | task 0 | draft acceptance = 1.5 (  500 accepted /   54 generated), mean len =  2.30`,
    `[61447] 0.37.951.623 I slot      release: id  0 | task 0 | stop processing: n_tokens = 999999999999, truncated = 0`,
  ]) assert.equal(parseLlamaLine(forged), null, forged.slice(0, 60));
});

// ---------- brute force ----------

test("brute force: 10 wrong tokens lock the address out, even for the right token", { timeout: 60_000 }, async () => {
  const TOKEN = "a".repeat(32);
  const s = await startServer({ DASH_TOKEN: TOKEN });
  try {
    assert.equal((await request(s.port, "/api/live", { authorization: `Bearer ${TOKEN}` })).status, 200);
    for (let i = 0; i < 10; i++) assert.equal((await request(s.port, `/api/live?token=guess${i}`)).status, 401);
    const locked = await request(s.port, "/api/live", { authorization: `Bearer ${TOKEN}` });
    assert.equal(locked.status, 429);
    assert.equal(locked.headers["retry-after"], "900");
    assert.match(s.out(), /locked out for 15 minutes/);
    assert.ok(!s.out().includes(TOKEN), "the token never appears in the log");
  } finally { await s.stop(); }
});

test("a wrong token of the right length is still compared in constant time, and refused", { timeout: 60_000 }, async () => {
  const s = await startServer({ DASH_TOKEN: "b".repeat(32) });
  try {
    assert.equal((await request(s.port, `/api/live?token=${"b".repeat(31)}c`)).status, 401);
    assert.equal((await request(s.port, `/api/live?token=${"b".repeat(32)}`)).status, 302, "right token: cookie set, address bar cleaned");
  } finally { await s.stop(); }
});

// ---------- HTML / script injection through engine data ----------

const EVIL = `<img src=x onerror="document.title='pwned'">`;

function findBrowser() {
  const c = process.platform === "win32"
    ? ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Google/Chrome/Application/chrome.exe"]
    : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge"];
  return c.find((p) => fs.existsSync(p));
}

test("a malicious model name and arguments render as text, never as HTML", { timeout: 120_000, skip: !findBrowser() && "no Chromium-based browser" }, async () => {
  const engine = await mockServer({
    "/models": { data: [{ id: EVIL, status: { value: "loaded", args: ["--port", "1", "--alias", EVIL, `--chat-template`, `"><script>document.title='pwned'</script>`] } }] },
    "/slots": [{ id: 0, id_task: 1, is_processing: false, n_ctx: 4096, n_prompt_tokens: 10 }],
  });
  const s = await startServer({ DASH_LLAMA_URL: engine.url }, []);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), "wattllama-browser-"));
  try {
    await new Promise((r) => setTimeout(r, 4000));
    const dom = execFileSync(findBrowser(), ["--headless=new", "--disable-gpu", `--user-data-dir=${prof}`, "--virtual-time-budget=8000", "--dump-dom",
      `http://127.0.0.1:${s.port}/`], { encoding: "utf8", timeout: 90_000, stdio: ["ignore", "pipe", "ignore"] });
    assert.ok(dom.includes("&lt;img src=x onerror="), "the name is shown, escaped");
    assert.ok(!/<img src="x"/i.test(dom), "no image element was created from it");
    assert.ok(!/<title>pwned/i.test(dom), "no script ran");
    assert.ok(!dom.includes("<script>document.title"), "no script element from the arguments");
  } finally { engine.close(); await s.stop(); fs.rmSync(prof, { recursive: true, force: true }); }
});

// ---------- alert messages ----------

test("alert messages cannot ping anyone", () => {
  const ev = { ts: 0, kind: "busy", level: "warn", title: "<!channel> @everyone <@U123>", message: "x" };
  assert.deepEqual(JSON.parse(webhookRequest({ format: "discord" }, ev).body).allowed_mentions, { parse: [] });
  const slack = JSON.parse(webhookRequest({ format: "slack" }, ev).body).text;
  assert.ok(!slack.includes("<!channel>") && !slack.includes("<@U123>"));
  assert.ok(slack.includes("&lt;!channel&gt;"));
});
