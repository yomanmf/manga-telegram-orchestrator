import assert from "node:assert/strict";
import test from "node:test";

import JSZip from "jszip";
import { PDFDocument, rgb } from "pdf-lib";
import sharp from "sharp";

import { buildCoveredKindleEpub } from "./kindle-cover-epub.mjs";

test("stores the Kindle cover in EPUB metadata without adding a readable cover page", async () => {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([800, 600]);
  page.drawRectangle({ x: 0, y: 0, width: 800, height: 600, color: rgb(0.2, 0.3, 0.8) });
  const pdfBytes = await pdf.save();
  const coverBytes = await sharp({
    create: {
      width: 600,
      height: 900,
      channels: 3,
      background: "#993366"
    }
  }).jpeg().toBuffer();

  const epubBytes = await buildCoveredKindleEpub({
    pdfBytes,
    coverBytes,
    coverContentType: "image/jpeg",
    title: "Example Comic Vol. 1",
    rightToLeft: false
  });
  const epub = await JSZip.loadAsync(epubBytes);
  const packageXml = await epub.file("OEBPS/content.opf").async("string");

  assert.match(packageXml, /properties="cover-image"/);
  assert.match(packageXml, /<meta name="cover" content="cover-image"\/>/);
  assert.match(packageXml, /page-progression-direction="ltr"/);
  assert.match(packageXml, /<spine[^>]*><itemref idref="page-0001"/);
  assert.doesNotMatch(packageXml, /cover[.]xhtml|idref="cover-image"/);
  assert.ok(epub.file("OEBPS/page-0001.xhtml"));
  assert.equal(epub.file("OEBPS/page-0002.xhtml"), null);
  assert.deepEqual(
    Buffer.from(await epub.file("OEBPS/images/cover.jpg").async("uint8array")),
    coverBytes
  );
});
