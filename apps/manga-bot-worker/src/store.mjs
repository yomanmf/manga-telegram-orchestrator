import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export function createStore(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, "manga-bot.sqlite"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  db.prepare("UPDATE jobs SET status = 'resume_pending', progress = 'Восстановление после перезапуска', updated_at = ? WHERE status = 'processing'")
    .run(now());
  return new Store(db);
}

class Store {
  constructor(db) {
    this.db = db;
  }

  rememberUpdate(updateId) {
    if (!Number.isInteger(Number(updateId))) return true;
    try {
      this.db.prepare("INSERT INTO telegram_updates (update_id, received_at) VALUES (?, ?)")
        .run(Number(updateId), now());
      return true;
    } catch (error) {
      if (String(error.message).includes("UNIQUE")) return false;
      throw error;
    }
  }

  createJob(job) {
    const id = crypto.randomUUID();
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO jobs (
        id, chat_id, status, title_query, series_url, series_title,
        from_chapter, to_chapter, chapter_manifest, choice_manifest, progress,
        kindle_jobs, merge_vertical_pages, analytics_event_id, error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, String(job.chatId), job.status || "queued", job.titleQuery || null,
      job.seriesUrl || null, job.seriesTitle || null, job.fromChapter || null,
      job.toChapter || "latest",
      json(job.chapterManifest || []), json(job.choiceManifest || []),
      job.progress || "", json(job.kindleJobs || []), job.mergeVerticalPages === false ? 0 : 1,
      job.analyticsEventId || null, job.error || null,
      timestamp, timestamp
    );
    return this.getJob(id);
  }

  getJob(id) {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id);
    return row ? hydrateJob(row) : null;
  }

  latestJob(chatId, statuses = null) {
    let sql = "SELECT * FROM jobs WHERE chat_id = ?";
    const params = [String(chatId)];
    if (statuses?.length) {
      sql += ` AND status IN (${statuses.map(() => "?").join(",")})`;
      params.push(...statuses);
    }
    sql += " ORDER BY created_at DESC LIMIT 1";
    const row = this.db.prepare(sql).get(...params);
    return row ? hydrateJob(row) : null;
  }

  nextRunnableJob() {
    const row = this.db.prepare(`
      SELECT * FROM jobs
      WHERE status IN ('queued', 'resume_pending')
      ORDER BY created_at ASC
      LIMIT 1
    `).get();
    return row ? hydrateJob(row) : null;
  }

  nextActiveJob() {
    const row = this.db.prepare(`
      SELECT * FROM jobs
      WHERE status IN ('queued', 'resume_pending', 'delivering', 'waiting_auth')
      ORDER BY CASE status WHEN 'queued' THEN 0 WHEN 'resume_pending' THEN 0 ELSE 1 END, created_at ASC
      LIMIT 1
    `).get();
    return row ? hydrateJob(row) : null;
  }

  listWaitingAuth() {
    return this.db.prepare("SELECT * FROM jobs WHERE status = 'waiting_auth' ORDER BY updated_at ASC")
      .all().map(hydrateJob);
  }

  updateJob(id, patch) {
    const fields = [];
    const values = [];
    const jsonFields = new Set(["chapterManifest", "choiceManifest", "kindleJobs"]);
    const map = {
      status: "status", titleQuery: "title_query", seriesUrl: "series_url",
      seriesTitle: "series_title", fromChapter: "from_chapter",
      toChapter: "to_chapter",
      chapterManifest: "chapter_manifest", choiceManifest: "choice_manifest",
      progress: "progress", kindleJobs: "kindle_jobs", error: "error",
      statusMessageId: "status_message_id"
    };
    for (const [key, value] of Object.entries(patch)) {
      if (!(key in map)) continue;
      fields.push(`${map[key]} = ?`);
      values.push(jsonFields.has(key) ? json(value) : value);
    }
    if (fields.length === 0) return this.getJob(id);
    fields.push("updated_at = ?");
    values.push(now(), id);
    this.db.prepare(`UPDATE jobs SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    return this.getJob(id);
  }

  cancelLatest(chatId) {
    const job = this.latestJob(chatId, ["queued", "resume_pending", "waiting_choice", "waiting_auth", "processing"]);
    if (!job) return null;
    return this.updateJob(job.id, { status: "cancelled", progress: "Отменено пользователем" });
  }

  retryLatest(chatId) {
    const job = this.latestJob(chatId, ["failed", "waiting_auth"]);
    if (!job) return null;
    return this.updateJob(job.id, { status: "resume_pending", error: null, progress: "Повторный запуск" });
  }

  getMergeVerticalPages(chatId) {
    const row = this.db.prepare("SELECT merge_vertical_pages FROM user_settings WHERE chat_id = ?").get(String(chatId));
    return row ? Boolean(row.merge_vertical_pages) : true;
  }

  setMergeVerticalPages(chatId, enabled) {
    this.db.prepare(`
      INSERT INTO user_settings (chat_id, merge_vertical_pages, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET merge_vertical_pages = excluded.merge_vertical_pages, updated_at = excluded.updated_at
    `).run(String(chatId), enabled ? 1 : 0, now());
    return Boolean(enabled);
  }

  upsertAnalyticsEvent(event) {
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO analytics_events (
        event_id, bot_id, request_type, user_id, telegram_user_id, username, chat_id,
        request_text, result_text, status, error_text, started_at, finished_at,
        duration_ms, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(event_id) DO UPDATE SET
        bot_id = excluded.bot_id,
        request_type = COALESCE(excluded.request_type, analytics_events.request_type),
        user_id = COALESCE(excluded.user_id, analytics_events.user_id),
        telegram_user_id = COALESCE(excluded.telegram_user_id, analytics_events.telegram_user_id),
        username = COALESCE(excluded.username, analytics_events.username),
        chat_id = COALESCE(excluded.chat_id, analytics_events.chat_id),
        request_text = COALESCE(excluded.request_text, analytics_events.request_text),
        result_text = COALESCE(excluded.result_text, analytics_events.result_text),
        status = excluded.status,
        error_text = COALESCE(excluded.error_text, analytics_events.error_text),
        started_at = COALESCE(excluded.started_at, analytics_events.started_at),
        finished_at = COALESCE(excluded.finished_at, analytics_events.finished_at),
        duration_ms = COALESCE(excluded.duration_ms, analytics_events.duration_ms),
        metadata = CASE WHEN excluded.metadata = '{}' THEN analytics_events.metadata ELSE excluded.metadata END,
        updated_at = excluded.updated_at
    `).run(
      event.eventId,
      event.botId,
      event.requestType || null,
      event.userId || null,
      event.telegramUserId == null ? null : String(event.telegramUserId),
      event.username || null,
      event.chatId == null ? null : String(event.chatId),
      event.requestText ?? null,
      event.resultText ?? null,
      event.status,
      event.errorText ?? null,
      event.startedAt || timestamp,
      event.finishedAt || null,
      event.durationMs ?? null,
      json(event.metadata || {}),
      timestamp,
      timestamp
    );
    return this.getAnalyticsEvent(event.eventId);
  }

  getAnalyticsEvent(eventId) {
    const row = this.db.prepare("SELECT * FROM analytics_events WHERE event_id = ?").get(eventId);
    return row ? hydrateAnalyticsEvent(row) : null;
  }

  listAnalyticsEvents({ botId = "", days = 30, limit = 500 } = {}) {
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const boundedLimit = Math.min(Math.max(Number(limit) || 500, 1), 2_000);
    const rows = botId
      ? this.db.prepare(`
          SELECT * FROM analytics_events
          WHERE started_at >= ? AND bot_id = ?
          ORDER BY started_at DESC LIMIT ?
        `).all(since, botId, boundedLimit)
      : this.db.prepare(`
          SELECT * FROM analytics_events
          WHERE started_at >= ?
          ORDER BY started_at DESC LIMIT ?
        `).all(since, boundedLimit);
    return rows.map(hydrateAnalyticsEvent);
  }
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS telegram_updates (
      update_id INTEGER PRIMARY KEY,
      received_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      status TEXT NOT NULL,
      title_query TEXT,
      series_url TEXT,
      series_title TEXT,
      from_chapter TEXT,
      to_chapter TEXT NOT NULL DEFAULT 'latest',
      chapter_manifest TEXT NOT NULL DEFAULT '[]',
      choice_manifest TEXT NOT NULL DEFAULT '[]',
      progress TEXT NOT NULL DEFAULT '',
      kindle_jobs TEXT NOT NULL DEFAULT '[]',
      merge_vertical_pages INTEGER NOT NULL DEFAULT 1,
      status_message_id INTEGER,
      analytics_event_id TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS jobs_chat_created_idx ON jobs(chat_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS jobs_status_created_idx ON jobs(status, created_at);
    CREATE TABLE IF NOT EXISTS user_settings (
      chat_id TEXT PRIMARY KEY,
      merge_vertical_pages INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS analytics_events (
      event_id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL,
      request_type TEXT,
      user_id TEXT,
      telegram_user_id TEXT,
      username TEXT,
      chat_id TEXT,
      request_text TEXT,
      result_text TEXT,
      status TEXT NOT NULL,
      error_text TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      duration_ms INTEGER,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS analytics_events_started_idx
      ON analytics_events(started_at DESC);
    CREATE INDEX IF NOT EXISTS analytics_events_bot_started_idx
      ON analytics_events(bot_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS analytics_events_user_started_idx
      ON analytics_events(telegram_user_id, started_at DESC);
  `);
  ensureColumn(db, "jobs", "merge_vertical_pages", "INTEGER NOT NULL DEFAULT 1");
  ensureColumn(db, "jobs", "to_chapter", "TEXT NOT NULL DEFAULT 'latest'");
  ensureColumn(db, "jobs", "status_message_id", "INTEGER");
  ensureColumn(db, "jobs", "analytics_event_id", "TEXT");
  ensureColumn(db, "analytics_events", "user_id", "TEXT");
}

function ensureColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function hydrateJob(row) {
  return {
    ...row,
    chatId: row.chat_id,
    titleQuery: row.title_query,
    seriesUrl: row.series_url,
    seriesTitle: row.series_title,
    fromChapter: row.from_chapter,
    toChapter: row.to_chapter || "latest",
    chapterManifest: parseJson(row.chapter_manifest, []),
    choiceManifest: parseJson(row.choice_manifest, []),
    kindleJobs: parseJson(row.kindle_jobs, []),
    mergeVerticalPages: row.merge_vertical_pages !== 0,
    statusMessageId: row.status_message_id || null,
    analyticsEventId: row.analytics_event_id || null
  };
}

function hydrateAnalyticsEvent(row) {
  return {
    eventId: row.event_id,
    botId: row.bot_id,
    requestType: row.request_type,
    userId: row.user_id,
    telegramUserId: row.telegram_user_id,
    username: row.username,
    chatId: row.chat_id,
    requestText: row.request_text,
    resultText: row.result_text,
    status: row.status,
    errorText: row.error_text,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
    metadata: parseJson(row.metadata, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}
function json(value) { return JSON.stringify(value); }
function now() { return new Date().toISOString(); }
