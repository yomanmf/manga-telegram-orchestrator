import fs from "node:fs/promises";
import path from "node:path";

import { boundedInteger, mapWithConcurrency } from "./concurrency.mjs";
import { resolveEnglishChapterCover } from "./cover-resolver.mjs";
import { buildMangaEpubFromPdf } from "./epub.mjs";
import { buildKindleVolumes } from "./pdf.mjs";

const MAX_KINDLE_FILE_BYTES = 200_000_000;

export async function buildCoveredKindleVolumes(options) {
  if (!options.coverPath) throw new Error("A manga cover is required for Kindle delivery");
  const pdfVolumes = await buildKindleVolumes(options);
  const concurrency = boundedInteger(
    options.epubBuildConcurrency,
    2,
    { min: 1, max: 4 }
  );
  let epubVolumes;
  try {
    epubVolumes = await mapWithConcurrency(pdfVolumes, concurrency, async (volume, index) => {
      const fileName = volume.fileName.replace(/[.]pdf$/i, ".epub");
      const filePath = path.join(path.dirname(volume.filePath), fileName);
      const title = fileName.replace(/[.]epub$/i, "");
      const cover = await resolveEnglishChapterCover({
        title: options.baseName,
        chapterLabel: volume.firstChapterTitle,
        fallbackCoverPath: options.coverPath,
        destinationDir: path.dirname(volume.filePath),
        index,
        lookup: options.coverLookup !== false
      });
      let size;
      try {
        size = await buildMangaEpubFromPdf({
          pdfPath: volume.filePath,
          outputPath: filePath,
          title,
          coverPath: cover.coverPath
        });
      } finally {
        if (cover.temporary) await fs.rm(cover.coverPath, { force: true });
      }
      if (size > MAX_KINDLE_FILE_BYTES) {
        throw new Error(`${fileName} exceeds the 200 MB Kindle upload limit`);
      }
      return {
        ...volume,
        fileName,
        filePath,
        size,
        format: "epub",
        coverChapterNumber: cover.chapterNumber,
        coverVolume: cover.volume,
        coverSource: cover.source
      };
    });
  } finally {
    await Promise.all(pdfVolumes.map((volume) => fs.rm(volume.filePath, { force: true })));
  }
  return epubVolumes;
}
