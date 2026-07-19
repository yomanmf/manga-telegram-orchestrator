import assert from "node:assert/strict";
import { test } from "node:test";

import {
  kindleContentTypeForFileName,
  normalizeKindleDocumentFileName,
  normalizeKindlePdfFileName
} from "./kindle-filename.mjs";

test("keeps the PDF suffix inside the worker filename limit", () => {
  const result = normalizeKindlePdfFileName(
    "Long CBZ conversion ".repeat(20) + ".pdf"
  );

  assert.equal(result.length, 180);
  assert.match(result, /\.pdf$/);
});

test("preserves EPUB filenames and reports the upload content type", () => {
  const result = normalizeKindleDocumentFileName(
    "Long covered manga ".repeat(20) + ".EPUB"
  );
  assert.equal(result.length, 180);
  assert.match(result, /\.epub$/);
  assert.equal(kindleContentTypeForFileName(result), "application/epub+zip");
  assert.equal(kindleContentTypeForFileName("chapter.pdf"), "application/pdf");
});
