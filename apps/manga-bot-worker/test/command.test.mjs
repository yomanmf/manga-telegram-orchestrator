import test from "node:test";
import assert from "node:assert/strict";

import { parseCommand } from "../src/command.mjs";
import { selectChapterRange } from "../src/chapters.mjs";
import { Orchestrator } from "../src/orchestrator.mjs";
import { createStore } from "../src/store.mjs";
import { PDFDocument } from "pdf-lib";

test("parses Russian Kindle range command", () => {
  assert.deepEqual(parseCommand("Отправь мне на Kindle Fable с главы 201 до самой последней"), {
    type: "send", titleQuery: "Fable", fromChapter: "201", toChapter: "latest"
  });
});

test("parses an inclusive numeric chapter range with parentheses in the title", () => {
  assert.deepEqual(parseCommand("Отправь One Piece (Color) с 23 до 100"), {
    type: "send",
    titleQuery: "One Piece (Color)",
    fromChapter: "23",
    toChapter: "100"
  });
  assert.throws(
    () => parseCommand("Отправь One Piece (Color) с 100 до 23"),
    /Конечная глава/
  );
});

test("parses Merge vertical pages commands", () => {
  assert.deepEqual(parseCommand("/merge"), { type: "merge", enabled: null });
  assert.deepEqual(parseCommand("/merge on"), { type: "merge", enabled: true });
  assert.deepEqual(parseCommand("/merge off"), { type: "merge", enabled: false });
});

test("uses chapter labels rather than list position", () => {
  const selected = selectChapterRange([
    { id: "a", title: "Chapter 199" },
    { id: "b", title: "Chapter 201" },
    { id: "c", title: "Extra 202" }
  ], "201");
  assert.deepEqual(selected.map((item) => item.id), ["b", "c"]);
});

test("selects both ends of a numeric chapter range inclusively", () => {
  const selected = selectChapterRange([
    { id: "a", title: "Chapter 22" },
    { id: "b", title: "Chapter 23" },
    { id: "c", title: "Chapter 99.5" },
    { id: "d", title: "Chapter 100" },
    { id: "e", title: "Chapter 101" }
  ], "23", "100");
  assert.deepEqual(selected.map((item) => item.id), ["b", "c", "d"]);
});

test("deduplicates Telegram updates and persists jobs", () => {
  const directory = `/tmp/manga-store-test-${Date.now()}-${Math.random()}`;
  const store = createStore(directory);
  assert.equal(store.rememberUpdate(42), true);
  assert.equal(store.rememberUpdate(42), false);
  const job = store.createJob({ chatId: "7", status: "queued", titleQuery: "Fable", fromChapter: "23", toChapter: "100" });
  assert.equal(store.latestJob("7").id, job.id);
  assert.equal(job.mergeVerticalPages, true);
  assert.equal(job.fromChapter, "23");
  assert.equal(job.toChapter, "100");
  assert.equal(store.getMergeVerticalPages("7"), true);
  store.setMergeVerticalPages("7", false);
  assert.equal(store.getMergeVerticalPages("7"), false);
});

test("runs a Telegram request through PDF assembly and Kindle confirmation", async () => {
  const directory = `/tmp/manga-orchestrator-test-${Date.now()}-${Math.random()}`;
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([300, 400]);
  page.drawRectangle({ x: 0, y: 0, width: 1, height: 1 });
  const pagePdf = Buffer.from(await pdf.save());
  const messages = [];
  const processedChapters = [];
  const store = createStore(directory);
  const telegram = {
    async sendMessage(chatId, text) { messages.push({ chatId, text }); },
    async answerCallbackQuery() {}
  };
  const mangaApp = {
    async search() { return { results: [{ title: "One Piece (Color)", url: "/one-piece-color" }] }; },
    async loadSeries() {
      return {
        title: "One Piece (Color)",
        chapters: [
          { id: "ch-22", title: "Chapter 22" },
          { id: "ch-23", title: "Chapter 23" },
          { id: "ch-24", title: "Chapter 24" },
          { id: "ch-25", title: "Chapter 25" }
        ]
      };
    },
    async processChapter({ chapterTitle, shouldMerge }) {
      assert.equal(shouldMerge, true);
      processedChapters.push(chapterTitle);
      return [{ name: "chapter.pdf", bytes: pagePdf }];
    }
  };
  const kindle = {
    async enqueueFile() { return { id: "kindle-job-1", status: "queued" }; },
    async job() { return { job: { status: "sent" } }; },
    async connectToken() { return { url: "https://example.test/connect" }; }
  };
  const orchestrator = new Orchestrator({
    store, telegram, mangaApp, kindle, maxPdfBytes: 10_000_000,
    tempRoot: `${directory}/work`
  });

  await orchestrator.handleMessage({ chat: { id: 7 }, text: "Отправь One Piece (Color) с 23 до 24" });
  await orchestrator.tick();

  const job = store.latestJob("7");
  assert.equal(job.status, "completed");
  assert.equal(job.toChapter, "24");
  assert.equal(job.chapterManifest.length, 2);
  assert.deepEqual(processedChapters, ["Chapter 23", "Chapter 24"]);
  assert.equal(job.kindleJobs.length, 1);
  assert.match(messages.at(-1).text, /Amazon подтвердил/);
});
