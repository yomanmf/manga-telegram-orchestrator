import assert from "node:assert/strict";
import test from "node:test";

import { runMangaE2E } from "../src/e2e.mjs";

test("builds a live-flow manga artifact without calling Kindle delivery", async () => {
  let built;
  const result = await runMangaE2E({
    query: "Test Manga",
    client: {
      async search() { return { results: [{ url: "https://weebcentral.com/series/test" }] }; },
      async loadSeries() {
        return {
          title: "Test Manga",
          coverUrl: "https://images.example.test/cover.png",
          chapters: [{ id: "chapter-1", title: "Chapter 1" }],
        };
      },
      async downloadCover() { return Buffer.from("cover"); },
      async processChapter() { return [{ name: "chapter.pdf", bytes: Buffer.from("pdf") }]; },
    },
    async build(options) {
      built = options;
      return [{ size: 3, oversize: false }];
    },
  });

  assert.equal(built.sourcePdfs.length, 1);
  assert.deepEqual(result, {
    ok: true,
    title: "Test Manga",
    chapter: "Chapter 1",
    files: 1,
    sizeBytes: 3,
    kindleDelivery: "skipped",
  });
});
