import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./index.ts", import.meta.url), "utf8");

test("serves normalized chapter images for the direct Telegram EPUB path", () => {
  assert.match(source, /input\.outputFormat === "images"/);
  assert.match(source, /"manifest\.json"/);
  assert.match(source, /fileName,\s*width: image\.width,\s*height: image\.height,\s*format: image\.format/);
});

test("uses bounded downloads, batched PDF checkpoints, and stored archives", () => {
  assert.match(source, /mapWithConcurrency\(\s*imageUrls,\s*WEEBCENTRAL_IMAGE_CONCURRENCY/);
  assert.match(source, /fetchWeebCentralImageBytes\(/);
  assert.match(source, /timeoutMs:\s*WEEBCENTRAL_IMAGE_TIMEOUT_MS/);
  assert.match(source, /writePdfBatches\(\{/);
  assert.match(source, /compression: "STORE"/);
});

test("lets web users choose manga or western-comic spread order", () => {
  assert.match(source, /id="readingDirectionToggle"/);
  assert.match(source, /role="switch"/);
  assert.match(source, /Page order: Comics \(left to right\)/);
  assert.match(source, /formData\.append\(\s*"shouldUseRightToLeft"/);
  assert.match(source, /body\.shouldUseRightToLeft !== false/);
});
