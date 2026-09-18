import test from "node:test";
import assert from "node:assert/strict";
import { withDeadline } from "./deadline.mjs";

test("bounds a hung browser operation and permits the next attempt", async () => {
  await assert.rejects(withDeadline(() => new Promise(() => {}), 10, "Amazon session check"), /Amazon session check timed out/);
  assert.equal(await withDeadline(() => true, 100, "session"), true);
  await assert.rejects(withDeadline(() => { throw new Error("closed"); }, 100, "session"), /closed/);
});
