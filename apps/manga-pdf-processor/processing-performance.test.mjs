import assert from "node:assert/strict";
import test from "node:test";

import {
  boundedInteger,
  chunkItems,
  mapWithConcurrency
} from "./processing-performance.mjs";

test("boundedInteger accepts only configured integer values", () => {
  assert.equal(boundedInteger("6", 2, { min: 1, max: 16 }), 6);
  assert.equal(boundedInteger("0", 2, { min: 1, max: 16 }), 2);
  assert.equal(boundedInteger("17", 2, { min: 1, max: 16 }), 2);
  assert.equal(boundedInteger("1.5", 2, { min: 1, max: 16 }), 2);
});

test("chunkItems retains order without dropping items", () => {
  assert.deepEqual(
    chunkItems([1, 2, 3, 4, 5], 2),
    [[1, 2], [3, 4], [5]]
  );
});

test("mapWithConcurrency preserves order and caps active work", async () => {
  let active = 0;
  let peak = 0;
  const result = await mapWithConcurrency([30, 5, 20, 1], 2, async (delay, index) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, delay));
    active -= 1;
    return `item-${index}`;
  });

  assert.deepEqual(result, ["item-0", "item-1", "item-2", "item-3"]);
  assert.equal(peak, 2);
});

test("mapWithConcurrency stops scheduling new work after a failure", async () => {
  const started = [];
  await assert.rejects(
    mapWithConcurrency([0, 1, 2, 3, 4], 2, async (value) => {
      started.push(value);
      if (value === 1) throw new Error("failed");
      await new Promise((resolve) => setTimeout(resolve, 10));
      return value;
    }),
    /failed/
  );
  assert.deepEqual(started, [0, 1]);
});
