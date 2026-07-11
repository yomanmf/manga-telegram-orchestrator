import test from "node:test";
import assert from "node:assert/strict";

import { createTelegram, MENU_COMMANDS } from "../src/telegram.mjs";

test("registers the command menu with Telegram", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(options.body) });
    return new Response(JSON.stringify({ ok: true, result: true }), {
      headers: { "Content-Type": "application/json" }
    });
  };

  try {
    await createTelegram("test-token").configureMenu();
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(calls, [
    {
      url: "https://api.telegram.org/bottest-token/setMyCommands",
      body: { commands: MENU_COMMANDS }
    },
    {
      url: "https://api.telegram.org/bottest-token/setChatMenuButton",
      body: { menu_button: { type: "commands" } }
    }
  ]);
});

test("retries a transient Telegram fetch failure", async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    if (attempts === 1) {
      const cause = new Error("socket closed");
      cause.code = "UND_ERR_SOCKET";
      throw new TypeError("fetch failed", { cause });
    }
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
      headers: { "Content-Type": "application/json" }
    });
  };

  try {
    const result = await createTelegram("test-token", { retryDelays: [0] })
      .sendMessage("7", "progress");
    assert.deepEqual(result, { message_id: 1 });
    assert.equal(attempts, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
