import test from "node:test";
import assert from "node:assert/strict";

import { Orchestrator } from "../src/orchestrator.mjs";
import { createStore } from "../src/store.mjs";

test("shows every active job and asks which one to cancel", async () => {
  const directory = `/tmp/manga-status-cancel-test-${Date.now()}-${Math.random()}`;
  const store = createStore(directory);
  const first = store.createJob({ chatId: "7", status: "processing", titleQuery: "First Manga", progress: "Обрабатываю" });
  const second = store.createJob({ chatId: "7", status: "queued", titleQuery: "Second Manga", progress: "В очереди" });
  const sent = [];
  const edited = [];
  const answers = [];
  const orchestrator = new Orchestrator({
    store,
    telegram: {
      async sendMessage(chatId, text, options) {
        sent.push({ chatId, text, options });
        return { message_id: sent.length };
      },
      async editMessage(chatId, messageId, text, options) { edited.push({ chatId, messageId, text, options }); },
      async answerCallbackQuery(id, text) { answers.push({ id, text }); }
    },
    mangaApp: {},
    kindle: {},
    maxPdfBytes: 1
  });

  await orchestrator.sendStatus("7");
  assert.match(sent[0].text, /Активных заданий: 2/);
  assert.match(sent[0].text, /First Manga/);
  assert.match(sent[0].text, /Second Manga/);

  await orchestrator.cancel("7");
  assert.deepEqual(sent[1].options.reply_markup.inline_keyboard.map((row) => row[0].text), ["First Manga", "Second Manga"]);
  assert.equal(store.getJob(first.id).status, "processing");
  assert.equal(store.getJob(second.id).status, "queued");

  await orchestrator.handleCallback({
    id: "cancel-1",
    data: `cancel:${second.id}`,
    message: { message_id: 2, chat: { id: 7 } }
  });
  assert.equal(store.getJob(first.id).status, "processing");
  assert.equal(store.getJob(second.id).status, "cancelled");
  assert.deepEqual(answers, [{ id: "cancel-1", text: "🛑 Отменено" }]);
  assert.deepEqual(edited[0].options, { reply_markup: { inline_keyboard: [] } });
});

test("keeps a delivering job cancelled and its confirmation visible", async () => {
  const directory = `/tmp/manga-delivery-cancel-test-${Date.now()}-${Math.random()}`;
  const store = createStore(directory);
  const job = store.createJob({ chatId: "8", status: "delivering", titleQuery: "Third Manga", progress: "Amazon обрабатывает файлы" });
  const sent = [];
  const edited = [];
  const orchestrator = new Orchestrator({
    store,
    telegram: {
      async sendMessage(chatId, text) {
        sent.push({ chatId, text });
        return { message_id: 1 };
      },
      async editMessage(chatId, messageId, text) { edited.push({ chatId, messageId, text }); }
    },
    mangaApp: {},
    kindle: {},
    maxPdfBytes: 1
  });

  await orchestrator.cancel("8");
  store.updateJob(job.id, { status: "delivering", progress: "Устаревший прогресс" });
  await orchestrator.sendProgress(job.id, "⬇️ Устаревший прогресс");

  assert.equal(store.getJob(job.id).status, "cancelled");
  assert.match(sent[0].text, /Скачивание Third Manga отменено/);
  assert.match(edited[0].text, /Скачивание Third Manga отменено/);
});
