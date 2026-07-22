import assert from "node:assert/strict";
import test from "node:test";

import JSZip from "jszip";

import { createMangaAppClient } from "../src/manga-app.mjs";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

test("downloads a safe JPEG or PNG cover selected by manga title search", async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url: String(url), options };
    return new Response(ONE_PIXEL_PNG, {
      headers: { "Content-Type": "image/png", "Content-Length": String(ONE_PIXEL_PNG.length) }
    });
  };
  try {
    const client = createMangaAppClient({ baseUrl: "https://processor.test", sessionToken: "token" });
    const cover = await client.downloadCover({
      coverUrl: "https://images.example.test/one-piece.png",
      seriesUrl: "https://weebcentral.com/series/one-piece"
    });
    assert.deepEqual(cover, ONE_PIXEL_PNG);
    assert.equal(request.url, "https://images.example.test/one-piece.png");
    assert.equal(request.options.redirect, "manual");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects unsafe cover URLs before fetching", async () => {
  const client = createMangaAppClient({ baseUrl: "https://processor.test", sessionToken: "token" });
  await assert.rejects(
    client.downloadCover({ coverUrl: "http://127.0.0.1/cover.png", seriesUrl: "https://weebcentral.com/" }),
    /unsafe cover URL/
  );
});

test("requests normalized source images for the direct EPUB pipeline", async () => {
  const zip = new JSZip();
  zip.file("pages/page_0001.jpg", Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  zip.file("manifest.json", JSON.stringify({
    version: 1,
    pages: [
      { fileName: "pages/page_0001.jpg", width: 1200, height: 1800, format: "jpg" }
    ]
  }));
  const archive = await zip.generateAsync({ type: "uint8array", compression: "STORE" });
  const originalFetch = globalThis.fetch;
  let requestBody;
  globalThis.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return new Response(archive, { headers: { "Content-Type": "application/zip" } });
  };

  try {
    const client = createMangaAppClient({ baseUrl: "https://processor.test", sessionToken: "token" });
    const pages = await client.processChapterImages({
      chapterId: "chapter-id",
      mangaTitle: "Manga",
      chapterTitle: "Chapter 1"
    });
    assert.equal(requestBody.outputFormat, "images");
    assert.equal(requestBody.shouldMerge, false);
    assert.equal(pages.length, 1);
    assert.deepEqual(
      { width: pages[0].width, height: pages[0].height, format: pages[0].format },
      { width: 1200, height: 1800, format: "jpg" }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
