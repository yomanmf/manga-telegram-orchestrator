import fs from "node:fs/promises";
import path from "node:path";
import { PDFDocument } from "pdf-lib";

export async function buildKindleVolumes({ sourcePdfs, destinationDir, baseName, maxBytes, mergeVerticalPages = true }) {
  await fs.mkdir(destinationDir, { recursive: true });
  if (sourcePdfs.length === 0) throw new Error("No PDF pages were produced");

  const collector = createPdfCollector({ maxBytes, mergeVerticalPages });
  for (const source of sourcePdfs) await collector.add(source);
  const volumes = await collector.finish();

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

// The collector mirrors the browser implementation. In particular it holds
// only the final vertical page of each source PDF, so a cross-source RTL pair
// is made only when the next source starts with a vertical page and the pair
// fits in the current Kindle volume.
function createPdfCollector({ maxBytes, mergeVerticalPages }) {
  let currentPdf = null;
  let currentBytes = null;
  let currentHasPages = false;
  let currentSources = [];
  let pendingSinglePage = null;
  const volumes = [];

  async function newPdf() {
    currentPdf = await PDFDocument.create();
    currentBytes = null;
    currentHasPages = false;
    currentSources = [];
  }

  async function ensurePdf() {
    if (!currentPdf) await newPdf();
  }

  function assertPageSize(width, height, label) {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      throw new Error(`${label}: invalid page size ${width}x${height}`);
    }
  }

  function pageInfo(sourcePdf, page, pageIndex, source) {
    const { width, height } = page.getSize();
    assertPageSize(width, height, `${source.name} page ${pageIndex + 1}`);
    return {
      sourcePdf,
      source,
      sourceKey: source.chapterTitle || source.name,
      page,
      pageIndex,
      width,
      height,
      isVertical: width <= height,
      canBridgeWithoutCurrentPages: false
    };
  }

  function operationSources(operation) {
    const result = [operation.type === "single" ? operation.item.source : operation.first.source];
    if (operation.type === "pair" && !result.includes(operation.second.source)) result.push(operation.second.source);
    return result;
  }

  function rememberSources(operation) {
    for (const source of operationSources(operation)) {
      if (!currentSources.includes(source)) currentSources.push(source);
    }
  }

  async function addSinglePageSpread(targetPdf, item) {
    const embedded = await targetPdf.embedPage(item.page);
    const spread = targetPdf.addPage([item.width * 2, item.height]);
    spread.drawPage(embedded, { x: item.width, y: 0, width: item.width, height: item.height });
  }

  async function addPairSpread(targetPdf, first, second) {
    const pageWidth = first.width + second.width;
    const pageHeight = Math.max(first.height, second.height);
    assertPageSize(pageWidth, pageHeight, "Merged PDF page");
    const embeddedFirst = await targetPdf.embedPage(first.page);
    const embeddedSecond = await targetPdf.embedPage(second.page);
    const spread = targetPdf.addPage([pageWidth, pageHeight]);
    // Manga is read right-to-left: the earlier page is placed on the right.
    spread.drawPage(embeddedSecond, {
      x: 0,
      y: (pageHeight - second.height) / 2,
      width: second.width,
      height: second.height
    });
    spread.drawPage(embeddedFirst, {
      x: second.width,
      y: (pageHeight - first.height) / 2,
      width: first.width,
      height: first.height
    });
  }

  async function addOperation(targetPdf, operation) {
    if (operation.type === "single") {
      if (mergeVerticalPages && operation.item.isVertical) {
        await addSinglePageSpread(targetPdf, operation.item);
      } else {
        const [copied] = await targetPdf.copyPages(operation.item.sourcePdf, [operation.item.pageIndex]);
        targetPdf.addPage(copied);
      }
      return;
    }
    await addPairSpread(targetPdf, operation.first, operation.second);
  }

  async function operationFitsCurrentPdf(operation) {
    if (!currentHasPages || !currentBytes) return true;
    const trialPdf = await PDFDocument.load(currentBytes, { ignoreEncryption: true });
    await addOperation(trialPdf, operation);
    const trialBytes = await trialPdf.save({ useObjectStreams: true });
    return trialBytes.length <= maxBytes;
  }

  async function emitCurrentPdf() {
    if (!currentHasPages || !currentBytes) return;
    volumes.push({ sources: currentSources, bytes: currentBytes, oversize: currentBytes.length > maxBytes });
    await newPdf();
  }

  async function commitOperation(operation) {
    await ensurePdf();
    await addOperation(currentPdf, operation);
    const candidateBytes = Buffer.from(await currentPdf.save({ useObjectStreams: true }));

    if (candidateBytes.length > maxBytes && currentHasPages && currentBytes) {
      await emitCurrentPdf();
      await addOperation(currentPdf, operation);
      currentBytes = Buffer.from(await currentPdf.save({ useObjectStreams: true }));
      currentHasPages = true;
      rememberSources(operation);
    } else {
      currentBytes = candidateBytes;
      currentHasPages = true;
      rememberSources(operation);
    }

    if (currentBytes.length > maxBytes) await emitCurrentPdf();
  }

  async function flushPendingSinglePage() {
    if (!pendingSinglePage) return;
    const item = pendingSinglePage;
    pendingSinglePage = null;
    await commitOperation({ type: "single", item });
  }

  async function add(source) {
    const sourcePdf = await PDFDocument.load(await sourceBytes(source), { ignoreEncryption: true });
    const pages = sourcePdf.getPages();
    if (pages.length === 0) return;

    let startIndex = 0;
    let committedSourceOperations = 0;
    if (pendingSinglePage) {
      const first = pageInfo(sourcePdf, pages[0], 0, source);
      const canBridge = currentHasPages || pendingSinglePage.canBridgeWithoutCurrentPages;
      const pair = { type: "pair", first: pendingSinglePage, second: first };
      if (
        mergeVerticalPages &&
        pendingSinglePage.sourceKey !== first.sourceKey &&
        first.isVertical &&
        canBridge &&
        await operationFitsCurrentPdf(pair)
      ) {
        pendingSinglePage = null;
        await commitOperation(pair);
        startIndex = 1;
        committedSourceOperations += 1;
      } else {
        await flushPendingSinglePage();
      }
    }

    for (let pageIndex = startIndex; pageIndex < pages.length; pageIndex += 1) {
      const item = pageInfo(sourcePdf, pages[pageIndex], pageIndex, source);
      const isLast = pageIndex === pages.length - 1;
      if (mergeVerticalPages && isLast && item.isVertical) {
        item.canBridgeWithoutCurrentPages = committedSourceOperations === 0;
        pendingSinglePage = item;
        continue;
      }
      await commitOperation({ type: "single", item });
      committedSourceOperations += 1;
    }
  }

  async function finish() {
    await flushPendingSinglePage();
    await emitCurrentPdf();
    if (volumes.length === 0) throw new Error("No PDF pages were produced");
    return volumes;
  }

  return { add, finish };
}

export async function mergePdfBuffers(buffers, options = {}) {
  const collector = createPdfCollector({ maxBytes: Number.MAX_SAFE_INTEGER, ...options });
  for (let index = 0; index < buffers.length; index += 1) {
    await collector.add({ name: `source-${index + 1}.pdf`, chapterTitle: `source-${index + 1}`, bytes: buffers[index] });
  }
  const [volume] = await collector.finish();
  return volume.bytes;
}

async function sourceBytes(source) {
  return source.bytes || fs.readFile(source.filePath);
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

function sanitize(value) {
  return String(value || "manga")
    .replace(/[<>:"/\\|?*]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 150) || "manga";
}
