import fs from "node:fs/promises";
import path from "node:path";
import { PDFDocument } from "pdf-lib";

export async function buildKindleVolumes({ sourcePdfs, destinationDir, baseName, maxBytes }) {
  await fs.mkdir(destinationDir, { recursive: true });
  if (sourcePdfs.length === 0) throw new Error("No PDF pages were produced");

  // PDF-lib rewrites the whole document on every save.  Re-merging the growing
  // prefix for each chapter is quadratic and becomes painfully slow for a long
  // manga.  Use source file sizes only as a conservative first grouping, then
  // validate each rendered group and split only groups that really exceed the
  // Kindle limit.
  const groups = await groupSources(sourcePdfs, Math.floor(maxBytes * 0.8));
  const volumes = [];
  for (const group of groups) volumes.push(...await renderWithinLimit(group, maxBytes));
  if (volumes.length === 0) throw new Error("No PDF pages were produced");

  const output = [];
  for (let index = 0; index < volumes.length; index += 1) {
    const fileName = `${sanitize(baseName)}__part_${String(index + 1).padStart(2, "0")}_of_${String(volumes.length).padStart(2, "0")}.pdf`;
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

async function groupSources(sources, targetBytes) {
  const groups = [];
  let group = [];
  let size = 0;
  for (const source of sources) {
    const sourceBytes = await sourceSize(source);
    if (group.length > 0 && size + sourceBytes > targetBytes) {
      groups.push(group);
      group = [];
      size = 0;
    }
    group.push(source);
    size += sourceBytes;
  }
  if (group.length > 0) groups.push(group);
  return groups;
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
