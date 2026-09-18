import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import http from "node:http";

import { createKindleClient } from "../src/kindle-client.mjs";

test("aborts an unresponsive uploader instead of blocking reconciliation", async () => {
  const server = http.createServer(() => {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const client = createKindleClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, sharedSecret: "test", timeoutMs: 30 });
    await assert.rejects(client.job("stuck"), { name: "TimeoutError" });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

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
