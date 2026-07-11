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
