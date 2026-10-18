// Starts the real server (--demo, in-memory history) and checks the HTTP security rules,
// the main endpoints and AMD / Intel GPUs read from a fake LibreHardwareMonitor.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mockServer } from "./helpers.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sensor = (Text, Value, SensorId) => ({ Text, Value, SensorId, Children: [] });
const LHM = { Text: "Sensor", Children: [{ Text: "PC", Children: [
  { Text: "AMD Radeon RX 7800 XT", Children: [
    { Text: "Temperatures", Children: [sensor("GPU Core", "51.0 °C", "/gpu-amd/0/temperature/0"), sensor("GPU Hot Spot", "63.0 °C", "/gpu-amd/0/temperature/2")] },
    { Text: "Powers", Children: [sensor("GPU Core", "150.0 W", "/gpu-amd/0/power/0"), sensor("GPU Package", "212.5 W", "/gpu-amd/0/power/3")] },
    { Text: "Load", Children: [sensor("GPU Core", "97.0 %", "/gpu-amd/0/load/0")] },
    { Text: "Data", Children: [sensor("GPU Memory Used", "9120.0 MB", "/gpu-amd/0/smalldata/1"), sensor("GPU Memory Total", "16368.0 MB", "/gpu-amd/0/smalldata/2")] },
  ] },
  { Text: "AMD Radeon(TM) Graphics", Children: [{ Text: "Powers", Children: [sensor("GPU Core", "8.0 W", "/gpu-amd/1/power/0")] }] },
  { Text: "AMD Ryzen 7 7700X", Children: [{ Text: "Temperatures", Children: [sensor("Core (Tctl/Tdie)", "71.3 °C", "/amdcpu/0/temperature/2")] }] },
] }] };

const freePort = () => new Promise((ok) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });

function request(port, { method = "GET", path: p = "/", headers = {} } = {}) {
  return new Promise((ok, fail) => {
    const r = http.request({ host: "127.0.0.1", port, method, path: p, headers }, (res) => {
      let body = ""; res.on("data", (d) => body += d); res.on("end", () => ok({ status: res.statusCode, headers: res.headers, body }));
    });
    r.on("error", fail); r.end();
  });
}

test("server: security rules, endpoints, AMD GPU via LibreHardwareMonitor", { timeout: 60_000 }, async () => {
  const lhm = await mockServer({ "/data.json": LHM });
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wattllama-srv-"));
  const env = { ...process.env, DASH_PORT: String(port), DASH_HOST: "127.0.0.1", DASH_DATA_DIR: dataDir, DASH_LHM_URL: lhm.url,
    DASH_LLAMA_URL: "", DASH_OLLAMA_URL: "", DASH_LMSTUDIO_URL: "", DASH_TOKEN: "", DASH_TASKS: "", DASH_ALLOW_POWER_LIMIT: "0" };
  const srv = spawn(process.execPath, ["--no-warnings", path.join(ROOT, "server.mjs"), "--demo"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = ""; srv.stdout.on("data", (d) => out += d); srv.stderr.on("data", (d) => out += d);
  try {
    for (let i = 0; i < 50 && !out.includes("WattLlama on"); i++) await new Promise((r) => setTimeout(r, 200));
    assert.match(out, /WattLlama on/);

    // DNS rebinding: a foreign Host header is refused
    assert.equal((await request(port, { path: "/api/live", headers: { host: "evil.example:1234" } })).status, 403);
    // read-only
    assert.equal((await request(port, { method: "POST", path: "/api/live" })).status, 405);
    assert.equal((await request(port, { method: "DELETE", path: "/" })).status, 405);
    // no file paths from the URL
    assert.equal((await request(port, { path: "/../server.mjs" })).status, 404);
    assert.equal((await request(port, { path: "/%2e%2e/.env" })).status, 404);
    // control is off by default
    const pl = await request(port, { method: "POST", path: "/api/gpu/power-limit", headers: { origin: `http://127.0.0.1:${port}`, "x-wattllama": "1", "content-type": "application/json" } });
    assert.equal(pl.status, 403);

    const page = await request(port, { path: "/" });
    assert.equal(page.status, 200);
    assert.match(page.headers["content-security-policy"], /default-src 'none'/);
    assert.equal(page.headers["x-frame-options"], "DENY");

    for (const p of ["/api/summary", "/api/series?range=7d", "/api/runs", "/api/heatmap?days=14", "/api/efficiency", "/api/setup"]) {
      const r = await request(port, { path: p });
      assert.equal(r.status, 200, p);
      JSON.parse(r.body);
    }
    assert.equal(JSON.parse((await request(port, { path: "/api/series?range=x';drop" })).body).range, "24h");

    const csv = await request(port, { path: "/api/export.csv?data=runs&range=all" });
    assert.equal(csv.status, 200);
    assert.match(csv.headers["content-disposition"], /wattllama-runs-all\.csv/);
    const lines = csv.body.split(/\n/);
    assert.match(lines[0], /^time,start,end,model,/);
    assert.ok(lines.length > 10, "demo runs exported");
    const bad = await request(port, { path: "/api/export.csv?data=sqlite_master;--&range=x" });
    assert.match(bad.headers["content-disposition"], /wattllama-minutes-30d\.csv/);

    // LHM is polled every 5 s
    let live;
    for (let i = 0; i < 30; i++) {
      live = JSON.parse((await request(port, { path: "/api/live" })).body);
      if (live.gpus?.some((g) => g.source)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    const amd = live.gpus.find((g) => g.name === "AMD Radeon RX 7800 XT");
    assert.ok(amd, "discrete AMD GPU is listed");
    assert.equal(amd.power, 212.5);
    assert.equal(amd.temp, 51);
    assert.equal(amd.util, 97);
    assert.equal(amd.vramUsed, 9120);
    assert.equal(amd.limitMin, null, "no power-limit control for LHM GPUs");
    assert.ok(!live.gpus.some((g) => /Radeon\(TM\) Graphics/.test(g.name)), "integrated GPU is not counted twice");
    assert.equal(live.cpu === false || live.cpu?.temp == null || live.cpu.temp === 71.3, true);
  } finally {
    srv.kill(); lhm.close();
    await new Promise((r) => setTimeout(r, 300));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
