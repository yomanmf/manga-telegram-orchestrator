import { PDFDocument } from "pdf-lib";

import { chunkItems } from "./processing-performance.mjs";

export async function writePdfBatches({
  operations,
  maxBytes,
  batchSize,
  addOperation,
  emitPdf,
  metrics = null
}) {
  let currentBytes = null;
  let operationCount = 0;
  let outputIndex = 1;
  let outputCount = 0;

  async function emitCurrentPdf() {
    if (!currentBytes || operationCount === 0) return;
    await emitPdf(currentBytes, outputIndex);
    outputIndex += 1;
    outputCount += 1;
    currentBytes = null;
    operationCount = 0;
  }

  async function tryCommitBatch(batch) {
    if (batch.length === 0) return true;

    const candidatePdf = currentBytes
      ? await PDFDocument.load(currentBytes, { ignoreEncryption: true })
      : await PDFDocument.create();

    for (const operation of batch) {
      await addOperation(candidatePdf, operation);
    }

    const candidateBytes = await candidatePdf.save({ useObjectStreams: true });
    if (metrics) metrics.serializations = (metrics.serializations || 0) + 1;

    if (
      candidateBytes.length > maxBytes &&
      (operationCount > 0 || batch.length > 1)
    ) {
      return false;
    }

    currentBytes = candidateBytes;
    operationCount += batch.length;

    // Preserve the previous behavior for a single operation larger than the
    // configured limit: emit it alone so the caller can report it explicitly.
    if (currentBytes.length > maxBytes) await emitCurrentPdf();
    return true;
  }

  async function commitBatch(batch) {
    if (await tryCommitBatch(batch)) return;

    if (operationCount > 0) {
      await emitCurrentPdf();
      if (await tryCommitBatch(batch)) return;
    }

    if (batch.length === 1) {
      throw new Error("A PDF operation could not be serialized");
    }

    const middle = Math.ceil(batch.length / 2);
    await commitBatch(batch.slice(0, middle));
    await commitBatch(batch.slice(middle));
  }

  for (const batch of chunkItems(operations, batchSize)) {
    await commitBatch(batch);
  }

  await emitCurrentPdf();
  return outputCount;
}
