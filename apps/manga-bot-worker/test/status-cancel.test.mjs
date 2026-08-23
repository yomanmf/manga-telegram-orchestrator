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
