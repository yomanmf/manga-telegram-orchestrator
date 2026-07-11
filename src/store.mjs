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
        from_chapter, chapter_manifest, choice_manifest, progress,
        kindle_jobs, merge_vertical_pages, error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, String(job.chatId), job.status || "queued", job.titleQuery || null,
      job.seriesUrl || null, job.seriesTitle || null, job.fromChapter || null,
      json(job.chapterManifest || []), json(job.choiceManifest || []),
      job.progress || "", json(job.kindleJobs || []), job.mergeVerticalPages === false ? 0 : 1, job.error || null,
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
      chapterManifest: "chapter_manifest", choiceManifest: "choice_manifest",
      progress: "progress", kindleJobs: "kindle_jobs", error: "error"
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
      chapter_manifest TEXT NOT NULL DEFAULT '[]',
      choice_manifest TEXT NOT NULL DEFAULT '[]',
      progress TEXT NOT NULL DEFAULT '',
      kindle_jobs TEXT NOT NULL DEFAULT '[]',
      merge_vertical_pages INTEGER NOT NULL DEFAULT 1,
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
  `);
  ensureColumn(db, "jobs", "merge_vertical_pages", "INTEGER NOT NULL DEFAULT 1");
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
    chapterManifest: parseJson(row.chapter_manifest, []),
    choiceManifest: parseJson(row.choice_manifest, []),
    kindleJobs: parseJson(row.kindle_jobs, []),
    mergeVerticalPages: row.merge_vertical_pages !== 0
  };
}

function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}
function json(value) { return JSON.stringify(value); }
function now() { return new Date().toISOString(); }
