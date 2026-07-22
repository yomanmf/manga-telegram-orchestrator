import assert from "node:assert/strict";
import test from "node:test";

import { PDFDocument } from "pdf-lib";

import { writePdfBatches } from "./pdf-batch-writer.mjs";

async function writePages({ count, maxBytes, batchSize, metrics = null }) {
  const emitted = [];
  const operations = Array.from({ length: count }, (_unused, index) => index);
  await writePdfBatches({
    operations,
    maxBytes,
    batchSize,
    metrics,
    async addOperation(pdf, index) {
      pdf.addPage([200 + index, 300]);
    },
    async emitPdf(bytes) {
      emitted.push(Buffer.from(bytes));
    }
  });
  return emitted;
}

test("serializes one checkpoint per normal batch instead of per page", async () => {
  const metrics = {};
  const emitted = await writePages({
    count: 10,
    maxBytes: Number.MAX_SAFE_INTEGER,
    batchSize: 4,
    metrics
  });

  assert.equal(emitted.length, 1);
  assert.equal(metrics.serializations, 3);
  const pdf = await PDFDocument.load(emitted[0]);
  assert.equal(pdf.getPageCount(), 10);
  assert.deepEqual(
    pdf.getPages().map((page) => page.getWidth()),
    Array.from({ length: 10 }, (_unused, index) => 200 + index)
  );
});

test("falls back to smaller batches when the size limit is crossed", async () => {
  const one = await writePages({
    count: 1,
    maxBytes: Number.MAX_SAFE_INTEGER,
    batchSize: 8
  });
  const all = await writePages({
    count: 8,
    maxBytes: Number.MAX_SAFE_INTEGER,
    batchSize: 8
  });
  const limit = Math.floor((one[0].length + all[0].length) / 2);
  const emitted = await writePages({ count: 8, maxBytes: limit, batchSize: 8 });

  assert.ok(emitted.length > 1);
  assert.ok(emitted.every((bytes) => bytes.length <= limit));
  const documents = await Promise.all(emitted.map((bytes) => PDFDocument.load(bytes)));
  assert.equal(
    documents.reduce((total, pdf) => total + pdf.getPageCount(), 0),
    8
  );
  assert.deepEqual(
    documents.flatMap((pdf) => pdf.getPages().map((page) => page.getWidth())),
    Array.from({ length: 8 }, (_unused, index) => 200 + index)
  );
});
