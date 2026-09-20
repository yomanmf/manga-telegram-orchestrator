import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

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
    kindle: {},
    qbittorrent: {
      async list() { return []; },
      async delete() {}
    },
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

test("does not expose Amazon authentication through web control", async () => {
  const { handler } = setup();
  assert.equal((await call(handler, "kindle-status")).status, 404);
  assert.equal((await call(handler, "kindle-connect")).status, 404);
});

test("lists torrents and deletes their downloaded files through qBittorrent", async () => {
  const deleted = [];
  const { handler } = setup({
    qbittorrent: {
      async list() { return [{ hash: "a".repeat(40), name: "Example" }]; },
      async delete(hash) { deleted.push(hash); }
    }
  });
  assert.equal((await call(handler, "torrents")).body.torrents[0].name, "Example");
  const response = await call(handler, "torrent-delete", { hash: "A".repeat(40) });
  assert.deepEqual(response.body, { ok: true, hash: "a".repeat(40) });
  assert.deepEqual(deleted, ["a".repeat(40)]);
  assert.equal((await call(handler, "torrent-delete", { hash: "../downloads" })).status, 400);
});

test("web jobs reuse the server Kindle uploader without Telegram or email delivery", () => {
  const source = fs.readFileSync(new URL("../src/orchestrator.mjs", import.meta.url), "utf8");
  assert.match(source, /enqueueVolumes[\s\S]*?kindle\.startBatch/);
  assert.match(source, /if \(job && isWebControlJob\(job\)\) return/);
  assert.doesNotMatch(source, /nodemailer|SMTP|emailDelivery/);
});
