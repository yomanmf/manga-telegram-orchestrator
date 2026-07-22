import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import JSZip from "jszip";
import sharp from "sharp";

import { imageInfo } from "../src/epub.mjs";
import {
  buildImageOperations,
  buildKindleImageVolumes
} from "../src/image-books.mjs";

function page(source, id) {
  return {
    id,
    width: 10,
    height: 20,
    format: "jpg",
    filePath: `/${id}.jpg`,
    source
  };
}

test("preserves web pairing rules including chapter-boundary RTL pairs", () => {
  const first = { name: "one", chapterTitle: "Chapter 1", pages: [] };
  const second = { name: "two", chapterTitle: "Chapter 2", pages: [] };
  first.pages = [page(first, "1a"), page(first, "1b")];
  second.pages = [page(second, "2a"), page(second, "2b")];

  const operations = buildImageOperations([first, second], true);

  assert.deepEqual(operations.map((operation) => operation.type), ["single", "pair", "single"]);
  assert.equal(operations[1].first.id, "1b");
  assert.equal(operations[1].second.id, "2a");
  assert.deepEqual(
    buildImageOperations([first, second], false).map((operation) => operation.type),
    ["single", "single", "single", "single"]
  );
});

test("builds a covered EPUB directly from images without intermediate PDFs", async () => {
  const directory = `/tmp/manga-direct-epub-test-${Date.now()}-${Math.random()}`;
  const inputDir = path.join(directory, "input");
  await fs.mkdir(inputDir, { recursive: true });
  const colors = ["#f00", "#0f0", "#00f", "#ff0"];
  const sources = [
    { name: "chapter-one", chapterTitle: "Chapter 1", pages: [] },
    { name: "chapter-two", chapterTitle: "Chapter 2", pages: [] }
  ];

  for (let index = 0; index < colors.length; index += 1) {
    const filePath = path.join(inputDir, `page-${index + 1}.jpg`);
    await sharp({
      create: { width: 10, height: 20, channels: 3, background: colors[index] }
    }).jpeg().toFile(filePath);
    sources[Math.floor(index / 2)].pages.push({
      filePath,
      width: 10,
      height: 20,
      format: "jpg"
    });
  }

  const coverPath = path.join(inputDir, "cover.png");
  await sharp({
    create: { width: 10, height: 20, channels: 4, background: "#fff" }
  }).png().toFile(coverPath);

  const [volume] = await buildKindleImageVolumes({
    sources,
    destinationDir: path.join(directory, "out"),
    baseName: "Direct",
    maxBytes: 10_000_000,
    mergeVerticalPages: true,
    coverPath,
    coverLookup: false,
    imageRenderConcurrency: 2,
    epubBuildConcurrency: 2
  });

  assert.equal(volume.fileName, "Direct Chapter 1-Chapter 2.epub");
  assert.equal(volume.format, "epub");
  assert.deepEqual(volume.sources, ["chapter-one", "chapter-two"]);
  const archive = await JSZip.loadAsync(await fs.readFile(volume.filePath));
  const pageEntries = Object.keys(archive.files)
    .filter((name) => /^OEBPS\/images\/page-[0-9]+[.]jpg$/.test(name))
    .sort();
  assert.equal(pageEntries.length, 3);
  for (const name of pageEntries) {
    const info = imageInfo(await archive.file(name).async("nodebuffer"));
    assert.deepEqual(
      { width: info.width, height: info.height },
      { width: 20, height: 20 }
    );
  }
  await assert.rejects(
    fs.access(path.join(directory, "out", ".rendered-pages")),
    /ENOENT/
  );
});
