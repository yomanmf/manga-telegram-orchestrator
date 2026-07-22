import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { registerAnalyticsRoutes, validateEvent } from "../src/analytics.mjs";
import { createStore } from "../src/store.mjs";

test("validates supported analytics events", () => {
  const event = validateEvent({
    eventId: "books:123",
    botId: "my_books_kindle_bot",
    status: "success",
    telegramUserId: 42,
    requestText: "Толстой",
    resultText: "Найдено 10 книг"
  });
  assert.equal(event.telegramUserId, "42");
  assert.equal(event.requestText, "Толстой");
  assert.equal(validateEvent({ eventId: "tetra:abc", botId: "tetra", status: "success", userId: "anon_123" }).userId, "anon_123");
  assert.throws(() => validateEvent({ eventId: "x", botId: "unknown", status: "success" }), /botId/);
  assert.throws(() => validateEvent({ eventId: "x", botId: "tetra", status: "success", userId: "bad id" }), /userId/);
});

test("ingests, updates and renders analytics events behind authentication", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "manga-analytics-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createStore(directory);
  const routes = new Map();
  const app = {
    post(pathname, handler) { routes.set(`POST ${pathname}`, handler); },
    get(pathname, handler) { routes.set(`GET ${pathname}`, handler); }
  };
  registerAnalyticsRoutes(app, {
    store,
    ingestToken: "ingest-secret",
    dashboardUsername: "owner",
    dashboardPassword: "dashboard-secret"
  });
  const unauthorized = responseRecorder();
  routes.get("POST /analytics/events")({ get: () => "", body: {} }, unauthorized);
  assert.equal(unauthorized.statusCode, 401);

  const accepted = responseRecorder();
  routes.get("POST /analytics/events")({
    get: (name) => name === "Authorization" ? "Bearer ingest-secret" : "",
    body: {
      eventId: "news:123",
      botId: "my_news_kindle_bot",
      status: "received",
      telegramUserId: "100",
      username: "reader",
      requestType: "article",
      requestText: "https://example.com"
    }
  }, accepted);
  assert.equal(accepted.statusCode, 202);

  const completed = responseRecorder();
  routes.get("POST /analytics/events")({
    get: (name) => name === "Authorization" ? "Bearer ingest-secret" : "",
    body: {
      eventId: "news:123",
      botId: "my_news_kindle_bot",
      status: "success",
      resultText: "PDF отправлен на Kindle",
      finishedAt: new Date().toISOString(),
      durationMs: 1250
    }
  }, completed);
  assert.equal(completed.statusCode, 202);
  assert.equal(store.getAnalyticsEvent("news:123").requestText, "https://example.com");
  assert.equal(store.getAnalyticsEvent("news:123").status, "success");

  const dashboardUnauthorized = responseRecorder();
  routes.get("GET /analytics")({ get: () => "", query: {} }, dashboardUnauthorized);
  assert.equal(dashboardUnauthorized.statusCode, 401);
  const dashboard = responseRecorder();
  routes.get("GET /analytics")({
    get: (name) => name === "Authorization"
      ? `Basic ${Buffer.from("owner:dashboard-secret").toString("base64")}`
      : "",
    query: {}
  }, dashboard);
  assert.equal(dashboard.typeName, "html");
  const html = dashboard.body;
  assert.match(html, /https:\/\/example\.com/);
  assert.match(html, /PDF отправлен на Kindle/);
  assert.match(html, /reader/);
  assert.match(html, /ReKindle/);
});

function responseRecorder() {
  return {
    statusCode: 200,
    headers: {},
    body: "",
    typeName: "",
    status(value) { this.statusCode = value; return this; },
    set(name, value) { this.headers[name] = value; return this; },
    type(value) { this.typeName = value; return this; },
    json(value) { this.body = value; return this; },
    send(value) { this.body = value; return this; }
  };
}
