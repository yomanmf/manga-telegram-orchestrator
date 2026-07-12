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

export function evaluateBatchPageText(bodyText, filenames = []) {
  const normalize = (value) => String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  const text = normalize(bodyText);
  const expected = filenames.map(normalize).filter(Boolean);
  const presentFilenames = expected.filter((filename) =>
    text.includes(filename)
  );
  const missingFilenames = expected.filter((filename) =>
    !text.includes(filename)
  );
  const allPresent = expected.length > 0 && missingFilenames.length === 0;

  return {
    ready: allPresent && /ready to send/i.test(text),
    inLibrary: allPresent && /\bin library\b/i.test(text),
    presentFilenames,
    missingFilenames
  };
}

export function normalizeLoadedJob(job) {
  if (
    job.status === "queued" &&
    job.submittedAt &&
    !job.sentAt
  ) {
    return { ...job, resumeVerification: true };
  }
  if (job.status === "processing") {
    return { ...job, status: "queued" };
  }
  if (job.status === "verifying") {
    return {
      ...job,
      status: "queued",
      resumeVerification: Boolean(job.submittedAt && job.verificationBaseline)
    };
  }
  return job;
}
