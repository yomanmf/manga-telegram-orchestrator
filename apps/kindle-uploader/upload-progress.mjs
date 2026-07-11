export const MAX_RESUMABLE_CHUNK_SIZE = 8 * 1024 * 1024;

export function validateResumableChunk({
  offset,
  receivedBytes,
  totalSize,
  contentLength
}) {
  const values = [offset, receivedBytes, totalSize, contentLength];
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    return { ok: false, status: 400, error: "Invalid upload range" };
  }

  if (offset !== receivedBytes) {
    return {
      ok: false,
      status: 409,
      error: "Upload offset mismatch",
      receivedBytes
    };
  }

  if (offset === totalSize && contentLength === 0) {
    return { ok: true, finalizeOnly: true };
  }

  if (contentLength <= 0) {
    return { ok: false, status: 400, error: "Upload chunk is empty" };
  }

  if (
    contentLength > MAX_RESUMABLE_CHUNK_SIZE ||
    offset + contentLength > totalSize
  ) {
    return { ok: false, status: 413, error: "Upload chunk is too large" };
  }

  return { ok: true, finalizeOnly: false };
}
