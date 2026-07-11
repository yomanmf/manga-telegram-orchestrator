import test from "node:test";
import assert from "node:assert/strict";

import { classifyKindleSentJob } from "./kindle-job-contract.mjs";

test("accepts a Kindle job confirmed in the Amazon library", () => {
  assert.deepEqual(
    classifyKindleSentJob({ status: "sent", amazonStatus: "in_library" }),
    { accepted: true, confirmation: "in_library" }
  );
});

test("accepts a Kindle submission acknowledged by Amazon", () => {
  assert.deepEqual(
    classifyKindleSentJob({ status: "sent", amazonStatus: "submitted" }),
    { accepted: true, confirmation: "submitted" }
  );
});

test("rejects an unconfirmed Kindle submission", () => {
  assert.deepEqual(
    classifyKindleSentJob({ status: "sent", amazonStatus: "submitted_unconfirmed" }),
    { accepted: false, confirmation: "submitted_unconfirmed" }
  );
});
