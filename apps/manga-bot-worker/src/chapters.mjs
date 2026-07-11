import { normalizeChapterNumber } from "./command.mjs";

export function parseChapterLabel(label) {
  const value = String(label || "").trim();
  const match = value.match(/(?:chapter|глава|ch[.]?)\s*([\d]+(?:[.,]\d+)?)/i) ||
    value.match(/\b([\d]+(?:[.,]\d+)?)\b/);
  return match ? match[1].replace(",", ".") : null;
}

export function compareChapterNumbers(a, b) {
  const [aMajor, aMinor = ""] = String(a).split(".");
  const [bMajor, bMinor = ""] = String(b).split(".");
  const major = Number(aMajor) - Number(bMajor);
  if (major !== 0) return major;
  const width = Math.max(aMinor.length, bMinor.length);
  return Number(aMinor.padEnd(width, "0") || 0) - Number(bMinor.padEnd(width, "0") || 0);
}

export function selectChapterRange(chapters, from) {
  const start = normalizeChapterNumber(from);
  const selected = chapters
    .map((chapter) => ({ ...chapter, number: parseChapterLabel(chapter.title) }))
    .filter((chapter) => chapter.number && compareChapterNumbers(chapter.number, start) >= 0);

  if (selected.length === 0) {
    throw new Error(`Главы ${start} и новее не найдены`);
  }
  return selected;
}

