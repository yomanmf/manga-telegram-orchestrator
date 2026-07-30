import test from "node:test";
import assert from "node:assert/strict";

import { registerControlRoutes } from "../src/control.mjs";

function setup(overrides = {}) {
  let handler;
  const app = { post(_path, value) { handler = value; } };
  const jobs = [];
  const store = {
    latestJob() { return jobs.at(-1) || null; },
    getJob(id) { return jobs.find((job) => job.id === id) || null; },
    createJob(value) {
      const job = { ...value, id: "job-1", kindleJobs: [], created_at: "now", updated_at: "now" };
      jobs.push(job);
      return job;
    },
    cancelLatest() { return null; },
    retryLatest() { return null; }
  };
  registerControlRoutes(app, {
    store,
    token: "secret",
    mangaApp: {
      async search() { return { results: [{ title: "The Fable", url: "https://weebcentral.com/series/0123456789ABCDEFGHJKMNPQRS" }] }; },
      async loadSeries(url) { return { title: "The Fable", chapters: [{ id: "chapter", title: "Chapter 1", index: 1 }], url }; }
    },
    kindle: { async status() { return { connected: true, sessionState: "connected", counts: { queued: 0 } }; } },
    ...overrides
  });
  return { handler, jobs };
}

async function call(handler, action, body = {}, authorization = "Bearer secret") {
  let result;
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(value) { result = value; return value; }
  };
  await handler({ params: { action }, body, get() { return authorization; } }, res);
  return { status: res.statusCode, body: result };
}

test("creates a direct web job without a Telegram update", async () => {
  const { handler, jobs } = setup();
  const response = await call(handler, "create", {
    title: "The Fable",
    url: "https://weebcentral.com/series/0123456789ABCDEFGHJKMNPQRS",
    fromChapter: "201",
    toChapter: "latest"
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.job.status, "queued");
  assert.equal(jobs[0].chatId, "web:rekindle");
  assert.equal(jobs[0].fromChapter, "201");
});

test("rejects unauthenticated and reversed chapter requests", async () => {
  const { handler } = setup();
  assert.equal((await call(handler, "status", {}, "")).status, 401);
  const response = await call(handler, "create", {
    title: "The Fable",
    url: "https://weebcentral.com/series/0123456789ABCDEFGHJKMNPQRS",
    fromChapter: "20",
    toChapter: "10"
  });
  assert.equal(response.status, 400);
  assert.match(response.body.error, /ending chapter/i);
});
