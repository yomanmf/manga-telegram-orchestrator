import assert from "node:assert/strict";
import test from "node:test";
import { createAnalyticsReporter, validateBrowserEvent } from "./analytics-reporter.mjs";

test("validates manga web analytics events", () => {
  const event = validateBrowserEvent({
    eventId: "manga_web:job_1", requestType: "manga_download", userId: "manga_web:anon_1",
    requestText: "Berserk chapters 1-3", resultText: "3 PDF files", status: "success", durationMs: 1200
  });
  assert.equal(event.userId, "manga_web:anon_1");
  assert.throws(() => validateBrowserEvent({ eventId: "bad:1", requestType: "x", userId: "u", status: "success" }), /prefix/);
});

test("forwards events with the server-side ingestion token", async () => {
  let forwarded;
  const reporter = createAnalyticsReporter({
    env: { ANALYTICS_URL: "https://analytics.example/", ANALYTICS_INGEST_TOKEN: "secret" },
    fetchImpl: async (url, options) => {
      forwarded = { url, options, body: JSON.parse(options.body) };
      return new Response("{}", { status: 202 });
    }
  });
  assert.equal(await reporter.report({
    eventId: "manga_web:page_1", requestType: "page_view", userId: "manga_web:anon_1",
    requestText: "GET /", resultText: "Page loaded", status: "success"
  }), true);
  assert.equal(forwarded.url, "https://analytics.example/analytics/events");
  assert.equal(forwarded.options.headers.Authorization, "Bearer secret");
  assert.equal(forwarded.body.botId, "manga_web");
});
