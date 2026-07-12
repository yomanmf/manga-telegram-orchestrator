import assert from "node:assert/strict";
import { test } from "node:test";

import { canRecycleIdleUploader } from "./idle-recycle.mjs";

const idleState = {
  recycleEligible: true,
  shuttingDown: false,
  browserRunning: false,
  browserStarting: false,
  browserClosing: false,
  displayRuntimeRunning: false,
  vncRunning: false,
  queueRunning: false,
  hasPendingQueueJob: false,
  activeVncConnections: 0,
  uploadTicketCount: 0,
  connectTokenCount: 0
};

test("recycles only after a completed browser cycle becomes fully idle", () => {
  assert.equal(canRecycleIdleUploader(idleState), true);
  assert.equal(canRecycleIdleUploader({
    ...idleState,
    recycleEligible: false
  }), false);
});

test("does not recycle while uploads, queue work, or VNC access may be active", () => {
  for (const blockedState of [
    { uploadTicketCount: 1 },
    { queueRunning: true },
    { hasPendingQueueJob: true },
    { activeVncConnections: 1 },
    { connectTokenCount: 1 },
    { browserRunning: true },
    { displayRuntimeRunning: true },
    { vncRunning: true }
  ]) {
    assert.equal(canRecycleIdleUploader({
      ...idleState,
      ...blockedState
    }), false);
  }
});
