// The Linux power-limit helper (platform/power-limit.sh) against a fake nvidia-smi.
import nodeTest from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const test = process.platform === "linux" ? nodeTest : (name, ...rest) => nodeTest(name, { skip: "Linux only" }, rest.at(-1));
const HELPER = fileURLToPath(new URL("../platform/power-limit.sh", import.meta.url));

// A fake nvidia-smi: reports default 200 W, min 100 W, max 250 W and records what it was asked.
function fake() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wattllama-pl-"));
  const bin = path.join(dir, "nvidia-smi"), log = path.join(dir, "calls");
  fs.writeFileSync(bin, `#!/bin/bash\necho "$*" >> "${log}"\ncase "$*" in *--query-gpu*) echo "200.00, 100.00, 250.00" ;; esac\n`, { mode: 0o755 });
  return { bin, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : []), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const run = (f, args, flag) => spawnSync("bash", [HELPER, ...args], { env: { ...process.env, WATTLLAMA_NVSMI: f.bin, WATTLLAMA_ABOVE_FLAG: flag || "/nonexistent" }, encoding: "utf8" });

test("sets a limit between 60 % of the default and the default", () => {
  const f = fake();
  try {
    assert.equal(run(f, ["0", "150"]).status, 0);
    assert.equal(f.calls().at(-1), "-i 0 -pl 150");
    assert.equal(run(f, ["0", "120"]).status, 0, "the floor itself");
    assert.equal(run(f, ["0", "200"]).status, 0, "the default itself");
  } finally { f.cleanup(); }
});

test("above the default only when root allowed it (a weak PSU could switch the PC off)", () => {
  const f = fake();
  try {
    const r = run(f, ["0", "250"]);
    assert.equal(r.status, 3);
    assert.match(r.stderr, /limit must be 120-200 W/);
    const flag = f.bin + ".above";
    fs.writeFileSync(flag, "");
    assert.equal(run(f, ["0", "250"], flag).status, 0, "allowed: up to the driver maximum");
    assert.equal(run(f, ["0", "251"], flag).status, 3, "never above the maximum");
  } finally { f.cleanup(); }
});

test("refuses limits outside the safe range", () => {
  const f = fake();
  try {
    for (const w of ["119", "100", "0", "201", "251", "9999"]) {
      const r = run(f, ["0", w]);
      assert.equal(r.status, 3, w);
      assert.match(r.stderr, /limit must be 120-200 W/);
    }
    assert.ok(!f.calls().some((c) => c.includes("-pl")), "nvidia-smi was never asked to set anything");
  } finally { f.cleanup(); }
});

test("only whole numbers, exactly two arguments: no options or commands get through", () => {
  const f = fake();
  try {
    for (const args of [["0"], ["0", "150", "x"], ["0", "150; rm -rf /"], ["0;id", "150"], ["-1", "150"], ["0", "-pl"],
      ["0", "1.5e2"], ["0", "$(id)"], ["0", " 150"], ["00000", "150"], ["0", "150\nid"]]) {
      assert.equal(run(f, args).status, 2, JSON.stringify(args));
    }
    assert.deepEqual(f.calls(), [], "nvidia-smi was never run");
  } finally { f.cleanup(); }
});
