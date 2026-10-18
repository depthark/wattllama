// The Linux RAPL root helper (platform/rapl-helper.sh) against fake powercap counters.
import nodeTest from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const test = process.platform === "linux" ? nodeTest : (name, ...rest) => nodeTest(name, { skip: "Linux only" }, rest.at(-1));
const HELPER = fileURLToPath(new URL("../platform/rapl-helper.sh", import.meta.url));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeCap() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wattllama-cap-"));
  const z = (name, kind, e, max) => {
    fs.mkdirSync(path.join(dir, name));
    fs.writeFileSync(path.join(dir, name, "name"), `${kind}\n`);
    fs.writeFileSync(path.join(dir, name, "energy_uj"), `${e}\n`);
    if (max) fs.writeFileSync(path.join(dir, name, "max_energy_range_uj"), `${max}\n`);
  };
  z("intel-rapl:0", "package-0", 1_000_000, 262143328850);
  z("intel-rapl:0:0", "core", 5);
  z("intel-rapl:0:2", "dram", 500, 65532610987);
  const set = (name, e) => fs.writeFileSync(path.join(dir, name, "energy_uj"), `${e}\n`);
  return { dir, set, out: path.join(dir, "rapl"), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function start(cap) {
  return spawn("bash", [HELPER], { env: { ...process.env, WATTLLAMA_POWERCAP: cap.dir, WATTLLAMA_RAPL_OUT: cap.out, WATTLLAMA_RAPL_INTERVAL: "1" } });
}
const readOut = (cap) => fs.readFileSync(cap.out, "utf8").trim().split(" ").map(Number);
async function nextWrite(cap, after = 0) {
  for (let i = 0; i < 60; i++) {
    try { const st = fs.statSync(cap.out); if (st.mtimeMs > after) return readOut(cap); } catch {}
    await wait(50);
  }
  throw new Error("no output from the helper");
}

test("helper: watts per window, each window on its own, package and dram separately", async () => {
  const cap = fakeCap(), p = start(cap);
  try {
    await wait(300);
    cap.set("intel-rapl:0", 11_000_000);           // +10 J
    cap.set("intel-rapl:0:2", 1_000_500);          // +1 J
    const [w1, d1, ts] = await nextWrite(cap);
    assert.ok(w1 > 9 && w1 <= 10.1, `~10 W in the first second (${w1})`);
    assert.ok(d1 > 0.8 && d1 <= 1.01, `~1 W dram (${d1})`);
    assert.ok(Math.abs(ts - Date.now() / 1000) < 5, "epoch seconds");
    const [w2] = await nextWrite(cap, fs.statSync(cap.out).mtimeMs);
    assert.equal(w2, 0, "no new energy -> 0 W (the counter state carries over between windows)");
    assert.ok((fs.statSync(cap.out).mode & 0o044) === 0o044, "readable by WattLlama's user");
  } finally { p.kill(); cap.cleanup(); }
});

test("helper: counter wrap-around", async () => {
  const cap = fakeCap();
  cap.set("intel-rapl:0", 262_143_000_000);
  const p = start(cap);
  try {
    await wait(300);
    cap.set("intel-rapl:0", 671_150);               // wrapped: +1 J in total
    const [w] = await nextWrite(cap);
    assert.ok(w > 0.8 && w <= 1.01, `~1 W across the wrap (${w})`);
  } finally { p.kill(); cap.cleanup(); }
});

test("helper: no RAPL counters -> exits 0 without output", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wattllama-cap-"));
  try {
    const code = await new Promise((ok) => spawn("bash", [HELPER], { env: { ...process.env, WATTLLAMA_POWERCAP: dir, WATTLLAMA_RAPL_OUT: path.join(dir, "rapl") } }).on("exit", ok));
    assert.equal(code, 0);
    assert.ok(!fs.existsSync(path.join(dir, "rapl")));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
