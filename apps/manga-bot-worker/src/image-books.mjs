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

async function renderSingle(operation, outputPath, mergeVerticalPages) {
  const item = operation.item;
  if (mergeVerticalPages && item.isVertical) {
    await sharp({
      create: {
        width: item.width * 2,
        height: item.height,
        channels: 3,
        background: "#fff"
      }
    })
      .composite([{ input: item.filePath, left: item.width, top: 0 }])
      .jpeg({ quality: 92, optimiseCoding: true })
      .toFile(outputPath);
    return { width: item.width * 2, height: item.height };
  }

  if (item.format === "jpg") {
    await fs.copyFile(item.filePath, outputPath);
  } else {
    await sharp(item.filePath)
      .jpeg({ quality: 92, optimiseCoding: true })
      .toFile(outputPath);
  }
  return { width: item.width, height: item.height };
}

async function renderPair(operation, outputPath) {
  const { first, second } = operation;
  const width = first.width + second.width;
  const height = Math.max(first.height, second.height);
  await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: "#fff"
    }
  })
    .composite([
      {
        input: second.filePath,
        left: 0,
        top: Math.floor((height - second.height) / 2)
      },
      {
        input: first.filePath,
        left: second.width,
        top: Math.floor((height - first.height) / 2)
      }
    ])
    .jpeg({ quality: 92, optimiseCoding: true })
    .toFile(outputPath);
  return { width, height };
}

async function renderOperations({
  operations,
  destinationDir,
  mergeVerticalPages,
  concurrency
}) {
  await fs.mkdir(destinationDir, { recursive: true });
  return mapWithConcurrency(operations, concurrency, async (operation, index) => {
    const filePath = path.join(
      destinationDir,
      `page-${String(index + 1).padStart(6, "0")}.jpg`
    );
    const dimensions = operation.type === "pair"
      ? await renderPair(operation, filePath)
      : await renderSingle(operation, filePath, mergeVerticalPages);
    const { size } = await fs.stat(filePath);
    return {
      filePath,
      size,
      ...dimensions,
      sources: operationSources(operation)
    };
  });
}

function splitRenderedPages(pages, maxBytes) {
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
  const renderDir = path.join(destinationDir, ".rendered-pages");
  const operations = buildImageOperations(sources, mergeVerticalPages);
  const rendered = await renderOperations({
    operations,
    destinationDir: renderDir,
    mergeVerticalPages,
    concurrency: boundedInteger(imageRenderConcurrency, 2, { min: 1, max: 4 })
  });
  const groups = splitRenderedPages(rendered, maxBytes);

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
            pagePaths: pages.map((page) => page.filePath),
            pageInfos: pages.map((page) => ({
              width: page.width,
              height: page.height,
              extension: "jpg",
              mediaType: "image/jpeg"
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
    await fs.rm(renderDir, { recursive: true, force: true });
  }

  return volumes;
}
