import test from "node:test";
import assert from "node:assert/strict";
import { powerRange } from "../power.mjs";

test("RTX 4070 (default = max = 200 W): 120-200 W", () => {
  assert.deepEqual(powerRange({ min: 100, def: 200, max: 200 }), { floor: 120, ceiling: 200 });
});

test("a card whose max is above its default: capped at the default unless allowed", () => {
  const rtx4090 = { min: 150, def: 450, max: 600 };
  assert.deepEqual(powerRange(rtx4090), { floor: 270, ceiling: 450 }, "never more than the default");
  assert.deepEqual(powerRange(rtx4090, true), { floor: 270, ceiling: 600 }, "only with DASH_POWER_LIMIT_ABOVE_DEFAULT=1");
});

test("the floor is never below the driver's minimum, and rounds up to 5 W", () => {
  assert.deepEqual(powerRange({ min: 150, def: 200, max: 200 }), { floor: 150, ceiling: 200 });
  assert.equal(powerRange({ min: 50, def: 220, max: 250 }).floor, 135);
  assert.equal(powerRange({ min: 50.4, def: 60, max: 60 }).floor, 51);
});

test("no limits reported or an empty range: no control", () => {
  assert.equal(powerRange({ min: null, def: 200, max: 200 }), null);
  assert.equal(powerRange({ min: 210, def: 200, max: 200 }), null, "min above default: nothing safe to offer");
});
