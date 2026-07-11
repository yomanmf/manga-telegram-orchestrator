export function normalizeKindlePdfFileName(
  value,
  maxLength = 180
) {
  const suffix = ".pdf";
  const safeMaxLength = Math.max(
    suffix.length + 1,
    Number(maxLength) || 180
  );
  const cleaned = String(value || "document.pdf")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  const baseName = cleaned
    .replace(/\.pdf$/i, "")
    .slice(0, safeMaxLength - suffix.length)
    .trim() || "document";

  return baseName + suffix;
}
