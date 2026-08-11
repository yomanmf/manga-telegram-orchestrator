import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createKindleClient } from "../src/kindle-client.mjs";

test("uploads tickets through the internal worker origin", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kindle-client-"));
  const file = path.join(directory, "book.epub");
  await fs.writeFile(file, "book");
  const originalFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return urls.length === 1
      ? Response.json({ uploadUrl: "https://kindle.old.nip.io/upload/1?token=t" })
      : Response.json({ job: { id: "1" } });
  };
  try {
    const client = createKindleClient({ baseUrl: "http://kindle-uploader:3000", sharedSecret: "secret" });
    assert.deepEqual(await client.enqueueFile(file, "book.epub"), { id: "1" });
    assert.equal(urls[1], "http://kindle-uploader:3000/upload/1?token=t");
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(directory, { recursive: true, force: true });
  }
});
