import assert from "node:assert/strict";
import {
  bridgeChapterPages,
  rightToLeftPageOrder,
  splitOperationsBySize
} from "./pdf-merge-contract.mjs";

const first = {
  id: "chapter-1-page-last",
  isVertical: true
};
const second = {
  id: "chapter-2-page-first",
  isVertical: true
};

assert.deepEqual(
  rightToLeftPageOrder(first, second),
  [second, first]
);

const bridge = bridgeChapterPages(first, second);
assert.equal(bridge.type, "pair");
assert.deepEqual(
  bridge.pages.map((page) => page.id),
  ["chapter-2-page-first", "chapter-1-page-last"]
);

assert.equal(
  bridgeChapterPages(
    first,
    { ...second, isVertical: false }
  ),
  null
);

const groups = splitOperationsBySize(
  [
    { id: "a", size: 40 },
    { id: "b", size: 40 },
    { id: "c", size: 40 },
    { id: "d", size: 20 }
  ],
  100
);

assert.deepEqual(
  groups.map((group) => group.map((item) => item.id)),
  [["a", "b"], ["c", "d"]]
);

assert.deepEqual(
  splitOperationsBySize(
    [{ id: "oversized", size: 120 }],
    100
  ).map((group) => group.map((item) => item.id)),
  [["oversized"]]
);

console.log("pdf-merge-contract tests passed");
