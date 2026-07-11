export function nextKindleUploadRange(totalSize, receivedBytes) {
  const chunkSize = 8 * 1024 * 1024;
  const start = Math.max(0, Math.min(Number(receivedBytes) || 0, totalSize));
  return {
    start,
    end: Math.min(start + chunkSize, totalSize),
    percent: totalSize > 0
      ? Math.floor((start / totalSize) * 100)
      : 0
  };
}

export function acceptedKindleUploadProgress(value, totalSize) {
  const progress = Number(value);
  return Number.isSafeInteger(progress) &&
    progress >= 0 &&
    progress <= totalSize
    ? progress
    : null;
}
