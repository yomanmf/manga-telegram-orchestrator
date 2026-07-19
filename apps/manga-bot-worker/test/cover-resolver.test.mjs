import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  englishSearchTitle,
  resolveEnglishChapterCover,
  resolveEnglishVolumeCover,
  selectMangaDexSeries,
  volumeForChapter
} from "../src/cover-resolver.mjs";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function pngWithDimensions(width, height, suffix = "") {
  const image = Buffer.concat([Buffer.from(ONE_PIXEL_PNG), Buffer.from(suffix)]);
  image.writeUInt32BE(width, 16);
  image.writeUInt32BE(height, 20);
  return image;
}

test("selects the exact manga and maps its first chapter to a volume", () => {
  assert.equal(englishSearchTitle("One Piece (Color)"), "One Piece");
  const exact = { id: "one-piece", attributes: { title: { "ja-ro": "One Piece" }, altTitles: [] } };
  const result = selectMangaDexSeries([
    { id: "academy", attributes: { title: { en: "One Piece Academy" }, altTitles: [] } },
    exact
  ], "One Piece (Color)");
  assert.equal(result, exact);
  assert.equal(volumeForChapter({
    volumes: {
      "2": { chapters: { "17": {} } },
      "3": { chapters: { "18": {}, "23": {}, "26": {} } },
      "4": { chapters: { "27": {} } }
    }
  }, "23"), "3");
});

test("uses a nearby chapter-volume anchor when an exact aggregate entry is missing", () => {
  assert.equal(volumeForChapter({
    volumes: {
      "18": { chapters: { "195": {} } },
      "19": { chapters: { "197": {} } },
      "20": { chapters: { "207": {} } }
    }
  }, "201"), "19");
  assert.equal(volumeForChapter({ volumes: { "1": { chapters: { "1": {} } } } }, "100"), null);
});

test("requests the exact English Apple Books cover at Kindle-quality resolution", async () => {
  const highResolutionCover = pngWithDimensions(1600, 2400, "apple-books-high-resolution");
  const fetchImpl = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "itunes.apple.com") {
      return jsonResponse({ results: [{
        kind: "ebook",
        trackName: "One Piece, Vol. 3",
        genres: ["Manga", "Comics & Graphic Novels"],
        artworkUrl100: "https://is1-ssl.mzstatic.com/image/thumb/Publication117/one-piece.jpg/100x100bb.jpg"
      }] });
    }
    if (url.hostname.endsWith(".mzstatic.com")) {
      assert.match(url.pathname, /\/1600x2560bb[.]jpg$/);
      return new Response(highResolutionCover, {
        status: 200,
        headers: { "Content-Type": "image/png" }
      });
    }
    if (url.hostname === "kodansha.us") return new Response("", { status: 404 });
    if (url.hostname === "openlibrary.org" && url.pathname === "/search.json") {
      return jsonResponse({ docs: [] });
    }
    return new Response("", { status: 404 });
  };

  const cover = await resolveEnglishVolumeCover({ fetchImpl, title: "One Piece", volume: "3" });
  assert.equal(cover.source, "Apple Books (English edition)");
  assert.equal(cover.info.width, 1600);
  assert.equal(cover.info.height, 2400);
  assert.deepEqual(cover.bytes, highResolutionCover);
});

test("accepts a catalog work with a non-English work title when its edition is English", async () => {
  const fetchImpl = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "kodansha.us") return new Response("", { status: 404 });
    if (url.pathname === "/search.json") {
      return jsonResponse({ docs: [{
        key: "/works/OL2W",
        title: "ベルセルク 1",
        publisher: ["Dark Horse Manga"]
      }] });
    }
    if (url.pathname === "/works/OL2W/editions.json") {
      return jsonResponse({ entries: [{
        title: "Berserk 1",
        publishers: ["Dark Horse Manga"],
        languages: [{ key: "/languages/eng" }],
        covers: [456]
      }] });
    }
    if (url.hostname === "covers.openlibrary.org") {
      return new Response(ONE_PIXEL_PNG, { status: 200, headers: { "Content-Type": "image/png" } });
    }
    return new Response("", { status: 404 });
  };
  const cover = await resolveEnglishVolumeCover({ fetchImpl, title: "Berserk", volume: "1" });
  assert.equal(cover.source, "Open Library (English edition)");
  assert.deepEqual(cover.bytes, ONE_PIXEL_PNG);
});

test("embeds the unchanged official English volume cover", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "manga-cover-resolver-"));
  const fallbackCoverPath = path.join(directory, "fallback.png");
  await fs.writeFile(fallbackCoverPath, Buffer.concat([ONE_PIXEL_PNG, Buffer.from("fallback")]));

  const fetchImpl = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "api.mangadex.org" && url.pathname === "/manga") {
      return jsonResponse({ data: [{ id: "one-piece", attributes: { title: { "ja-ro": "One Piece" } } }] });
    }
    if (url.hostname === "api.mangadex.org" && url.pathname.endsWith("/aggregate")) {
      return jsonResponse({ volumes: { "3": { chapters: { "23": {} } } } });
    }
    if (url.hostname === "kodansha.us") return new Response("", { status: 404 });
    if (url.hostname === "openlibrary.org" && url.pathname === "/search.json") {
      return jsonResponse({ docs: [{ key: "/works/OL1W", title: "ONE PIECE 3" }] });
    }
    if (url.hostname === "openlibrary.org" && url.pathname === "/works/OL1W/editions.json") {
      return jsonResponse({ entries: [{
        title: "One Piece, Vol. 3",
        publishers: ["VIZ Media"],
        languages: [{ key: "/languages/eng" }],
        isbn_10: ["1591161843"],
        covers: [123]
      }] });
    }
    if (url.hostname === "dw9to29mmj727.cloudfront.net") {
      return new Response(ONE_PIXEL_PNG, { status: 200, headers: { "Content-Type": "image/png" } });
    }
    return new Response("", { status: 404 });
  };

  try {
    const cover = await resolveEnglishChapterCover({
      fetchImpl,
      title: "One Piece (Color)",
      chapterLabel: "Chapter 23",
      fallbackCoverPath,
      destinationDir: directory
    });
    assert.equal(cover.source, "VIZ");
    assert.equal(cover.volume, "3");
    assert.equal(cover.chapterNumber, "23");
    assert.equal(cover.temporary, true);
    assert.deepEqual(await fs.readFile(cover.coverPath), ONE_PIXEL_PNG);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("falls back to the regular manga cover when there is no chapter number", async () => {
  const cover = await resolveEnglishChapterCover({
    title: "No Chapters",
    chapterLabel: "Oneshot",
    fallbackCoverPath: "/tmp/series-cover.jpg",
    destinationDir: "/tmp"
  });
  assert.equal(cover.coverPath, "/tmp/series-cover.jpg");
  assert.equal(cover.source, "series fallback");
  assert.equal(cover.chapterNumber, null);
});
