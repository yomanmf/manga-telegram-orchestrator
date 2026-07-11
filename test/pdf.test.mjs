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
    pdf.addPage([300, 400]);
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
