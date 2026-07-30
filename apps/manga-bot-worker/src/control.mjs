import crypto from "node:crypto";

const CONTROL_CHAT_ID = "web:rekindle";
const ACTIVE_STATUSES = ["queued", "resume_pending", "processing", "delivering", "waiting_auth", "waiting_choice"];

export function registerControlRoutes(app, { store, mangaApp, kindle, token }) {
  app.post("/control/:action", async (req, res) => {
    if (!authorized(req.get("Authorization"), token)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    try {
      const action = String(req.params.action || "");
      const body = req.body || {};
      if (action === "search") return res.json(await search(mangaApp, body));
      if (action === "series") return res.json(await series(mangaApp, body));
      if (action === "create") return res.json(create(store, body));
      if (action === "status") return res.json(status(store, body));
      if (action === "cancel") return res.json(cancel(store));
      if (action === "retry") return res.json(retry(store));
      if (action === "kindle-status") return res.json(await kindleStatus(kindle));
      if (action === "kindle-connect") return res.json(await kindle.connectToken());
      res.status(404).json({ error: "Control action not found" });
    } catch (error) {
      res.status(error.status || 400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}

async function search(mangaApp, body) {
  const query = String(body.query || "").trim();
  if (query.length < 2 || query.length > 120) throw routeError(400, "Enter 2 to 120 characters");
  const result = await mangaApp.search(query);
  return { results: Array.isArray(result.results) ? result.results.slice(0, 10) : [] };
}

async function series(mangaApp, body) {
  const value = seriesUrl(body.url);
  const result = await mangaApp.loadSeries(value);
  const chapters = Array.isArray(result.chapters) ? result.chapters : [];
  return {
    title: String(result.title || "Manga").slice(0, 200),
    url: value,
    chapterCount: chapters.length,
    firstChapter: chapters.length ? chapters[0].title : "",
    lastChapter: chapters.length ? chapters.at(-1).title : ""
  };
}

function create(store, body) {
  const existing = store.latestJob(CONTROL_CHAT_ID, ACTIVE_STATUSES);
  if (existing) return { job: publicJob(existing), existing: true };

  const title = String(body.title || "").trim();
  if (!title || title.length > 200) throw routeError(400, "Select a manga title");
  const fromChapter = chapterBoundary(body.fromChapter, "first");
  const toChapter = chapterBoundary(body.toChapter, "latest");
  if (fromChapter !== "first" && toChapter !== "latest" && Number(fromChapter) > Number(toChapter)) {
    throw routeError(400, "The ending chapter must not be before the starting chapter");
  }

  const job = store.createJob({
    chatId: CONTROL_CHAT_ID,
    status: "queued",
    titleQuery: title,
    seriesTitle: title,
    seriesUrl: seriesUrl(body.url),
    fromChapter,
    toChapter,
    mergeVerticalPages: body.mergeVerticalPages !== false,
    progress: "Waiting to start"
  });
  return { job: publicJob(job), existing: false };
}

function status(store, body) {
  const id = String(body.id || "");
  const job = id ? store.getJob(id) : store.latestJob(CONTROL_CHAT_ID);
  return { job: job && job.chatId === CONTROL_CHAT_ID ? publicJob(job) : null };
}

function cancel(store) {
  return { job: publicJob(store.cancelLatest(CONTROL_CHAT_ID)) };
}

function retry(store) {
  return { job: publicJob(store.retryLatest(CONTROL_CHAT_ID)) };
}

async function kindleStatus(kindle) {
  const result = await kindle.status();
  return {
    connected: result.connected === true,
    sessionState: result.sessionState || "unknown",
    counts: result.counts || {}
  };
}

function publicJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    status: job.status,
    title: job.seriesTitle || job.titleQuery,
    fromChapter: job.fromChapter || "first",
    toChapter: job.toChapter || "latest",
    mergeVerticalPages: job.mergeVerticalPages !== false,
    progress: job.progress || "",
    error: job.error || null,
    files: (job.kindleJobs || []).map((item) => ({
      filename: item.filename,
      size: item.size,
      status: item.status
    })),
    createdAt: job.created_at,
    updatedAt: job.updated_at
  };
}

function chapterBoundary(value, fallback) {
  const result = String(value || fallback).trim().toLowerCase().replace(",", ".");
  if (result === fallback || /^\d+(?:\.\d+)?$/.test(result)) return result;
  throw routeError(400, "Chapter boundaries must be numbers");
}

function seriesUrl(value) {
  const result = String(value || "").trim();
  if (!/^https:\/\/weebcentral\.com\/series\/[0-9A-HJKMNP-TV-Z]{26}(?:[/?#].*)?$/i.test(result)) {
    throw routeError(400, "Select a WeebCentral manga");
  }
  return result;
}

function authorized(header, token) {
  if (!token) return false;
  const expected = Buffer.from("Bearer " + token);
  const actual = Buffer.from(String(header || ""));
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function routeError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}
