import assert from "node:assert/strict";
import { test } from "node:test";

import {
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
