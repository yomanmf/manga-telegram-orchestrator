import test from "node:test";
import assert from "node:assert/strict";

import { createSeerrClient } from "../src/seerr.mjs";

test("returns all available Seerr requests without private service data", async () => {
  const urls = [];
  const client = createSeerrClient({
    baseUrl: "http://seerr:5055/",
    apiKey: "secret",
    async fetchImpl(url, options) {
      urls.push(url);
      assert.equal(options.headers["X-Api-Key"], "secret");
      if (url.includes("/api/v1/request?")) return new Response(JSON.stringify({
        pageInfo: { results: 1 },
        results: [{ id: 7, status: 5, type: "movie", updatedAt: "2026-09-20T10:00:00Z", media: { id: 8, status: 5, tmdbId: 9 } }]
      }));
      return new Response(JSON.stringify({ title: "Example Movie" }));
    }
  });
  const items = await client.listCompleted();
  assert.equal(items[0].name, "Example Movie");
  assert.equal(items[0].source, "seerr");
  assert.equal(items[0].progress, 1);
  assert.equal("serviceId" in items[0], false);
  assert.match(urls[0], /filter=available/);
});

test("deletes files before removing a matching completed Seerr request", async () => {
  const calls = [];
  const client = createSeerrClient({
    apiKey: "secret",
    async fetchImpl(url, options) {
      calls.push([url, options.method || "GET"]);
      if (options.method === undefined) return new Response(JSON.stringify({ id: 7, status: 5, media: { id: 8, status: 5 } }));
      return new Response(null, { status: 204 });
    }
  });
  assert.deepEqual(await client.deleteCompleted(7, 8), { ok: true, requestId: 7, mediaId: 8 });
  assert.deepEqual(calls.map((call) => call[1]), ["GET", "DELETE", "DELETE"]);
  assert.match(calls[1][0], /\/api\/v1\/media\/8\/file$/);
  assert.match(calls[2][0], /\/api\/v1\/request\/7$/);
  await assert.rejects(() => client.deleteCompleted(7, 9), /not an available completed request/);
});
