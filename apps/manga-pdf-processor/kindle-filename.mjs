export function normalizeKindleDocumentFileName(
  value,
  maxLength = 180
) {
  const input = String(value || "document.pdf");
  const suffix = /[.]epub$/i.test(input)
    ? ".epub"
    : ".pdf";
  const safeMaxLength = Math.max(
    suffix.length + 1,
    Number(maxLength) || 120
  );
  const cleaned = input
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  const baseName = cleaned
    .replace(/\.(?:pdf|epub)$/i, "")
    .slice(0, safeMaxLength - suffix.length)
    .trim() || "document";

  return baseName + suffix;
}

export function normalizeKindlePdfFileName(value, maxLength = 120) {
  return normalizeKindleDocumentFileName(
    String(value || "document.pdf")
      .replace(/[.]epub$/i, ".pdf"),
    maxLength
  );
}
