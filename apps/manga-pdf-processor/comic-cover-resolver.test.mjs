import assert from "node:assert/strict";
import test from "node:test";

import sharp from "sharp";

import {
  chapterNumberFromFileName,
  explicitVolumeFromFileName,
  normalizeComicTitle,
  resolveComicCover,
  volumeForChapter
} from "./comic-cover-resolver.mjs";

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

test("normalizes the optional title and reads chapter or volume from filenames", () => {
  assert.equal(normalizeComicTitle("  One   Piece  "), "One Piece");
  assert.equal(chapterNumberFromFileName("One Piece Chapter 23.pdf"), "23");
  assert.equal(explicitVolumeFromFileName("Saga Vol. 4.cbz"), "4");
  assert.throws(() => normalizeComicTitle("x".repeat(181)), /too long/);
});

test("maps an uploaded chapter to its exact catalog volume", () => {
  assert.equal(volumeForChapter({
    volumes: {
      "2": { chapters: { "17": {} } },
      "3": { chapters: { "23": {}, "24": {} } }
    }
  }, "23"), "3");
});

test("returns a high-resolution matching cover for an uploaded comic file", async () => {
  const artwork = await sharp({
    create: {
      width: 1200,
      height: 1800,
      channels: 3,
      background: "#663399"
    }
  }).jpeg().toBuffer();

  const fetchImpl = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "itunes.apple.com") {
      return jsonResponse({ results: [{
        kind: "ebook",
        trackName: "One Piece, Vol. 3",
        genres: ["Manga", "Comics & Graphic Novels"],
        artworkUrl100: "https://is1-ssl.mzstatic.com/image/thumb/one-piece/100x100bb.jpg"
      }] });
    }
    if (url.hostname.endsWith(".mzstatic.com")) {
      assert.match(url.pathname, /1600x2560bb[.]jpg$/);
      return new Response(artwork, {
        status: 200,
        headers: { "Content-Type": "image/jpeg" }
      });
    }
    if (url.hostname === "openlibrary.org") return jsonResponse({ docs: [] });
    return new Response("", { status: 404 });
  };

  const cover = await resolveComicCover({
    fetchImpl,
    title: "One Piece",
    fileName: "One Piece Vol. 3.cbz"
  });

  assert.equal(cover.source, "Apple Books");
  assert.equal(cover.volume, "3");
  assert.equal(cover.width, 1200);
  assert.equal(cover.height, 1800);
  assert.equal(cover.contentType, "image/jpeg");
  assert.deepEqual(cover.bytes, artwork);
});
