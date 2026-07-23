import assert from "node:assert/strict";
import { test } from "node:test";

import {
  normalizeKindleDocumentFileName,
  normalizeKindlePdfFileName
} from "./kindle-filename.mjs";

test("preserves the PDF suffix when a long CBZ-derived name is truncated", () => {
  const result = normalizeKindlePdfFileName(
    "Very long manga chapter ".repeat(12) + "__part_1.pdf"
  );

  assert.equal(result.length, 120);
  assert.match(result, /\.pdf$/);
});

test("normalizes an existing PDF suffix without duplicating it", () => {
  assert.equal(
    normalizeKindlePdfFileName("Chapter 1.PDF"),
    "Chapter 1.pdf"
  );
});

test("preserves EPUB filenames used for covered Kindle documents", () => {
  assert.equal(
    normalizeKindleDocumentFileName("Comic Vol. 2.epub"),
    "Comic Vol. 2.epub"
  );
});
