import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import JSZip from "jszip";
import { PDFDocument } from "pdf-lib";
import { buildKindleVolumes, mergePdfBuffers } from "../src/pdf.mjs";
import { buildKindleVolumesInSubprocess } from "../src/pdf-subprocess.mjs";

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
  assert.equal(volumes[0].firstChapterTitle, "Chapter 201");
  assert.equal(volumes[0].lastChapterTitle, "Chapter 202");
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

test("matches web cross-source pairing rules for vertical pages", async () => {
  const oneSource = await PDFDocument.create();
  for (let index = 0; index < 2; index += 1) {
    const page = oneSource.addPage([300, 600]);
    page.drawRectangle({ x: index, y: 0, width: 1, height: 1 });
  }
  const sameSourceResult = await PDFDocument.load(await mergePdfBuffers([
    await oneSource.save()
  ], { mergeVerticalPages: true }));
  assert.equal(sameSourceResult.getPageCount(), 2);
  assert.deepEqual(sameSourceResult.getPage(0).getSize(), { width: 600, height: 600 });

  const firstSource = await PDFDocument.create();
  firstSource.addPage([300, 600]).drawRectangle({ x: 0, y: 0, width: 1, height: 1 });
  const secondSource = await PDFDocument.create();
  secondSource.addPage([300, 600]).drawRectangle({ x: 0, y: 0, width: 1, height: 1 });
  const crossSourceResult = await PDFDocument.load(await mergePdfBuffers([
    await firstSource.save(), await secondSource.save()
  ], { mergeVerticalPages: true }));
  assert.equal(crossSourceResult.getPageCount(), 1);
  assert.deepEqual(crossSourceResult.getPage(0).getSize(), { width: 600, height: 600 });
});

test("serializes a normal source once instead of once per page", async () => {
  const directory = `/tmp/manga-pdf-checkpoint-test-${Date.now()}-${Math.random()}`;
  await fs.mkdir(directory, { recursive: true });
  const pdf = await PDFDocument.create();
  for (let index = 0; index < 12; index += 1) {
    pdf.addPage([600, 300]).drawRectangle({ x: index, y: 0, width: 1, height: 1 });
  }
  const filePath = path.join(directory, "chapter.pdf");
  await fs.writeFile(filePath, await pdf.save());
  const metrics = {};
  await buildKindleVolumes({
    sourcePdfs: [{ name: "chapter.pdf", chapterTitle: "Chapter 1", filePath }],
    destinationDir: path.join(directory, "out"),
    baseName: "Memory Test",
    maxBytes: 10_000_000,
    mergeVerticalPages: true,
    metrics
  });
  assert.equal(metrics.serializations, 1);
});

test("splits at a source boundary without retaining in-memory output volumes", async () => {
  const directory = `/tmp/manga-pdf-boundary-test-${Date.now()}-${Math.random()}`;
  await fs.mkdir(directory, { recursive: true });
  const sources = [];
  for (let index = 0; index < 2; index += 1) {
    const pdf = await PDFDocument.create();
    for (let pageIndex = 0; pageIndex < 4; pageIndex += 1) {
      const page = pdf.addPage([600, 300]);
      page.drawText(`${index}-${pageIndex}-${"x".repeat(2_000)}`);
    }
    const filePath = path.join(directory, `chapter-${index}.pdf`);
    await fs.writeFile(filePath, await pdf.save({ useObjectStreams: true }));
    sources.push({ name: `chapter-${index}.pdf`, chapterTitle: `Chapter ${index + 1}`, filePath });
  }

  const [single] = await buildKindleVolumes({
    sourcePdfs: [sources[0]], destinationDir: path.join(directory, "single"),
    baseName: "Boundary", maxBytes: 10_000_000, mergeVerticalPages: false
  });
  const [combined] = await buildKindleVolumes({
    sourcePdfs: sources, destinationDir: path.join(directory, "combined"),
    baseName: "Boundary", maxBytes: 10_000_000, mergeVerticalPages: false
  });
  assert.ok(combined.size > single.size);
  const maxBytes = Math.floor((single.size + combined.size) / 2);
  const volumes = await buildKindleVolumes({
    sourcePdfs: sources, destinationDir: path.join(directory, "split"),
    baseName: "Boundary", maxBytes, mergeVerticalPages: false
  });
  assert.equal(volumes.length, 2);
  assert.ok(volumes.every((volume) => volume.size <= maxBytes));
  assert.deepEqual((await fs.readdir(path.join(directory, "split"))).sort(),
    volumes.map((volume) => volume.fileName).sort());
});

test("assembles volumes in a one-shot subprocess", async () => {
  const directory = `/tmp/manga-pdf-subprocess-test-${Date.now()}-${Math.random()}`;
  await fs.mkdir(directory, { recursive: true });
  const pdf = await PDFDocument.create();
  pdf.addPage([300, 400]).drawRectangle({ x: 0, y: 0, width: 1, height: 1 });
  const filePath = path.join(directory, "chapter.pdf");
  const coverPath = path.join(directory, "cover.png");
  await fs.writeFile(filePath, await pdf.save());
  await fs.writeFile(coverPath, Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64"
  ));

  const volumes = await buildKindleVolumesInSubprocess({
    sourcePdfs: [{ name: "chapter.pdf", chapterTitle: "Chapter 1", filePath }],
    destinationDir: path.join(directory, "out"),
    baseName: "Subprocess",
    maxBytes: 10_000_000,
    mergeVerticalPages: true,
    coverPath,
    coverLookup: false
  });
  assert.equal(volumes.length, 1);
  assert.equal(volumes[0].fileName, "Subprocess Chapter 1.epub");
  assert.equal(volumes[0].format, "epub");
  assert.equal(volumes[0].coverChapterNumber, "1");
  assert.equal(volumes[0].coverSource, "series fallback");
  assert.ok((await fs.stat(volumes[0].filePath)).size > 0);
});

test("packages every split Kindle volume as a covered EPUB", async () => {
  const directory = `/tmp/manga-covered-split-test-${Date.now()}-${Math.random()}`;
  await fs.mkdir(directory, { recursive: true });
  const sources = [];
  for (let index = 0; index < 2; index += 1) {
    const pdf = await PDFDocument.create();
    for (let pageIndex = 0; pageIndex < 1; pageIndex += 1) {
      pdf.addPage([600, 900]).drawRectangle({
        x: index + pageIndex,
        y: index,
        width: 10,
        height: 10
      });
    }
    const filePath = path.join(directory, `chapter-${index + 1}.pdf`);
    await fs.writeFile(filePath, await pdf.save({ useObjectStreams: true }));
    sources.push({
      name: `chapter-${index + 1}.pdf`,
      chapterTitle: `Chapter ${index + 1}`,
      filePath
    });
  }

  const [single] = await buildKindleVolumes({
    sourcePdfs: [sources[0]],
    destinationDir: path.join(directory, "single"),
    baseName: "Solanin",
    maxBytes: 10_000_000,
    mergeVerticalPages: false
  });
  const [combined] = await buildKindleVolumes({
    sourcePdfs: sources,
    destinationDir: path.join(directory, "combined"),
    baseName: "Solanin",
    maxBytes: 10_000_000,
    mergeVerticalPages: false
  });
  const cover = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64"
  );
  const coverPath = path.join(directory, "cover.png");
  await fs.writeFile(coverPath, cover);

  const volumes = await buildKindleVolumesInSubprocess({
    sourcePdfs: sources,
    destinationDir: path.join(directory, "out"),
    baseName: "Solanin",
    maxBytes: Math.floor((single.size + combined.size) / 2),
    mergeVerticalPages: false,
    coverPath,
    coverLookup: false
  });

  assert.equal(volumes.length, 2);
  for (const volume of volumes) {
    assert.equal(volume.format, "epub");
    assert.match(volume.fileName, /[.]epub$/i);
    const archive = await JSZip.loadAsync(await fs.readFile(volume.filePath));
    const opf = await archive.file("OEBPS/content.opf").async("string");
    assert.match(opf, /properties="cover-image"/);
    assert.match(opf, /<spine[^>]*><itemref idref="page-0001"/);
    assert.deepEqual(await archive.file("OEBPS/images/cover.png").async("nodebuffer"), cover);
    assert.equal(archive.file("OEBPS/cover.xhtml"), null);
  }
});
