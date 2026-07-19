import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import JSZip from "jszip";
import { PDFDocument, rgb } from "pdf-lib";

import { buildMangaEpubFromPdf, imageInfo } from "../src/epub.mjs";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

test("recognizes PNG Kindle cover dimensions", () => {
  assert.deepEqual(imageInfo(ONE_PIXEL_PNG), {
    width: 1,
    height: 1,
    extension: "png",
    mediaType: "image/png"
  });
});

test("builds a fixed-layout manga EPUB with Kindle cover metadata", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "manga-epub-test-"));
  const pdfPath = path.join(directory, "manga.pdf");
  const coverPath = path.join(directory, "cover.png");
  const epubPath = path.join(directory, "manga.epub");
  const pdf = await PDFDocument.create();
  pdf.addPage([120, 200]).drawRectangle({ x: 0, y: 0, width: 120, height: 200, color: rgb(1, 0, 0) });
  pdf.addPage([240, 200]).drawRectangle({ x: 0, y: 0, width: 240, height: 200, color: rgb(0, 0, 1) });
  await fs.writeFile(pdfPath, await pdf.save());
  await fs.writeFile(coverPath, ONE_PIXEL_PNG);

  try {
    const size = await buildMangaEpubFromPdf({
      pdfPath,
      outputPath: epubPath,
      title: "One Piece (Color) Chapter 23-24",
      coverPath,
      modifiedDate: "2026-07-19"
    });
    const archive = await fs.readFile(epubPath);
    assert.equal(size, archive.length);
    assert.equal(archive.readUInt32LE(0), 0x04034b50);
    assert.equal(archive.readUInt16LE(8), 0);
    const firstNameLength = archive.readUInt16LE(26);
    assert.equal(archive.subarray(30, 30 + firstNameLength).toString("utf8"), "mimetype");

    const zip = await JSZip.loadAsync(archive);
    const opf = await zip.file("OEBPS/content.opf").async("string");
    assert.match(opf, /properties="cover-image"/);
    assert.match(opf, /<meta name="cover" content="cover-image"\/>/);
    assert.doesNotMatch(opf, /cover[.]xhtml|id="cover-page"/);
    assert.match(opf, /<meta property="rendition:layout">pre-paginated<\/meta>/);
    assert.match(opf, /<meta name="original-resolution" content="240x200"\/>/);
    assert.match(opf, /<meta name="primary-writing-mode" content="horizontal-rl"\/>/);
    assert.match(opf, /<meta name="book-type" content="comic"\/>/);
    assert.match(opf, /page-progression-direction="rtl"/);
    assert.match(opf, /<spine[^>]*><itemref idref="page-0001"/);
    assert.ok(zip.file("OEBPS/images/cover.png"));
    assert.deepEqual(await zip.file("OEBPS/images/cover.png").async("nodebuffer"), ONE_PIXEL_PNG);
    assert.equal(zip.file("OEBPS/cover.xhtml"), null);
    assert.ok(zip.file("OEBPS/images/page-0001.jpg"));
    assert.ok(zip.file("OEBPS/images/page-0002.jpg"));
    assert.equal(zip.file("OEBPS/images/page-0003.jpg"), null);
    const firstPage = await zip.file("OEBPS/page-0001.xhtml").async("string");
    assert.match(firstPage, /width=120,height=200/);
    const nav = await zip.file("OEBPS/nav.xhtml").async("string");
    assert.doesNotMatch(nav, /cover[.]xhtml/);
    assert.match(nav, /epub:type="bodymatter" href="page-0001[.]xhtml"/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
