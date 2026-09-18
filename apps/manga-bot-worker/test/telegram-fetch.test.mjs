import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { telegramFetch } from "../src/telegram-fetch.mjs";
import { createTelegram } from "../src/telegram.mjs";

test("retries a blackholed connection without shortening an established long poll", async () => {
  let attempts = 0;
  const telegram = createTelegram("test", {
    retryDelays: [0],
    request: (url, options) => telegramFetch(url, options, {
      connectTimeoutMs: 5,
      request(_url, config, onResponse) {
        attempts += 1;
        assert.equal(config.family, 4);
        const req = new EventEmitter();
        req.destroy = (error) => req.emit("error", error);
        req.end = () => queueMicrotask(() => {
          const socket = new EventEmitter();
          socket.connecting = true;
          req.emit("socket", socket);
          if (attempts === 1) return;
          socket.emit("secureConnect");
          setTimeout(() => {
            const response = new EventEmitter();
            response.statusCode = 200;
            onResponse(response);
            response.emit("data", Buffer.from(JSON.stringify({ ok: true, result: [{ update_id: 42 }] })));
            response.emit("end");
          }, 20);
        });
        return req;
      }
    })
  });
  assert.deepEqual(await telegram.getUpdates(0, 25), [{ update_id: 42 }]);
  assert.equal(attempts, 2);
});
