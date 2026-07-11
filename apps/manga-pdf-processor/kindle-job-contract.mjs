export function classifyKindleSentJob(job) {
  const amazonStatus = String(job?.amazonStatus || "");

  if (amazonStatus === "in_library") {
    return { accepted: true, confirmation: "in_library" };
  }

  if (amazonStatus === "submitted") {
    return { accepted: true, confirmation: "submitted" };
  }

  return {
    accepted: false,
    confirmation: amazonStatus || "missing"
  };
}
