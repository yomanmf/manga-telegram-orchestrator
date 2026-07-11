import test from "node:test";
import assert from "node:assert/strict";

import {
  acceptedKindleUploadProgress,
  nextKindleUploadRange
} from "./kindle-upload-contract.mjs";

test("splits a large Kindle PDF into 8 MiB upload ranges", () => {
  assert.deepEqual(nextKindleUploadRange(20 * 1024 * 1024, 8 * 1024 * 1024), {
    start: 8 * 1024 * 1024,
    end: 16 * 1024 * 1024,
    percent: 40
  });
});

test("uses a short final Kindle upload range", () => {
  assert.deepEqual(nextKindleUploadRange(10, 8), {
    start: 8,
    end: 10,
    percent: 80
  });
});

test("rejects invalid server upload progress", () => {
  assert.equal(acceptedKindleUploadProgress(11, 10), null);
  assert.equal(acceptedKindleUploadProgress("bad", 10), null);
  assert.equal(acceptedKindleUploadProgress(8, 10), 8);
});
