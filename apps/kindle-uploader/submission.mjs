export function evaluateSubmissionEvidence(current, baseline) {
  const newFailure = firstNewEvidence(
    current?.failureRows,
    baseline?.failureRows
  );
  if (newFailure) {
    return { state: "failed", message: newFailure };
  }

  const readyBefore = baseline?.readyRows || [];
  const readyNow = current?.readyRows || [];
  if (readyBefore.length > 0 && readyNow.length === 0) {
    return {
      state: "acknowledged",
      evidence: {
        status: "submitted",
        row: "Amazon cleared Ready to send after Send"
      }
    };
  }

  return { state: "pending" };
}

export function firstNewEvidence(current = [], baseline = []) {
  const previous = new Map();
  for (const item of baseline || []) {
    previous.set(item, (previous.get(item) || 0) + 1);
  }

  for (const item of current || []) {
    const count = previous.get(item) || 0;
    if (count === 0) return item;
    previous.set(item, count - 1);
  }

  return "";
}

export function normalizeLoadedJob(job) {
  if (job.status === "processing") {
    return { ...job, status: "queued" };
  }
  if (job.status === "verifying") {
    return {
      ...job,
      status: "queued",
      resumeSubmission: Boolean(job.submittedAt)
    };
  }
  return job;
}
