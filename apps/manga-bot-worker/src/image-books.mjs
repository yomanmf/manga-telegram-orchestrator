import fs from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";

import { boundedInteger, mapWithConcurrency } from "./concurrency.mjs";
import { resolveEnglishChapterCover } from "./cover-resolver.mjs";
import { buildFixedLayoutMangaEpub } from "./epub.mjs";

const MAX_KINDLE_FILE_BYTES = 200_000_000;

function isVertical(page) {
  return page.width <= page.height;
}

function single(item) {
  return { type: "single", item };
}

function pair(first, second) {
  return { type: "pair", first, second };
}

function chapterOperations(source, mergeVerticalPages) {
  const pages = source.pages.map((page) => ({
    ...page,
    source,
    isVertical: isVertical(page)
  }));
  if (pages.length === 0) return [];
  if (!mergeVerticalPages) return pages.map(single);

  const operations = [single(pages[0])];
  for (let index = 1; index < pages.length;) {
    const current = pages[index];
    const next = pages[index + 1];
    if (current?.isVertical && next?.isVertical) {
      operations.push(pair(current, next));
      index += 2;
    } else {
      operations.push(single(current));
      index += 1;
    }
  }
  return operations;
}

export function buildImageOperations(sources, mergeVerticalPages = true) {
  const operations = [];
  let pending = null;

  for (const source of sources) {
    const current = chapterOperations(source, mergeVerticalPages);
    if (current.length === 0) continue;

    if (pending) {
      const first = current[0];
      if (
        mergeVerticalPages &&
        first.type === "single" &&
        first.item.isVertical &&
        pending.source !== first.item.source
      ) {
        operations.push(pair(pending, first.item));
        current.shift();
      } else {
        operations.push(single(pending));
      }
      pending = null;
    }

    const last = current.at(-1);
    if (
      mergeVerticalPages &&
      last?.type === "single" &&
      last.item.isVertical
    ) {
      pending = last.item;
      current.pop();
    }
    operations.push(...current);
  }

  if (pending) operations.push(single(pending));
  return operations;
}

function operationSources(operation) {
  const sources = [operation.type === "single" ? operation.item.source : operation.first.source];
  if (operation.type === "pair" && !sources.includes(operation.second.source)) {
    sources.push(operation.second.source);
  }
  return sources;
}

// Kindle's fixed-layout graphic-novel format requires JPEG content images.
// Preserve JPEG inputs byte-for-byte, and transcode only PNG inputs once.
async function preparePageImage(item, destinationDir, operationIndex, imageIndex) {
  if (item.format === "jpg") {
    const { size } = await fs.stat(item.filePath);
    return {
      filePath: item.filePath,
      size,
      info: { extension: "jpg", mediaType: "image/jpeg" }
    };
  }

  const filePath = path.join(
    destinationDir,
    `page-${String(operationIndex + 1).padStart(6, "0")}-${imageIndex + 1}.jpg`
  );
  await sharp(item.filePath, { animated: false })
    .flatten({ background: "#fff" })
    .jpeg({ quality: 86, optimiseCoding: true, progressive: false })
    .toFile(filePath);
  const { size } = await fs.stat(filePath);
  return {
    filePath,
    size,
    info: { extension: "jpg", mediaType: "image/jpeg" }
  };
}

async function prepareSingle(operation, mergeVerticalPages, destinationDir, operationIndex) {
  const item = operation.item;
  const prepared = await preparePageImage(item, destinationDir, operationIndex, 0);
  if (mergeVerticalPages && item.isVertical) {
    return {
      width: item.width * 2,
      height: item.height,
      size: prepared.size,
      images: [{
        filePath: prepared.filePath,
        x: item.width,
        y: 0,
        width: item.width,
        height: item.height,
        info: prepared.info
      }]
    };
  }
  return {
    width: item.width,
    height: item.height,
    size: prepared.size,
    images: [{
      filePath: prepared.filePath,
      x: 0,
      y: 0,
      width: item.width,
      height: item.height,
      info: prepared.info
    }]
  };
}

async function preparePair(operation, destinationDir, operationIndex) {
  const { first, second } = operation;
  const width = first.width + second.width;
  const height = Math.max(first.height, second.height);
  const [preparedFirst, preparedSecond] = await Promise.all([
    preparePageImage(first, destinationDir, operationIndex, 0),
    preparePageImage(second, destinationDir, operationIndex, 1)
  ]);
  function pageImage(item, prepared, x, y) {
    return {
      filePath: prepared.filePath,
      x,
      y,
      width: item.width,
      height: item.height,
      info: prepared.info
    };
  }
  return {
    width,
    height,
    size: preparedFirst.size + preparedSecond.size,
    images: [
      pageImage(
        second,
        preparedSecond,
        0,
        Math.floor((height - second.height) / 2)
      ),
      pageImage(
        first,
        preparedFirst,
        second.width,
        Math.floor((height - first.height) / 2)
      )
    ]
  };
}

async function prepareOperations({
  operations,
  destinationDir,
  mergeVerticalPages,
  concurrency
}) {
  await fs.mkdir(destinationDir, { recursive: true });
  return mapWithConcurrency(operations, concurrency, async (operation, index) => {
    const layout = operation.type === "pair"
      ? await preparePair(operation, destinationDir, index)
      : await prepareSingle(operation, mergeVerticalPages, destinationDir, index);
    return {
      ...layout,
      sources: operationSources(operation)
    };
  });
}

function splitPreparedPages(pages, maxBytes) {
  const groups = [];
  let current = [];
  let currentBytes = 0;

  for (const page of pages) {
    if (current.length > 0 && currentBytes + page.size > maxBytes) {
      groups.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(page);
    currentBytes += page.size;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function uniqueSources(pages) {
  const sources = [];
  for (const page of pages) {
    for (const source of page.sources) {
      if (!sources.includes(source)) sources.push(source);
    }
  }
  return sources;
}

function sanitize(value) {
  return String(value || "manga")
    .replace(/[<>:"/\\|?*]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 150) || "manga";
}

function volumeFileName(baseName, sources, index, count) {
  const chapterTitles = [...new Set(sources.map((source) => source.chapterTitle).filter(Boolean))];
  const chapterRange = chapterTitles.length === 0
    ? ""
    : chapterTitles.length === 1
      ? ` ${chapterTitles[0]}`
      : ` ${chapterTitles[0]}-${chapterTitles.at(-1)}`;
  const suffix = count > 1
    ? `__part_${String(index + 1).padStart(2, "0")}_of_${String(count).padStart(2, "0")}`
    : "";
  return `${sanitize(`${baseName}${chapterRange}`)}${suffix}.epub`;
}

export async function buildKindleImageVolumes({
  sources,
  destinationDir,
  baseName,
  maxBytes,
  mergeVerticalPages = true,
  coverPath,
  coverLookup = true,
  imageRenderConcurrency = 2,
  epubBuildConcurrency = 2
}) {
  if (!coverPath) throw new Error("A manga cover is required for Kindle delivery");
  if (!Array.isArray(sources) || sources.every((source) => source.pages.length === 0)) {
    throw new Error("No manga images were produced");
  }

  await fs.rm(destinationDir, { recursive: true, force: true });
  await fs.mkdir(destinationDir, { recursive: true });
  const preparedImageDir = path.join(destinationDir, ".prepared-images");
  const operations = buildImageOperations(sources, mergeVerticalPages);
  const prepared = await prepareOperations({
    operations,
    destinationDir: preparedImageDir,
    mergeVerticalPages,
    concurrency: boundedInteger(imageRenderConcurrency, 2, { min: 1, max: 4 })
  });
  const groups = splitPreparedPages(prepared, maxBytes);

  let volumes;
  try {
    volumes = await mapWithConcurrency(
      groups,
      boundedInteger(epubBuildConcurrency, 2, { min: 1, max: 4 }),
      async (pages, index) => {
        const includedSources = uniqueSources(pages);
        const fileName = volumeFileName(baseName, includedSources, index, groups.length);
        const filePath = path.join(destinationDir, fileName);
        const title = fileName.replace(/[.]epub$/i, "");
        const cover = await resolveEnglishChapterCover({
          title: baseName,
          chapterLabel: includedSources[0]?.chapterTitle,
          fallbackCoverPath: coverPath,
          destinationDir,
          index,
          lookup: coverLookup
        });
        let size;
        try {
          size = await buildFixedLayoutMangaEpub({
            outputPath: filePath,
            title,
            coverPath: cover.coverPath,
            pageLayouts: pages.map((page) => ({
              width: page.width,
              height: page.height,
              images: page.images
            }))
          });
        } finally {
          if (cover.temporary) await fs.rm(cover.coverPath, { force: true });
        }
        if (size > MAX_KINDLE_FILE_BYTES) {
          throw new Error(`${fileName} exceeds the 200 MB Kindle upload limit`);
        }
        return {
          fileName,
          filePath,
          size,
          format: "epub",
          oversize: false,
          sources: includedSources.map((source) => source.name),
          firstChapterTitle: includedSources[0]?.chapterTitle || null,
          lastChapterTitle: includedSources.at(-1)?.chapterTitle || null,
          coverChapterNumber: cover.chapterNumber,
          coverVolume: cover.volume,
          coverSource: cover.source
        };
      }
    );
  } finally {
    await fs.rm(preparedImageDir, { recursive: true, force: true });
  }
  return volumes;
}
