import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createMangaAppClient } from "./manga-app.mjs";
import { buildKindleImageVolumesInSubprocess } from "./pdf-subprocess.mjs";

const MAX_BYTES = 150_000_000;

export async function runMangaE2E({ client, build = buildKindleImageVolumesInSubprocess, query = "One Piece" }) {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "manga-e2e-"));
  try {
    const search = await client.search(query);
    const choice = search.results?.[0];
    if (!choice?.url) throw new Error(`No manga found for ${query}`);

    const series = await client.loadSeries(choice.url);
    const chapter = series.chapters?.[0];
    if (!chapter?.id) throw new Error("The selected manga has no chapters");

    const pages = await client.processChapterImages({
      chapterId: chapter.id,
      mangaTitle: series.title,
      chapterTitle: chapter.title,
    });
    const storedPages = [];
    for (let index = 0; index < pages.length; index += 1) {
      const extension = pages[index].format === "jpg" ? "jpg" : "png";
      const filePath = path.join(workDir, `page-${index + 1}.${extension}`);
      await fs.writeFile(filePath, pages[index].bytes);
      storedPages.push({
        filePath,
        width: pages[index].width,
        height: pages[index].height,
        format: pages[index].format,
      });
    }

    const coverPath = path.join(workDir, "cover.img");
    try {
      await fs.writeFile(coverPath, await client.downloadCover({
        coverUrl: series.coverUrl,
        seriesUrl: choice.url,
      }));
    } catch {
      await fs.copyFile(storedPages[0].filePath, coverPath);
    }

    const volumes = await build({
      sources: [{ name: chapter.title, chapterTitle: chapter.title, pages: storedPages }],
      destinationDir: path.join(workDir, "volumes"),
      baseName: series.title,
      maxBytes: MAX_BYTES,
      mergeVerticalPages: true,
      coverPath,
      coverLookup: false,
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
