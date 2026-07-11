import test from "node:test";
import assert from "node:assert/strict";

import { parseCommand } from "../src/command.mjs";
import { selectChapterRange } from "../src/chapters.mjs";
import { createStore } from "../src/store.mjs";

test("parses Russian Kindle range command", () => {
  assert.deepEqual(parseCommand("Отправь мне на Kindle Fable с главы 201 до самой последней"), {
    type: "send", titleQuery: "Fable", fromChapter: "201", to: "latest"
  });
});

test("uses chapter labels rather than list position", () => {
  const selected = selectChapterRange([
    { id: "a", title: "Chapter 199" },
    { id: "b", title: "Chapter 201" },
    { id: "c", title: "Extra 202" }
  ], "201");
  assert.deepEqual(selected.map((item) => item.id), ["b", "c"]);
});

test("deduplicates Telegram updates and persists jobs", () => {
  const directory = `/tmp/manga-store-test-${Date.now()}-${Math.random()}`;
  const store = createStore(directory);
  assert.equal(store.rememberUpdate(42), true);
  assert.equal(store.rememberUpdate(42), false);
  const job = store.createJob({ chatId: "7", status: "queued", titleQuery: "Fable", fromChapter: "201" });
  assert.equal(store.latestJob("7").id, job.id);
});
