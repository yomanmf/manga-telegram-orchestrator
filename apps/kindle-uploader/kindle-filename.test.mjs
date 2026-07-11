import assert from "node:assert/strict";
import { test } from "node:test";

import {
  normalizeKindlePdfFileName
} from "./kindle-filename.mjs";

test("keeps the PDF suffix inside the worker filename limit", () => {
  const result = normalizeKindlePdfFileName(
    "Long CBZ conversion ".repeat(20) + ".pdf"
  );

  assert.equal(result.length, 180);
  assert.match(result, /\.pdf$/);
});
