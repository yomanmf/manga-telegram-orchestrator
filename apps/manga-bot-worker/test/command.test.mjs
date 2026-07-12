import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

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

test("parses all available chapters with parentheses in the title", () => {
  assert.deepEqual(parseCommand("Отправь One Piece (Color) все главы"), {
    type: "send",
    titleQuery: "One Piece (Color)",
    fromChapter: "first",
    toChapter: "latest"
  });
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

test("selects every available numbered chapter", () => {
  const selected = selectChapterRange([
    { id: "a", title: "Chapter 0.5" },
    { id: "b", title: "Chapter 1" },
    { id: "c", title: "Special without a number" }
  ], "first", "latest");
  assert.deepEqual(selected.map((item) => item.id), ["a", "b"]);
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
  let failedProgressNotification = false;
  const store = createStore(directory);
  const telegram = {
    async sendMessage(chatId, text) {
      if (!failedProgressNotification && /обработано 3\/4 глав/.test(text)) {
        failedProgressNotification = true;
        throw new TypeError("fetch failed");
      }
      messages.push({ chatId, text });
    },
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

  await orchestrator.handleMessage({ chat: { id: 7 }, text: "Отправь One Piece (Color) все главы" });
  await orchestrator.tick();

  const job = store.latestJob("7");
  assert.equal(job.status, "completed");
  assert.equal(job.fromChapter, "first");
  assert.equal(job.toChapter, "latest");
  assert.equal(job.chapterManifest.length, 4);
  assert.deepEqual(processedChapters, ["Chapter 22", "Chapter 23", "Chapter 24", "Chapter 25"]);
  assert.equal(job.kindleJobs.length, 1);
  assert.equal(failedProgressNotification, true);
  const chapterProgress = messages.filter(({ text }) => / обработано \d+\/\d+ глав\./.test(text));
  assert.deepEqual(chapterProgress.map(({ text }) => text.match(/(\d+\/\d+)/)[1]), ["4/4"]);
  assert.ok(messages.some(({ text }) => text.includes("Собираю итоговые PDF")));
  assert.ok(messages.some(({ text }) => text.includes("Передаю в Kindle")));
  assert.match(messages.at(-1).text, /Amazon принял/);
  await assert.rejects(fs.access(`${directory}/work/${job.id}`), /ENOENT/);
});

test("cleans the job workspace after a processing failure", async () => {
  const directory = `/tmp/manga-orchestrator-cleanup-test-${Date.now()}-${Math.random()}`;
  const pdf = await PDFDocument.create();
  pdf.addPage([300, 400]).drawRectangle({ x: 0, y: 0, width: 1, height: 1 });
  const pagePdf = Buffer.from(await pdf.save());
  const store = createStore(directory);
  let processed = 0;
  const orchestrator = new Orchestrator({
    store,
    telegram: { async sendMessage() {}, async answerCallbackQuery() {} },
    mangaApp: {
      async search() { return { results: [{ title: "Cleanup", url: "/cleanup" }] }; },
      async loadSeries() {
        return {
          title: "Cleanup",
          chapters: [
            { id: "one", title: "Chapter 1" },
            { id: "two", title: "Chapter 2" }
          ]
        };
      },
      async processChapter() {
        processed += 1;
        if (processed === 2) throw new Error("processor unavailable");
        return [{ name: "chapter.pdf", bytes: pagePdf }];
      }
    },
    kindle: {
      async enqueueFile() { throw new Error("must not enqueue"); },
      async job() { throw new Error("must not inspect"); },
      async connectToken() { return { url: "https://example.test/connect" }; }
    },
    maxPdfBytes: 10_000_000,
    tempRoot: `${directory}/work`
  });

  await orchestrator.handleMessage({ chat: { id: 8 }, text: "Отправь Cleanup с 1 до 2" });
  await orchestrator.tick();

  const job = store.latestJob("8");
  assert.equal(job.status, "failed");
  assert.match(job.error, /processor unavailable/);
  await assert.rejects(fs.access(`${directory}/work/${job.id}`), /ENOENT/);
});

test("cleans the job workspace after cancellation during processing", async () => {
  const directory = `/tmp/manga-orchestrator-cancel-test-${Date.now()}-${Math.random()}`;
  const pdf = await PDFDocument.create();
  pdf.addPage([300, 400]).drawRectangle({ x: 0, y: 0, width: 1, height: 1 });
  const pagePdf = Buffer.from(await pdf.save());
  const store = createStore(directory);
  const orchestrator = new Orchestrator({
    store,
    telegram: { async sendMessage() {}, async answerCallbackQuery() {} },
    mangaApp: {
      async search() { return { results: [{ title: "Cancel", url: "/cancel" }] }; },
      async loadSeries() {
        return {
          title: "Cancel",
          chapters: [
            { id: "one", title: "Chapter 1" },
            { id: "two", title: "Chapter 2" }
          ]
        };
      },
      async processChapter() {
        store.cancelLatest("9");
        return [{ name: "chapter.pdf", bytes: pagePdf }];
      }
    },
    kindle: {
      async enqueueFile() { throw new Error("must not enqueue"); },
      async job() { throw new Error("must not inspect"); },
      async connectToken() { return { url: "https://example.test/connect" }; }
    },
    maxPdfBytes: 10_000_000,
    tempRoot: `${directory}/work`
  });

  await orchestrator.handleMessage({ chat: { id: 9 }, text: "Отправь Cancel с 1 до 2" });
  await orchestrator.tick();

  const job = store.latestJob("9");
  assert.equal(job.status, "cancelled");
  await assert.rejects(fs.access(`${directory}/work/${job.id}`), /ENOENT/);
});
