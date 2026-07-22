import assert from "node:assert/strict";
import test from "node:test";

import JSZip from "jszip";

import { extractChapterImages } from "../src/chapter-images.mjs";

test("extracts ordered chapter images from the processor contract", async () => {
  const zip = new JSZip();
  zip.file("pages/page_0001.jpg", Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  zip.file(
    "pages/page_0002.png",
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  );
  zip.file("manifest.json", JSON.stringify({
    version: 1,
    pages: [
      { fileName: "pages/page_0001.jpg", width: 1200, height: 1800, format: "jpg" },
      { fileName: "pages/page_0002.png", width: 1200, height: 1800, format: "png" }
    ]
  }));

  const pages = await extractChapterImages(zip);

  assert.deepEqual(
    pages.map(({ fileName, width, height, format }) => ({ fileName, width, height, format })),
    [
      { fileName: "pages/page_0001.jpg", width: 1200, height: 1800, format: "jpg" },
      { fileName: "pages/page_0002.png", width: 1200, height: 1800, format: "png" }
    ]
  );
});

test("rejects traversal and duplicate entries in image manifests", async () => {
  const zip = new JSZip();
  zip.file("../page.jpg", Buffer.from([1]));
  zip.file("manifest.json", JSON.stringify({
    version: 1,
    pages: [
      { fileName: "../page.jpg", width: 100, height: 200, format: "jpg" }
    ]
  }));

  await assert.rejects(extractChapterImages(zip), /invalid page metadata/);
});
