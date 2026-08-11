import assert from "node:assert/strict";
import test from "node:test";

import { publicRequestBaseUrl } from "./public-url.mjs";

test("uses the current forwarded HTTPS origin instead of a stale configured IP", () => {
  assert.equal(publicRequestBaseUrl({
    protocol: "http",
    headers: {
      host: "kindle.internal:3000",
      "x-forwarded-host": "kindle.111.88.152.197.nip.io",
      "x-forwarded-proto": "https",
    },
  }, "https://kindle.103.76.52.249.nip.io"), "https://kindle.111.88.152.197.nip.io");
});
