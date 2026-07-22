import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchWeebCentralImageBytes,
  fetchWeebCentralResponse
} from "./weebcentral-image-fetch.mjs";

test("retries only the timed-out image and returns its bytes", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, signal: options.signal });
    if (calls.length === 1) {
      return new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true
        });
      });
    }
    return new Response(Buffer.from("image"), { status: 200 });
  };

  const result = await fetchWeebCentralImageBytes("https://cdn.example/page-7.jpg", {
    fetchImpl,
    timeoutMs: 10,
    retryDelays: [0]
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://cdn.example/page-7.jpg");
  assert.equal(calls[0].signal.aborted, true);
  assert.equal(result.bytes.toString(), "image");
});

test("the timeout covers a response body that stops downloading", async () => {
  let attempts = 0;
  const fetchImpl = async (_url, options) => {
    attempts += 1;
    return {
      ok: true,
      status: 200,
      async arrayBuffer() {
        return new Promise((resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true
          });
        });
      }
    };
  };

  await assert.rejects(
    fetchWeebCentralImageBytes("https://cdn.example/page-8.jpg", {
      fetchImpl,
      timeoutMs: 10,
      retryDelays: [0, 0]
    }),
    /timed out after 10 ms/
  );
  assert.equal(attempts, 3);
});

test("retries retryable HTTP responses but returns a permanent failure", async () => {
  const statuses = [503, 404];
  const cancelled = [];
  const fetchImpl = async () => {
    const status = statuses.shift();
    return {
      ok: false,
      status,
      body: {
        async cancel() {
          cancelled.push(status);
        }
      }
    };
  };

  const result = await fetchWeebCentralImageBytes("https://cdn.example/page-9.jpg", {
    fetchImpl,
    timeoutMs: 100,
    retryDelays: [0, 0]
  });

  assert.equal(result.response.status, 404);
  assert.equal(result.bytes, null);
  assert.deepEqual(cancelled, [503]);
});

test("honors Retry-After before succeeding after a 429", async () => {
  const delays = [];
  let attempts = 0;
  const result = await fetchWeebCentralResponse("https://weebcentral.com/series", {
    retryDelays: [1_000, 2_000],
    randomImpl: () => 0,
    sleepImpl: async (delay) => delays.push(delay),
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) {
        return new Response("limited", {
          status: 429,
          headers: { "Retry-After": "7" }
        });
      }
      return new Response("series", { status: 200 });
    },
    consume: (response) => response.text()
  });

  assert.equal(attempts, 2);
  assert.deepEqual(delays, [7_000]);
  assert.equal(result.value, "series");
});

test("uses exponential fallback delays for repeated retryable responses", async () => {
  const delays = [];
  let attempts = 0;
  const result = await fetchWeebCentralResponse("https://weebcentral.com/chapter", {
    retryDelays: [1_000, 2_000, 4_000],
    randomImpl: () => 0,
    sleepImpl: async (delay) => delays.push(delay),
    fetchImpl: async () => {
      attempts += 1;
      return new Response(attempts <= 3 ? "busy" : "chapter", {
        status: attempts <= 3 ? 503 : 200
      });
    },
    consume: (response) => response.text()
  });

  assert.equal(attempts, 4);
  assert.deepEqual(delays, [1_000, 2_000, 4_000]);
  assert.equal(result.value, "chapter");
});
