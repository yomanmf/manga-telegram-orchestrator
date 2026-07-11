import fs from "node:fs/promises";
import path from "node:path";
import { PDFDocument } from "pdf-lib";

export async function buildKindleVolumes({ sourcePdfs, destinationDir, baseName, maxBytes }) {
  await fs.mkdir(destinationDir, { recursive: true });
  const volumes = [];
  let current = [];
  let currentBytes = null;

  for (const source of sourcePdfs) {
    const candidate = [...current, source];
    const candidateBytes = await mergePdfSources(candidate);

    if (candidateBytes.length > maxBytes && current.length > 0) {
      volumes.push({ sources: current, bytes: currentBytes });
      current = [source];
      currentBytes = await mergePdfSources([source]);
    } else {
      current = candidate;
      currentBytes = candidateBytes;
    }

    if (currentBytes.length > maxBytes) {
      volumes.push({ sources: current, bytes: currentBytes, oversize: true });
      current = [];
      currentBytes = null;
    }
  }

  if (current.length > 0 && currentBytes) volumes.push({ sources: current, bytes: currentBytes });
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
