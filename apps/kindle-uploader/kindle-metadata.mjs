export const KINDLE_DOCUMENT_AUTHOR = "Manga";

export function kindleDocumentTitle(filename) {
  return String(filename || "")
    .replace(/\.(?:pdf|epub)$/i, "")
    .slice(0, 200);
}
