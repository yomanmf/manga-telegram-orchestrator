import assert from "node:assert/strict";
import test from "node:test";

import { parseWeebCentralCoverUrl } from "./weebcentral-cover.mjs";

test("extracts the selected manga cover from WeebCentral metadata", () => {
  assert.equal(
    parseWeebCentralCoverUrl(`
      <meta property="og:title" content="One Piece (Color) | Weeb Central">
      <meta property="og:image" content="https://temp.compsci88.com/cover/fallback/series.jpg?size=large&amp;v=1">
    `),
    "https://temp.compsci88.com/cover/fallback/series.jpg?size=large&v=1"
  );
});

test("rejects a missing or unsafe manga cover", () => {
  assert.throws(() => parseWeebCentralCoverUrl("<html></html>"), /did not provide/);
  assert.throws(
    () => parseWeebCentralCoverUrl('<meta property="og:image" content="http://127.0.0.1/cover.jpg">'),
    /Unsafe manga cover URL/
  );
});
