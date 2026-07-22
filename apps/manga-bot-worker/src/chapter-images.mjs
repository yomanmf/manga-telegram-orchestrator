const MAX_CHAPTER_PAGES = 2_000;
const MAX_PAGE_BYTES = 50 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function matchesFormat(bytes, format) {
  if (format === "jpg") return bytes[0] === 0xff && bytes[1] === 0xd8;
  return bytes.length >= PNG_SIGNATURE.length &&
    bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
}

export async function extractChapterImages(zip) {
  const manifestEntry = zip.file("manifest.json");
  if (!manifestEntry) throw new Error("The manga processor returned no image manifest");

  let manifest;
  try {
    manifest = JSON.parse(await manifestEntry.async("string"));
  } catch {
    throw new Error("The manga processor returned an invalid image manifest");
  }

  if (
    manifest?.version !== 1 ||
    !Array.isArray(manifest.pages) ||
    manifest.pages.length === 0 ||
    manifest.pages.length > MAX_CHAPTER_PAGES
  ) {
    throw new Error("The manga processor returned an unsupported image manifest");
  }

  const seen = new Set();
  const pages = [];
  for (const page of manifest.pages) {
    const fileName = String(page?.fileName || "");
    const width = Number(page?.width);
    const height = Number(page?.height);
    const format = String(page?.format || "").toLowerCase();
    const expectedExtension = format === "jpg" ? "jpg" : format === "png" ? "png" : "";
    if (
      !expectedExtension ||
      !new RegExp(`^pages/page_[0-9]{4,}[.]${expectedExtension}$`, "i").test(fileName) ||
      seen.has(fileName) ||
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width <= 0 ||
      height <= 0
    ) {
      throw new Error("The manga processor returned invalid page metadata");
    }

    const entry = zip.file(fileName);
    if (!entry) throw new Error(`The manga processor omitted ${fileName}`);
    const bytes = Buffer.from(await entry.async("nodebuffer"));
    if (
      bytes.length === 0 ||
      bytes.length > MAX_PAGE_BYTES ||
      !matchesFormat(bytes, format)
    ) {
      throw new Error(`The manga processor returned an invalid ${fileName}`);
    }

    seen.add(fileName);
    pages.push({ fileName, width, height, format, bytes });
  }

  return pages;
}
