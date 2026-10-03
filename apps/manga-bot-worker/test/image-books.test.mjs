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

test("builds a compact Kindle-compatible EPUB without recompressing JPEG inputs", async () => {
  const directory = `/tmp/manga-direct-epub-test-${Date.now()}-${Math.random()}`;
  const inputDir = path.join(directory, "input");
  await fs.mkdir(inputDir, { recursive: true });
  const colors = ["#f00", "#0f0", "#00f", "#ff0"];
  const formats = ["jpg", "png", "jpg", "jpg"];
  const sources = [
    { name: "chapter-one", chapterTitle: "Chapter 1", pages: [] },
    { name: "chapter-two", chapterTitle: "Chapter 2", pages: [] }
  ];
  const sourceBytes = [];

  for (let index = 0; index < colors.length; index += 1) {
    const format = formats[index];
    const filePath = path.join(inputDir, `page-${index + 1}.${format}`);
    const image = sharp({
      create: { width: 10, height: 20, channels: 3, background: colors[index] }
    });
    await (format === "jpg" ? image.jpeg({ quality: 70 }) : image.png()).toFile(filePath);
    sourceBytes.push(await fs.readFile(filePath));
    sources[Math.floor(index / 2)].pages.push({
      filePath,
      width: 10,
      height: 20,
      format
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
    consumeSourceImages: true,
    imageRenderConcurrency: 2,
    epubBuildConcurrency: 2
  });

  assert.equal(volume.fileName, "Direct Chapter 1-Chapter 2.epub");
  assert.equal(volume.format, "epub");
  assert.deepEqual(volume.sources, ["chapter-one", "chapter-two"]);
  const archive = await JSZip.loadAsync(await fs.readFile(volume.filePath));
  const pageDocuments = Object.keys(archive.files)
    .filter((name) => /^OEBPS\/page-[0-9]+[.]xhtml$/.test(name))
    .sort();
  const pageEntries = Object.keys(archive.files)
    .filter((name) => /^OEBPS\/images\/page-[0-9]+(?:-[0-9]+)?[.]jpg$/.test(name))
    .sort();
  assert.equal(pageDocuments.length, 3);
  assert.equal(pageEntries.length, 4);
  const archivedBytes = await Promise.all(
    pageEntries.map((name) => archive.file(name).async("nodebuffer"))
  );
  const sourceJpegs = sourceBytes.filter((_bytes, index) => formats[index] === "jpg");
  for (const bytes of sourceJpegs) {
    assert.ok(archivedBytes.some((archived) => archived.equals(bytes)));
  }
  assert.ok(archivedBytes.every((bytes) => imageInfo(bytes).mediaType === "image/jpeg"));
  assert.ok(archivedBytes.every((bytes) => !bytes.equals(sourceBytes[1])));
  for (const bytes of archivedBytes) {
    const info = imageInfo(bytes);
    assert.deepEqual({ width: info.width, height: info.height }, { width: 10, height: 20 });
  }
  const firstPage = await archive.file(pageDocuments[0]).async("string");
  const pairedPage = await archive.file(pageDocuments[1]).async("string");
  assert.doesNotMatch(firstPage, /<svg|<image|<rect/);
  assert.match(firstPage, /<img [^>]*style="left:320px;top:0px;width:1280px;height:2560px"/);
  assert.doesNotMatch(pairedPage, /<svg|<image|<rect/);
  assert.equal((pairedPage.match(/<img /g) || []).length, 2);
  assert.match(pairedPage, /style="left:0px;top:320px;width:960px;height:1920px"/);
  assert.match(pairedPage, /style="left:960px;top:320px;width:960px;height:1920px"/);
  const opf = await archive.file("OEBPS/content.opf").async("string");
  assert.doesNotMatch(opf, /properties="svg"|media-type="image\/png"[^>]*page-image/);
  await assert.rejects(
    fs.access(path.join(directory, "out", ".prepared-images")),
    /ENOENT/
  );
  for (const source of sources) {
    for (const item of source.pages) await assert.rejects(fs.access(item.filePath), /ENOENT/);
  }
});

test("fills non-final EPUBs by splitting chapters", async () => {
  const directory = `/tmp/manga-filled-epub-test-${Date.now()}-${Math.random()}`;
  const inputDir = path.join(directory, "input");
  await fs.mkdir(inputDir, { recursive: true });
  const image = await sharp({
    create: { width: 10, height: 20, channels: 3, background: "#fff" }
  }).jpeg({ quality: 70 }).toBuffer();
  const sources = [
    { name: "chapter-one", chapterTitle: "Chapter 1", pages: [] },
    { name: "chapter-two", chapterTitle: "Chapter 2", pages: [] }
  ];
  for (let index = 0; index < 10; index += 1) {
    const filePath = path.join(inputDir, `page-${index + 1}.jpg`);
    await fs.writeFile(filePath, image);
    sources[index < 7 ? 0 : 1].pages.push({ filePath, width: 10, height: 20, format: "jpg" });
  }
  const coverPath = path.join(inputDir, "cover.jpg");
  await fs.writeFile(coverPath, image);

  const volumes = await buildKindleImageVolumes({
    sources,
    destinationDir: path.join(directory, "out"),
    baseName: "Filled",
    maxBytes: image.length * 4,
    mergeVerticalPages: false,
    coverPath,
    coverLookup: false,
    epubBuildConcurrency: 1
  });
  const pageCounts = await Promise.all(volumes.map(async (volume) => {
    const archive = await JSZip.loadAsync(await fs.readFile(volume.filePath));
    return Object.keys(archive.files).filter((name) => /^OEBPS\/images\/page-/.test(name)).length;
  }));

  assert.deepEqual(pageCounts, [4, 4, 2]);
  assert.deepEqual(volumes.map((volume) => volume.sources), [
    ["chapter-one"],
    ["chapter-one", "chapter-two"],
    ["chapter-two"]
  ]);
});

test("Scribe pages fit the screen despite 20th Century Boys and I am a Hero scan outliers", async () => {
  const directory = await fs.mkdtemp('/tmp/manga-scribe-');
  try {
    const imagePath = path.join(directory, 'page.jpg');
    await sharp({ create: { width: 10, height: 20, channels: 3, background: '#123456' } }).jpeg().toFile(imagePath);
    // Actual first-page dimensions from the source; pixel resolution must not
    // dictate the physical size of neighbouring pages or the book's canvas.
    const cases = [
      [[1200, 1558], [1200, 2523], [1200, 1736], [1200, 1736], [1200, 1736]],
      [[3887, 1600], [1103, 1600], [1120, 1600], [1113, 1600], [2284, 1600]],
      [[1200, 1736], [600, 868], [1200, 1736]]
    ];
    for (const [index, sizes] of cases.entries()) {
      const [volume] = await buildKindleImageVolumes({
        sources: [{ name: 'chapter', pages: sizes.map(([width, height]) => ({
          filePath: imagePath, width, height, format: 'jpg'
        })) }],
        destinationDir: path.join(directory, String(index)),
        baseName: 'Regression', maxBytes: 10_000_000,
        coverPath: imagePath, coverLookup: false
      });
      const zip = await JSZip.loadAsync(await fs.readFile(volume.filePath));
      const opf = await zip.file('OEBPS/content.opf').async('string');
      assert.match(opf, /original-resolution" content="2560x1920"/);
      for (const name of Object.keys(zip.files).filter((name) => /page-\d+[.]xhtml$/.test(name))) {
        const html = await zip.file(name).async('string');
        assert.match(html, /width=2560,height=1920/);
        const images = [...html.matchAll(/left:([\d.]+)px;top:([\d.]+)px;width:([\d.]+)px;height:([\d.]+)px/g)]
          .map((match) => match.slice(1).map(Number));
        assert.ok(images.length);
        const left = Math.min(...images.map(([x]) => x));
        const top = Math.min(...images.map(([, y]) => y));
        const right = Math.max(...images.map(([x, , w]) => x + w));
        const bottom = Math.max(...images.map(([, y, , h]) => y + h));
        const near = (a, b) => Math.abs(a - b) < 0.001;
        assert.ok(near(left, 2560 - right) && near(top, 1920 - bottom), 'content is centred');
        assert.ok(near(right - left, 2560) || near(bottom - top, 1920), 'content fills at least one screen dimension');
        assert.ok(left >= -0.001 && top >= -0.001 && right <= 2560.001 && bottom <= 1920.001, 'no cropping');
        if (images.length === 2) {
          assert.ok(near(images[0][1], images[1][1]) && near(images[0][3], images[1][3]), 'paired scans have equal physical height');
          assert.ok(near(images[0][0] + images[0][2], images[1][0]), 'RTL pages meet without a gap');
        }
      }
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
