export function sanitizeFileName(name) {
  return (
    String(name)
      .replace(/[<>:"/\\|?*]/g, "_")
      .replace(/[\u0000-\u001F]/g, "_")
      .replace(/\\s+/g, " ")
      .trim()
      .slice(0, 120) || "file"
  );
}

export function getBaseFileName(fileName) {
  const cleanName =
    String(fileName).split(/[\\/]/).pop() || "file";
  const withoutExtension =
    cleanName.replace(/\.[^/.]+$/, "");
  return sanitizeFileName(
    withoutExtension || "file"
  );
}

export function assertValidSize(width, height, label) {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new Error(
      label + ": invalid page size " +
      width + "x" + height
    );
  }
}
