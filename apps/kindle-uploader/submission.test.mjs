import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluateSubmissionEvidence,
  normalizeLoadedJob
} from "./submission.mjs";
import { isChromiumProfileLockError } from "./chromium-profile.mjs";

test("accepts a submission after Amazon clears the ready row", () => {
  assert.deepEqual(evaluateSubmissionEvidence(
    { readyRows: [], failureRows: [] },
    { readyRows: ["manga.pdf Ready to send"], failureRows: [] }
  ), {
    state: "acknowledged",
    evidence: {
      status: "submitted",
      row: "Amazon cleared Ready to send after Send"
    }
  });
});

test("does not accept a transient unchanged ready row", () => {
  assert.deepEqual(evaluateSubmissionEvidence(
    { readyRows: ["manga.pdf Ready to send"], failureRows: [] },
    { readyRows: ["manga.pdf Ready to send"], failureRows: [] }
  ), { state: "pending" });
});

test("reports a new Amazon failure before accepting submission", () => {
  assert.deepEqual(evaluateSubmissionEvidence(
    { readyRows: [], failureRows: ["manga.pdf could not be sent"] },
    { readyRows: ["manga.pdf Ready to send"], failureRows: [] }
  ), { state: "failed", message: "manga.pdf could not be sent" });
});

test("resumes verification for a submitted job without uploading it again", () => {
  assert.deepEqual(normalizeLoadedJob({
    id: "job-1",
    status: "verifying",
    submittedAt: "2026-07-11T20:09:28.756Z"
  }), {
    id: "job-1",
    status: "queued",
    submittedAt: "2026-07-11T20:09:28.756Z",
    resumeVerification: false
  });
});

test("keeps a legacy queued submission from being uploaded again", () => {
  assert.deepEqual(normalizeLoadedJob({
    id: "job-2",
    status: "queued",
    submittedAt: "2026-07-11T20:09:28.756Z",
    sentAt: null
  }), {
    id: "job-2",
    status: "queued",
    submittedAt: "2026-07-11T20:09:28.756Z",
    sentAt: null,
    resumeVerification: true
  });
});

test("recognizes a stale Chromium profile lock", () => {
  assert.equal(isChromiumProfileLockError(
    new Error("process_singleton_posix: The profile appears to be in use")
  ), true);
  assert.equal(isChromiumProfileLockError(new Error("Amazon session expired")), false);
});
