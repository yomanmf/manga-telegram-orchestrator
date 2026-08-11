import assert from "node:assert/strict";
import test from "node:test";

import {
  loadCompleteMangaDexVolumes,
  loadMangaDexChapterImageUrls
} from "./mangadex-source.mjs";

const IDS = [
  "36832255-cfa0-4dc4-a851-6d5d97ece76d",
  "61d53b06-b659-43c6-a80b-9c982ba37099"
];

test("uses only a complete MangaDex volume set and resolves its pages", async () => {
  const fetchImpl = async (input) => {
    const url = new URL(input);
    if (url.pathname === "/manga") return Response.json({ data: [{
      id: "231d5196-1f41-4eba-af8d-841d40bc548d",
      attributes: { title: { en: "Homunculus" }, lastVolume: "2", status: "completed" }
    }] });
    if (url.pathname.endsWith("/feed")) return Response.json({ total: 2, data: IDS.map((id, index) => ({
      id,
      attributes: { volume: String(index + 1), chapter: null, pages: 1, externalUrl: null }
    })) });
    return Response.json({
      baseUrl: "https://node.mangadex.network",
      chapter: { hash: "0123456789abcdef0123456789abcdef", data: ["page.jpg"] }
    });
  };

  const volumes = await loadCompleteMangaDexVolumes("Homunculus", fetchImpl);
  assert.equal(volumes.length, 2);
  assert.equal(volumes[0].title, "Volume 1");
  assert.deepEqual(
    await loadMangaDexChapterImageUrls(volumes[0].id, fetchImpl),
    ["https://node.mangadex.network/data/0123456789abcdef0123456789abcdef/page.jpg"]
  );
});
