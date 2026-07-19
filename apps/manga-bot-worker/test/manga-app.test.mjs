import assert from "node:assert/strict";
import test from "node:test";

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
