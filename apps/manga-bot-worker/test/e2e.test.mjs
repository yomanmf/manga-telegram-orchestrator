import assert from "node:assert/strict";
import test from "node:test";

import { runMangaE2E } from "../src/e2e.mjs";

test("builds a live-flow manga artifact without calling Kindle delivery", async () => {
  const builds = [];
  const result = await runMangaE2E({
    query: "Test Manga",
    client: {
      async search() { return { results: [{ url: "https://weebcentral.com/series/test" }] }; },
      async loadSeries() {
        return {
          title: "Test Manga",
          coverUrl: "https://images.example.test/cover.png",
          chapters: [
            { id: "chapter-1", title: "Chapter 1" },
            { id: "chapter-2", title: "Chapter 2" }
          ],
        };
      },
      async downloadCover() { return Buffer.from("cover"); },
      async processChapterImages() {
        return [{ bytes: Buffer.from("image"), width: 1200, height: 1800, format: "jpg" }];
      },
    },
    async build(options) {
      builds.push(options);
      return [{ size: 3, oversize: false }];
    },
  });

  assert.equal(builds.length, 2);
  assert.ok(builds.every(({ sources }) => sources.length === 1 && sources[0].pages.length === 1));
  assert.deepEqual(result, {
    ok: true,
    title: "Test Manga",
    chapters: 2,
    files: 2,
    sizeBytes: 6,
    kindleDelivery: "skipped",
  });
});
