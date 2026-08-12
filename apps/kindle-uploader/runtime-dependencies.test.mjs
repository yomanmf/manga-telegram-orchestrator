import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./server.mjs", import.meta.url), "utf8");
const dockerfile = await readFile(new URL("./Dockerfile", import.meta.url), "utf8");

test("copies every local runtime module into the container image", () => {
  for (const [, moduleName] of source.matchAll(/\bfrom\s+["'][.]\/([^"']+)["']/g)) {
    assert.ok(dockerfile.includes(moduleName),
      `${moduleName} is imported by server.mjs but missing from the Dockerfile`);
  }
});
