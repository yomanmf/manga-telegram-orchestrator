import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_RESUMABLE_CHUNK_SIZE,
  validateResumableChunk
} from "./upload-progress.mjs";

test("accepts the next resumable upload chunk", () => {
  assert.deepEqual(validateResumableChunk({
    offset: MAX_RESUMABLE_CHUNK_SIZE,
    receivedBytes: MAX_RESUMABLE_CHUNK_SIZE,
    totalSize: MAX_RESUMABLE_CHUNK_SIZE * 3,
    contentLength: MAX_RESUMABLE_CHUNK_SIZE
  }), { ok: true, finalizeOnly: false });
});

test("returns the server offset after a partial or repeated chunk", () => {
  assert.deepEqual(validateResumableChunk({
    offset: 0,
    receivedBytes: 1024,
    totalSize: 4096,
    contentLength: 2048
  }), {
    ok: false,
    status: 409,
    error: "Upload offset mismatch",
    receivedBytes: 1024
  });
});

test("allows an empty finalization request after all bytes arrived", () => {
  assert.deepEqual(validateResumableChunk({
    offset: 4096,
    receivedBytes: 4096,
    totalSize: 4096,
    contentLength: 0
  }), { ok: true, finalizeOnly: true });
});

test("rejects chunks larger than the resumable limit", () => {
  assert.equal(validateResumableChunk({
    offset: 0,
    receivedBytes: 0,
    totalSize: MAX_RESUMABLE_CHUNK_SIZE * 2,
    contentLength: MAX_RESUMABLE_CHUNK_SIZE + 1
  }).status, 413);
});
