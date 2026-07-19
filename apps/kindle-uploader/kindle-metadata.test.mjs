import test from "node:test";
import assert from "node:assert/strict";

import {
  KINDLE_DOCUMENT_AUTHOR,
  kindleDocumentTitle
} from "./kindle-metadata.mjs";

test("labels uploaded Kindle documents as Manga", () => {
  assert.equal(KINDLE_DOCUMENT_AUTHOR, "Manga");
});

test("derives the Kindle title from PDF and EPUB filenames", () => {
  assert.equal(kindleDocumentTitle("Volume 1.pdf"), "Volume 1");
  assert.equal(kindleDocumentTitle("Volume 2.EPUB"), "Volume 2");
});
