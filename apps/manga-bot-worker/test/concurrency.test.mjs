import assert from "node:assert/strict";
import test from "node:test";

import {
  boundedInteger,
  mapWithConcurrency
} from "../src/concurrency.mjs";

test("boundedInteger rejects unsafe concurrency values", () => {
  assert.equal(boundedInteger("2", 1), 2);
  assert.equal(boundedInteger("0", 1), 1);
  assert.equal(boundedInteger("many", 1), 1);
  assert.equal(boundedInteger("17", 1), 1);
});

test("worker pool limits concurrency and preserves source order", async () => {
  let active = 0;
  let peak = 0;
  const values = await mapWithConcurrency([20, 1, 10, 2], 2, async (delay, index) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, delay));
    active -= 1;
    return index;
  });

  assert.deepEqual(values, [0, 1, 2, 3]);
  assert.equal(peak, 2);
});
