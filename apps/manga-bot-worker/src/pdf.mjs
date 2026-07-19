import fs from "node:fs/promises";
import path from "node:path";
import { PDFDocument } from "pdf-lib";

export async function buildKindleVolumes({ sourcePdfs, destinationDir, baseName, maxBytes, mergeVerticalPages = true, metrics = null }) {
  if (sourcePdfs.length === 0) throw new Error("No PDF pages were produced");
  await fs.rm(destinationDir, { recursive: true, force: true });
  await fs.mkdir(destinationDir, { recursive: true });

  const collector = createPdfCollector({
    maxBytes,
    mergeVerticalPages,
    metrics,
    async emitVolume(volume, index) {
      const temporaryPath = path.join(destinationDir, `.volume-${String(index + 1).padStart(4, "0")}.pdf`);
      await fs.writeFile(temporaryPath, volume.bytes);
      return {
        temporaryPath,
        size: volume.bytes.length,
        oversize: volume.oversize,
        sources: volume.sources
      };
    }
  });

  for (const source of sourcePdfs) await collector.add(source);
  const volumes = await collector.finish();
  const output = [];
  for (let index = 0; index < volumes.length; index += 1) {
    const volume = volumes[index];
    const chapterTitles = [...new Set(volume.sources.map((source) => source.chapterTitle).filter(Boolean))];
    const fileName = buildVolumeFileName(baseName, volume.sources, index, volumes.length);
    const filePath = path.join(destinationDir, fileName);
    await fs.rename(volume.temporaryPath, filePath);
    output.push({
      fileName,
      filePath,
      size: volume.size,
      oversize: Boolean(volume.oversize),
      sources: volume.sources.map((source) => source.name),
      firstChapterTitle: chapterTitles[0] || null,
      lastChapterTitle: chapterTitles.at(-1) || null
    });
  }
  return output;
}

// The collector checkpoints once per source PDF (normally one manga chapter).
// It falls back to per-page checkpoints only if a single source cannot fit in
// an empty Kindle volume. The final vertical page is retained solely until the
// next source so cross-source RTL pairing remains identical to the web flow.
function createPdfCollector({ maxBytes, mergeVerticalPages, metrics = null, emitVolume = async (volume) => volume }) {
  let currentBytes = null;
  let currentHasPages = false;
  let currentSources = [];
  let pendingSinglePage = null;
  const volumes = [];

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

  function rememberSources(operations) {
    for (const operation of operations) {
      for (const source of operationSources(operation)) {
        if (!currentSources.includes(source)) currentSources.push(source);
      }
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

  async function documentFromCheckpoint() {
    return currentBytes
      ? PDFDocument.load(currentBytes, { ignoreEncryption: true })
      : PDFDocument.create();
  }

  async function tryCommitBatch(operations) {
    if (operations.length === 0) return true;
    const candidatePdf = await documentFromCheckpoint();
    for (const operation of operations) await addOperation(candidatePdf, operation);
    const candidateBytes = Buffer.from(await candidatePdf.save({ useObjectStreams: true }));
    if (metrics) metrics.serializations = (metrics.serializations || 0) + 1;

    if (candidateBytes.length > maxBytes && (currentHasPages || operations.length > 1)) return false;
    currentBytes = candidateBytes;
    currentHasPages = true;
    rememberSources(operations);
    if (candidateBytes.length > maxBytes) await emitCurrentPdf();
    return true;
  }

  async function commitWithPageFallback(operations) {
    for (const operation of operations) {
      if (await tryCommitBatch([operation])) continue;
      await emitCurrentPdf();
      if (!(await tryCommitBatch([operation]))) {
        throw new Error("A PDF page could not be placed in an empty Kindle volume");
      }
    }
  }

  async function emitCurrentPdf() {
    if (!currentHasPages || !currentBytes) return;
    const emitted = await emitVolume({
      sources: [...currentSources],
      bytes: currentBytes,
      oversize: currentBytes.length > maxBytes
    }, volumes.length);
    volumes.push(emitted);
    currentBytes = null;
    currentHasPages = false;
    currentSources = [];
  }

  function sourceOperations(sourcePdf, pages, source, startIndex = 0, initialOperations = []) {
    const operations = [...initialOperations];
    let committedSourceOperations = initialOperations.some((operation) =>
      operation.type === "pair" && operation.second.source === source
    ) ? 1 : 0;
    let trailingPending = null;

    for (let pageIndex = startIndex; pageIndex < pages.length; pageIndex += 1) {
      const item = pageInfo(sourcePdf, pages[pageIndex], pageIndex, source);
      const isLast = pageIndex === pages.length - 1;
      if (mergeVerticalPages && isLast && item.isVertical) {
        item.canBridgeWithoutCurrentPages = committedSourceOperations === 0;
        trailingPending = item;
        continue;
      }
      operations.push({ type: "single", item });
      committedSourceOperations += 1;
    }
    return { operations, trailingPending };
  }

  async function commitSourceOperations(operations) {
    if (operations.length === 0) return;
    if (await tryCommitBatch(operations)) return;
    if (currentHasPages) {
      await emitCurrentPdf();
      if (await tryCommitBatch(operations)) return;
    }
    await commitWithPageFallback(operations);
  }

  async function add(source) {
    const sourcePdf = await PDFDocument.load(await sourceBytes(source), { ignoreEncryption: true });
    const pages = sourcePdf.getPages();
    if (pages.length === 0) return;

    const previousPending = pendingSinglePage;
    pendingSinglePage = null;
    let leadingOperations = [];
    let startIndex = 0;
    if (previousPending) {
      const first = pageInfo(sourcePdf, pages[0], 0, source);
      const canBridge = currentHasPages || previousPending.canBridgeWithoutCurrentPages;
      if (
        mergeVerticalPages &&
        previousPending.sourceKey !== first.sourceKey &&
        first.isVertical &&
        canBridge
      ) {
        leadingOperations = [{ type: "pair", first: previousPending, second: first }];
        startIndex = 1;
      } else {
        leadingOperations = [{ type: "single", item: previousPending }];
      }
    }

    let prepared = sourceOperations(sourcePdf, pages, source, startIndex, leadingOperations);
    if (await tryCommitBatch(prepared.operations)) {
      pendingSinglePage = prepared.trailingPending;
      return;
    }

    // The whole next source did not fit. Preserve the previous source's final
    // page in the old volume, then retry this source atomically in a new one.
    if (previousPending) await commitWithPageFallback([{ type: "single", item: previousPending }]);
    if (currentHasPages) await emitCurrentPdf();
    prepared = sourceOperations(sourcePdf, pages, source, 0, []);
    await commitSourceOperations(prepared.operations);
    pendingSinglePage = prepared.trailingPending;
  }

  async function finish() {
    if (pendingSinglePage) {
      const item = pendingSinglePage;
      pendingSinglePage = null;
      await commitSourceOperations([{ type: "single", item }]);
    }
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
