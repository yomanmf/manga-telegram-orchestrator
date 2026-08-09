import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createMangaAppClient } from "./manga-app.mjs";
import { buildKindleVolumesInSubprocess } from "./pdf-subprocess.mjs";

const MAX_BYTES = 150_000_000;

export async function runMangaE2E({ client, build = buildKindleVolumesInSubprocess, query = "One Piece" }) {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "manga-e2e-"));
  try {
    const search = await client.search(query);
    const choice = search.results?.[0];
    if (!choice?.url) throw new Error(`No manga found for ${query}`);

    const series = await client.loadSeries(choice.url);
    const chapter = series.chapters?.[0];
    if (!chapter?.id) throw new Error("The selected manga has no chapters");

    const coverPath = path.join(workDir, "cover.img");
    await fs.writeFile(coverPath, await client.downloadCover({
      coverUrl: series.coverUrl,
      seriesUrl: choice.url,
    }));

    const outputs = await client.processChapter({
      chapterId: chapter.id,
      mangaTitle: series.title,
      chapterTitle: chapter.title,
      shouldMerge: true,
    });
    const sourcePdfs = [];
    for (let index = 0; index < outputs.length; index += 1) {
      const filePath = path.join(workDir, `chapter-${index + 1}.pdf`);
      await fs.writeFile(filePath, outputs[index].bytes);
      sourcePdfs.push({ name: outputs[index].name, chapterTitle: chapter.title, filePath });
    }

    const volumes = await build({
      sourcePdfs,
      destinationDir: path.join(workDir, "volumes"),
      baseName: series.title,
      maxBytes: MAX_BYTES,
      mergeVerticalPages: true,
      coverPath,
    });
    if (!volumes.length || volumes.some((volume) => !volume.size || volume.oversize)) {
      throw new Error("Manga Kindle assembly produced an invalid volume");
    }
    return {
      ok: true,
      title: series.title,
      chapter: chapter.title,
      files: volumes.length,
      sizeBytes: volumes.reduce((total, volume) => total + volume.size, 0),
      kindleDelivery: "skipped",
    };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const client = createMangaAppClient({
    baseUrl: process.env.MANGA_APP_URL,
    sessionToken: process.env.MANGA_APP_SESSION_TOKEN,
  });
  console.log(JSON.stringify(await runMangaE2E({
    client,
    query: process.env.E2E_MANGA_QUERY || "One Piece",
  })));
}
