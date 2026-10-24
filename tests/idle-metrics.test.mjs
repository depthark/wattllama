// Energy above the idle baseline and the prefill/generation split (energy.mjs, used by server.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { aboveIdle, per1k, splitEnergy } from "../energy.mjs";

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} vs ${b}`);

test("aboveIdle subtracts idle power over the busy time", () => {
  // 48 Wh in 240 busy seconds at a 120 W idle: 120 * 240 / 3600 = 8 Wh of it is idle.
  near(aboveIdle(48, 240, 120), 40, "above idle");
  near(per1k(aboveIdle(48, 240, 120), 40_000), 1, "per 1k tokens");
});

test("aboveIdle is null while the baseline is unknown, and never negative", () => {
  assert.equal(aboveIdle(48, 240, null), null);
  assert.equal(per1k(aboveIdle(48, 240, null), 40_000), null);
  assert.equal(aboveIdle(1, 60, 120), 0, "1 Wh in a minute is below a 120 W idle");
});

test("per1k needs tokens: a classifier generates none", () => {
  assert.equal(per1k(5, 0), null);
  assert.equal(per1k(5, null), null);
});

test("splitEnergy divides by time share and uses the model's own token counts", () => {
  const s = splitEnergy(60, 40_000, 20_000, 8_000, 32_000);
  near(s.ppWh, 40, "prefill Wh");
  near(s.genWh, 20, "generation Wh");
  near(s.ppPer1k, 5, "prefill Wh / 1k prompt tokens");
  near(s.genPer1k, 0.625, "generation Wh / 1k generated tokens");
  // The parts add up to the whole, so neither can exceed the model's overall Wh / 1k.
  near(s.ppWh + s.genWh, 60, "sum");
});

test("splitEnergy without timings is null; a prefill-only model has no generation figure", () => {
  assert.equal(splitEnergy(60, 0, 0, 100, 100), null);
  assert.equal(splitEnergy(60, null, null, 100, 100), null);
  const c = splitEnergy(6, 5_000, 0, 500, 0);
  near(c.ppWh, 6, "all energy is prefill");
  assert.equal(c.genPer1k, null, "no generated tokens");
});
