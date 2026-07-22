import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8")
);
const dockerfile = await readFile(
  new URL("../Dockerfile", import.meta.url),
  "utf8"
);

test("declares and validates Sharp in the Telegram worker runtime", async () => {
  assert.equal(packageJson.dependencies.sharp, "0.35.3");
  assert.match(dockerfile, /import\(\"sharp\"\)/);
  const { default: sharp } = await import("sharp");
  const bytes = await sharp({
    create: { width: 1, height: 1, channels: 3, background: "#fff" }
  }).jpeg().toBuffer();
  assert.ok(bytes.length > 0);
});
