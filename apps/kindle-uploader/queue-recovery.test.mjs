import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { withDeadline } from "./deadline.mjs";

const source = await fs.readFile(new URL("./server.mjs", import.meta.url), "utf8");
const queueCode = source.slice(source.indexOf("async function runQueue()"), source.indexOf("async function markJobWaitingForAuth"));

test("a hung session exhausts bounded retries and releases the queue for the next book", async () => {
  const queue = [
    { id: "old", status: "queued", attempts: 1, batchId: "old-batch", batchStartedAt: "now" },
    { id: "new", status: "queued", attempts: 0, batchId: "new-batch", batchStartedAt: "now" }
  ];
  let checks = 0;
  const context = {
    queue, queueRunning: false, kindleConnected: true,
    scheduleBrowserCloseIfIdle() {},
    async checkKindleSession() {
      checks += 1;
      if (checks <= 2) return withDeadline(() => new Promise(() => {}), 5, "Amazon session check");
      return true;
    },
    async recordQueueJobFailure(job, error) {
      job.error = error.message;
      job.status = job.attempts >= 3 ? "failed" : "queued";
    },
    async processQueueBatch(id) { queue.find((job) => job.batchId === id).status = "sent"; }
  };
  const run = vm.runInNewContext(`${queueCode}; runQueue`, context);
  await run();
  assert.equal(queue[0].status, "failed");
  assert.equal(queue[0].attempts, 3);
  assert.equal(context.queueRunning, false);
  await run();
  assert.equal(queue[1].status, "sent");
});

test("an expired session marks every file in its batch as waiting for login", async () => {
  const queue = ["a", "b"].map((id) => ({ id, status: "queued", attempts: 0, batchId: "batch", batchStartedAt: "now" }));
  const context = {
    queue, queueRunning: false, kindleConnected: true,
    scheduleBrowserCloseIfIdle() {},
    async checkKindleSession() { return false; },
    async markJobWaitingForAuth(job) { job.status = "waiting_auth"; }
  };
  await vm.runInNewContext(`${queueCode}; runQueue`, context)();
  assert.ok(queue.every((job) => job.status === "waiting_auth"));
  assert.equal(context.queueRunning, false);
});
