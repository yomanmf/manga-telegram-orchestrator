import fs from "node:fs/promises";
import path from "node:path";
import { PDFDocument } from "pdf-lib";

export async function buildKindleVolumes({ sourcePdfs, destinationDir, baseName, maxBytes }) {
  await fs.mkdir(destinationDir, { recursive: true });
  if (sourcePdfs.length === 0) throw new Error("No PDF pages were produced");

  // Render the complete selection first.  Source PDF sizes are only an
  // estimate and previously caused needless splitting even when the finished
  // combined PDF fitted into the Kindle limit.  If it really is too large,
  // split recursively at chapter boundaries.
  const volumes = await renderWithinLimit(sourcePdfs, maxBytes);
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

async function renderWithinLimit(sources, maxBytes) {
  const bytes = await mergePdfSources(sources);
  if (bytes.length <= maxBytes) return [{ sources, bytes }];
  if (sources.length === 1) return [{ sources, bytes, oversize: true }];

  const splitAt = await balancedSplit(sources);
  return [
    ...await renderWithinLimit(sources.slice(0, splitAt), maxBytes),
    ...await renderWithinLimit(sources.slice(splitAt), maxBytes)
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

export async function mergePdfBuffers(buffers) {
  const target = await PDFDocument.create();
  for (const bytes of buffers) {
    const source = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const pages = await target.copyPages(source, source.getPageIndices());
    for (const page of pages) target.addPage(page);
  }
  return Buffer.from(await target.save({ useObjectStreams: true }));
}

async function mergePdfSources(sources) {
  const buffers = [];
  for (const source of sources) {
    buffers.push(source.bytes || await fs.readFile(source.filePath));
  }
  return mergePdfBuffers(buffers);
}

function sanitize(value) {
  return String(value || "manga")
    .replace(/[<>:"/\\|?*]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 150) || "manga";
}
