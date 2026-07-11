import fs from "node:fs/promises";
import path from "node:path";
import { PDFDocument } from "pdf-lib";

export async function buildKindleVolumes({ sourcePdfs, destinationDir, baseName, maxBytes, mergeVerticalPages = true }) {
  await fs.mkdir(destinationDir, { recursive: true });
  if (sourcePdfs.length === 0) throw new Error("No PDF pages were produced");

  // Render the complete selection first.  Source PDF sizes are only an
  // estimate and previously caused needless splitting even when the finished
  // combined PDF fitted into the Kindle limit.  If it really is too large,
  // split recursively at chapter boundaries.
  const volumes = await renderWithinLimit(sourcePdfs, maxBytes, { mergeVerticalPages });
  if (volumes.length === 0) throw new Error("No PDF pages were produced");

  const output = [];
  for (let index = 0; index < volumes.length; index += 1) {
    const fileName = buildVolumeFileName(baseName, volumes[index].sources, index, volumes.length);
    const filePath = path.join(destinationDir, fileName);
    await fs.writeFile(filePath, volumes[index].bytes);
    output.push({
      fileName,
      filePath,
      size: volumes[index].bytes.length,
      oversize: Boolean(volumes[index].oversize),
      sources: volumes[index].sources.map((source) => source.name)
    });
  }
  return output;
}

function buildVolumeFileName(baseName, sources, index, count) {
  const chapterTitles = [...new Set(sources.map((source) => source.chapterTitle).filter(Boolean))];
  const chapterRange = chapterTitles.length === 0
    ? ""
    : chapterTitles.length === 1
      ? ` ${chapterTitles[0]}`
      : ` ${chapterTitles[0]}-${chapterTitles.at(-1)}`;
  const suffix = count > 1
    ? `__part_${String(index + 1).padStart(2, "0")}_of_${String(count).padStart(2, "0")}`
    : "";
  return `${sanitize(`${baseName}${chapterRange}`)}${suffix}.pdf`;
}

async function renderWithinLimit(sources, maxBytes, options) {
  const bytes = await mergePdfSources(sources, options);
  if (bytes.length <= maxBytes) return [{ sources, bytes }];
  if (sources.length === 1) return [{ sources, bytes, oversize: true }];

  const splitAt = await balancedSplit(sources);
  return [
    ...await renderWithinLimit(sources.slice(0, splitAt), maxBytes, options),
    ...await renderWithinLimit(sources.slice(splitAt), maxBytes, options)
  ];
}

async function balancedSplit(sources) {
  const total = await Promise.all(sources.map(sourceSize));
  const half = total.reduce((sum, size) => sum + size, 0) / 2;
  let accumulated = 0;
  for (let index = 0; index < total.length - 1; index += 1) {
    accumulated += total[index];
    if (accumulated >= half) return index + 1;
  }
  return Math.floor(sources.length / 2);
}

async function sourceSize(source) {
  if (source.bytes) return source.bytes.length;
  return (await fs.stat(source.filePath)).size;
}

export async function mergePdfBuffers(buffers, { mergeVerticalPages = false } = {}) {
  const target = await PDFDocument.create();
  let pendingVertical = null;

  async function flushPendingVertical() {
    if (!pendingVertical) return;
    await addSingleVerticalSpread(target, pendingVertical);
    pendingVertical = null;
  }

  for (const bytes of buffers) {
    const source = await PDFDocument.load(bytes, { ignoreEncryption: true });
    for (const index of source.getPageIndices()) {
      const page = source.getPage(index);
      const { width, height } = page.getSize();
      if (mergeVerticalPages && width <= height) {
        if (pendingVertical) {
          await addVerticalPairSpread(target, pendingVertical, { page, width, height });
          pendingVertical = null;
        } else {
          pendingVertical = { page, width, height };
        }
        continue;
      }
      await flushPendingVertical();
      const [copied] = await target.copyPages(source, [index]);
      target.addPage(copied);
    }
  }
  await flushPendingVertical();
  return Buffer.from(await target.save({ useObjectStreams: true }));
}

async function addSingleVerticalSpread(target, item) {
  const embedded = await embedPageOrNull(target, item.page);
  const spread = target.addPage([item.width * 2, item.height]);
  if (embedded) {
    spread.drawPage(embedded, { x: item.width, y: 0, width: item.width, height: item.height });
  }
}

async function addVerticalPairSpread(target, first, second) {
  const pageWidth = first.width + second.width;
  const pageHeight = Math.max(first.height, second.height);
  const embeddedFirst = await embedPageOrNull(target, first.page);
  const embeddedSecond = await embedPageOrNull(target, second.page);
  const spread = target.addPage([pageWidth, pageHeight]);
  // Manga is read right-to-left: the earlier page belongs on the right.
  if (embeddedSecond) {
    spread.drawPage(embeddedSecond, {
      x: 0,
      y: (pageHeight - second.height) / 2,
      width: second.width,
      height: second.height
    });
  }
  if (embeddedFirst) {
    spread.drawPage(embeddedFirst, {
      x: second.width,
      y: (pageHeight - first.height) / 2,
      width: first.width,
      height: first.height
    });
  }
}

async function embedPageOrNull(target, page) {
  try {
    return await target.embedPage(page);
  } catch (error) {
    if (String(error?.message || error).includes("missing Contents")) return null;
    throw error;
  }
}

async function mergePdfSources(sources, options) {
  const buffers = [];
  for (const source of sources) {
    buffers.push(source.bytes || await fs.readFile(source.filePath));
  }
  return mergePdfBuffers(buffers, options);
}

function sanitize(value) {
  return String(value || "manga")
    .replace(/[<>:"/\\|?*]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 150) || "manga";
}
