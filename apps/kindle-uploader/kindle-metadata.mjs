export const KINDLE_DOCUMENT_AUTHOR = "Manga";

export function kindleDocumentAuthor(author) {
  const normalized = String(author || "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim()
    .slice(0, 100);
  return normalized || KINDLE_DOCUMENT_AUTHOR;
}

export function kindleDocumentTitle(filename) {
  return String(filename || "")
    .replace(/\.(?:pdf|epub)$/i, "")
    .slice(0, 200);
}
