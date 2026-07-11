import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import { PDFDocument } from "pdf-lib";
import { buildKindleVolumes } from "../src/pdf.mjs";

test("merges source PDFs and splits on a configured size", async () => {
  const directory = `/tmp/manga-pdf-test-${Date.now()}-${Math.random()}`;
  await fs.mkdir(directory, { recursive: true });
  const sources = [];
  for (let index = 0; index < 2; index += 1) {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([300, 400]);
    page.drawRectangle({ x: 0, y: 0, width: 1, height: 1 });
    const filePath = path.join(directory, `${index}.pdf`);
    await fs.writeFile(filePath, await pdf.save());
    sources.push({ name: `${index}.pdf`, chapterTitle: `Chapter ${201 + index}`, filePath });
  }
  const volumes = await buildKindleVolumes({
    sourcePdfs: sources,
    destinationDir: path.join(directory, "out"),
    baseName: "Fable",
    maxBytes: 10_000_000
  });
  assert.equal(volumes.length, 1);
  assert.ok(volumes[0].size > 0);
  assert.equal(volumes[0].fileName, "Fable Chapter 201-Chapter 202.pdf");
});

test("places an unpaired vertical page on the right side of a landscape spread", async () => {
  const directory = `/tmp/manga-spread-test-${Date.now()}-${Math.random()}`;
  await fs.mkdir(directory, { recursive: true });
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([300, 600]);
  page.drawRectangle({ x: 0, y: 0, width: 1, height: 1 });
  const filePath = path.join(directory, "cover.pdf");
  await fs.writeFile(filePath, await pdf.save());

  const [spread] = await buildKindleVolumes({
    sourcePdfs: [{ name: "cover.pdf", chapterTitle: "Chapter 201", filePath }],
    destinationDir: path.join(directory, "out"),
    baseName: "Fable",
    maxBytes: 10_000_000,
    mergeVerticalPages: true
  });
  const spreadPdf = await PDFDocument.load(await fs.readFile(spread.filePath));
  assert.deepEqual(spreadPdf.getPage(0).getSize(), { width: 600, height: 600 });

  const [portrait] = await buildKindleVolumes({
    sourcePdfs: [{ name: "cover.pdf", chapterTitle: "Chapter 201", filePath }],
    destinationDir: path.join(directory, "out-disabled"),
    baseName: "Fable",
    maxBytes: 10_000_000,
    mergeVerticalPages: false
  });
  const portraitPdf = await PDFDocument.load(await fs.readFile(portrait.filePath));
  assert.deepEqual(portraitPdf.getPage(0).getSize(), { width: 300, height: 600 });
});
