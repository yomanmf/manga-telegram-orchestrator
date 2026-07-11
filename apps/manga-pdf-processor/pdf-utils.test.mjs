import assert from "node:assert/strict";
import {
  assertValidSize,
  getBaseFileName,
  sanitizeFileName
} from "./pdf-utils.mjs";

assert.equal(
  sanitizeFileName("  My: Manga?.pdf  "),
  "My_ Manga_.pdf"
);
assert.equal(
  getBaseFileName("chapter-01.pdf"),
  "chapter-01"
);
assert.doesNotThrow(() =>
  assertValidSize(100, 200, "page")
);
assert.throws(
  () => assertValidSize(0, 200, "page"),
  /invalid page size/
);

console.log("pdf-utils tests passed");
