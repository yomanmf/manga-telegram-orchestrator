import test from "node:test";
import assert from "node:assert/strict";

import { createQbittorrentClient } from "../src/qbittorrent.mjs";

test("returns a compact torrent list without filesystem paths", async () => {
  const client = createQbittorrentClient({
    baseUrl: "http://qbittorrent:8080/",
    async fetchImpl(url) {
      assert.match(url, /filter=all/);
      return new Response(JSON.stringify([{
        hash: "A".repeat(40), name: "Example", state: "downloading", progress: 0.25,
        size: 400, completed: 100, dlspeed: 12, upspeed: 3, eta: 25, added_on: 10,
        save_path: "/data/downloads/private"
      }]));
    }
  });
  const torrents = await client.list();
  assert.equal(torrents[0].hash, "a".repeat(40));
  assert.equal(torrents[0].downloadSpeed, 12);
  assert.equal("savePath" in torrents[0], false);
});

test("always deletes downloaded files with the torrent", async () => {
  let request;
  const client = createQbittorrentClient({
    async fetchImpl(url, options) {
      request = { url, options };
      return new Response("");
    }
  });
  await client.delete("b".repeat(40));
  assert.match(request.url, /\/api\/v2\/torrents\/delete$/);
  assert.equal(request.options.method, "POST");
  assert.equal(String(request.options.body), `hashes=${"b".repeat(40)}&deleteFiles=true`);
});

test("stops and starts one torrent with qBittorrent 5 endpoints", async () => {
  const calls = [];
  const client = createQbittorrentClient({
    async fetchImpl(url, options) {
      calls.push({ url, options });
      return new Response("");
    }
  });
  await client.setPaused("a".repeat(40), true);
  await client.setPaused("a".repeat(40), false);
  assert.deepEqual(calls.map(({ url }) => url.split("/").at(-1)), ["stop", "start"]);
  for (const { options } of calls) {
    assert.equal(options.method, "POST");
    assert.equal(String(options.body), `hashes=${"a".repeat(40)}`);
  }
});
