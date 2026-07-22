import express from "express";
import path from "node:path";

import { registerAnalyticsRoutes } from "./analytics.mjs";
import { boundedInteger } from "./concurrency.mjs";
import { createKindleClient } from "./kindle-client.mjs";
import { createMangaAppClient } from "./manga-app.mjs";
import { Orchestrator } from "./orchestrator.mjs";
import { createStore } from "./store.mjs";
import { createTelegram } from "./telegram.mjs";
import { isOwnerPrivateUpdate } from "./telegram-auth.mjs";

const DEFAULT_MAX_PDF_BYTES = 150_000_000;
const MAX_ALLOWED_PDF_BYTES = 150_000_000;
let shuttingDown = false;

const config = readConfig(process.env);
const missingConfiguration = requiredNames(config);
const ready = missingConfiguration.length === 0;
const store = ready ? createStore(config.dataDir) : null;
const telegram = ready ? createTelegram(config.telegramToken) : null;
const orchestrator = ready ? new Orchestrator({
  store,
  telegram,
  mangaApp: createMangaAppClient({ baseUrl: config.mangaAppUrl, sessionToken: config.mangaAppSessionToken }),
  kindle: createKindleClient({ baseUrl: config.kindleWorkerUrl, sharedSecret: config.kindleSharedSecret }),
  maxPdfBytes: config.maxPdfBytes,
  tempRoot: path.join(config.dataDir, "manga-jobs"),
  chapterProcessingConcurrency: config.chapterProcessingConcurrency,
  epubBuildConcurrency: config.epubBuildConcurrency,
  kindleUploadConcurrency: config.kindleUploadConcurrency
}) : null;

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

if (store) {
  registerAnalyticsRoutes(app, {
    store,
    ingestToken: config.analyticsIngestToken,
    dashboardUsername: config.analyticsDashboardUsername,
    dashboardPassword: config.analyticsDashboardPassword
  });
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    configured: ready,
    missing: missingConfiguration,
    telegramUpdateMode: config.telegramUpdateMode,
    service: "manga-telegram-orchestrator"
  });
});

app.post("/telegram/webhook", async (req, res) => {
  if (!ready) {
    res.status(503).json({ error: "Telegram bot is not configured", missing: missingConfiguration });
    return;
  }
  if (req.get("X-Telegram-Bot-Api-Secret-Token") !== config.webhookSecret) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const update = req.body || {};
  if (!isOwnerPrivateUpdate(update, config.ownerUserId)) {
    console.warn("Rejected Telegram update from unauthorized sender or non-private chat");
    res.sendStatus(200);
    return;
  }
  if (!store.rememberUpdate(update.update_id)) {
    res.sendStatus(200);
    return;
  }
  res.sendStatus(200);
  try {
    await handleTelegramUpdate(update);
  } catch (error) {
    console.error("Telegram update failed", error);
  }
});

app.post("/admin/set-webhook", async (req, res) => {
  if (!ready) {
    res.status(503).json({ error: "Telegram bot is not configured", missing: missingConfiguration });
    return;
  }
  if (!config.adminToken || req.get("Authorization") !== `Bearer ${config.adminToken}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  if (!config.publicBaseUrl) {
    res.status(400).json({ error: "PUBLIC_BASE_URL is not configured" });
    return;
  }
  try {
    const result = await telegram.setWebhook(`${config.publicBaseUrl}/telegram/webhook`, config.webhookSecret);
    res.json({ ok: true, result });
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

const server = app.listen(config.port, () => {
  console.log(`Manga Telegram orchestrator listening on ${config.port}`);
  if (ready) {
    orchestrator.start();
    configureTelegramMenu().catch((error) => console.error("Telegram menu setup failed", error));
    if (config.telegramUpdateMode === "polling") {
      pollTelegram().catch((error) => console.error("Telegram polling stopped", error));
    } else {
      configureWebhook().catch((error) => console.error("Telegram webhook setup failed", error));
    }
  }
  else console.warn(`Setup required. Missing: ${missingConfiguration.join(", ")}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    shuttingDown = true;
    server.close(() => process.exit(0));
  });
}

function readConfig(env) {
  const config = {
    port: Number(env.PORT || 3000),
    dataDir: env.DATA_DIR || "/data",
    telegramToken: optional(env, "TELEGRAM_BOT_TOKEN"),
    telegramUpdateMode: String(env.TELEGRAM_UPDATE_MODE || "polling").trim().toLowerCase(),
    webhookSecret: optional(env, "TELEGRAM_WEBHOOK_SECRET"),
    ownerUserId: optional(env, "TELEGRAM_OWNER_USER_ID") || optional(env, "TELEGRAM_ALLOWED_CHAT_ID"),
    mangaAppUrl: optional(env, "MANGA_APP_URL"),
    mangaAppSessionToken: optional(env, "MANGA_APP_SESSION_TOKEN"),
    kindleWorkerUrl: optional(env, "KINDLE_WORKER_URL"),
    kindleSharedSecret: optional(env, "KINDLE_SHARED_SECRET"),
    publicBaseUrl: String(env.PUBLIC_BASE_URL || "").replace(/\/$/, ""),
    adminToken: env.ADMIN_API_TOKEN || "",
    analyticsIngestToken: optional(env, "ANALYTICS_INGEST_TOKEN"),
    analyticsDashboardUsername: optional(env, "ANALYTICS_DASHBOARD_USERNAME"),
    analyticsDashboardPassword: optional(env, "ANALYTICS_DASHBOARD_PASSWORD"),
    maxPdfBytes: Number(env.MAX_PDF_BYTES || DEFAULT_MAX_PDF_BYTES),
    chapterProcessingConcurrency: boundedInteger(
      env.CHAPTER_PROCESSING_CONCURRENCY,
      1,
      { min: 1, max: 4 }
    ),
    epubBuildConcurrency: boundedInteger(
      env.EPUB_BUILD_CONCURRENCY,
      2,
      { min: 1, max: 4 }
    ),
    kindleUploadConcurrency: boundedInteger(
      env.KINDLE_UPLOAD_CONCURRENCY,
      2,
      { min: 1, max: 4 }
    )
  };
  if (!Number.isFinite(config.maxPdfBytes) || config.maxPdfBytes < 10_000_000 || config.maxPdfBytes > MAX_ALLOWED_PDF_BYTES) {
    throw new Error("MAX_PDF_BYTES must be between 10 MB and 150 MB");
  }
  if (config.ownerUserId && (!/^\d+$/.test(config.ownerUserId) || !Number.isSafeInteger(Number(config.ownerUserId)) || Number(config.ownerUserId) <= 0)) {
    throw new Error("TELEGRAM_OWNER_USER_ID must be a positive Telegram user id");
  }
  if (!["polling", "webhook"].includes(config.telegramUpdateMode)) {
    throw new Error("TELEGRAM_UPDATE_MODE must be polling or webhook");
  }
  return config;
}

function optional(env, name) {
  const value = String(env[name] || "").trim();
  return value;
}

function requiredNames(config) {
  return [
    ["telegramToken", "TELEGRAM_BOT_TOKEN"],
    ["webhookSecret", "TELEGRAM_WEBHOOK_SECRET"],
    ["ownerUserId", "TELEGRAM_OWNER_USER_ID"],
    ["mangaAppUrl", "MANGA_APP_URL"],
    ["mangaAppSessionToken", "MANGA_APP_SESSION_TOKEN"],
    ["kindleWorkerUrl", "KINDLE_WORKER_URL"],
    ["kindleSharedSecret", "KINDLE_SHARED_SECRET"]
  ].filter(([key]) => !config[key]).map(([, name]) => name);
}

async function configureWebhook() {
  if (!config.publicBaseUrl) {
    console.warn("PUBLIC_BASE_URL is not configured; Telegram webhook was not registered");
    return;
  }
  const result = await telegram.setWebhook(`${config.publicBaseUrl}/telegram/webhook`, config.webhookSecret);
  console.log(`Telegram webhook configured: ${result.description || "ok"}`);
}

async function pollTelegram() {
  await telegram.deleteWebhook();
  console.log("Telegram long polling configured");
  let offset = 0;
  while (!shuttingDown) {
    try {
      const updates = await telegram.getUpdates(offset, 25);
      for (const update of updates) {
        offset = Math.max(offset, Number(update.update_id) + 1);
        if (!isOwnerPrivateUpdate(update, config.ownerUserId)) {
          console.warn("Rejected Telegram update from unauthorized sender or non-private chat");
          continue;
        }
        if (!store.rememberUpdate(update.update_id)) continue;
        try {
          await handleTelegramUpdate(update);
        } catch (error) {
          console.error("Telegram update failed", error);
        }
      }
    } catch (error) {
      if (shuttingDown) return;
      console.error("Telegram polling request failed", error);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
}

async function configureTelegramMenu() {
  const result = await telegram.configureMenu();
  console.log(`Telegram command menu configured: ${result.description || "ok"}`);
}

async function handleTelegramUpdate(update) {
  const message = update.message;
  const callback = update.callback_query;
  const sender = message?.from || callback?.from || {};
  const chatId = message?.chat?.id || callback?.message?.chat?.id || sender.id || null;
  const eventId = `manga:${update.update_id}`;
  const startedAt = new Date().toISOString();
  store.upsertAnalyticsEvent({
    eventId,
    botId: "my_manga_kindle_bot",
    requestType: analyticsRequestType(message?.text, callback?.data),
    telegramUserId: sender.id || null,
    username: sender.username || null,
    chatId,
    requestText: message?.text || callback?.data || "",
    status: "received",
    startedAt,
    metadata: { updateId: update.update_id }
  });
  try {
    const result = message
      ? await orchestrator.handleMessage(message, { analyticsEventId: eventId })
      : await orchestrator.handleCallback(callback);
    if (result?.deferred) {
      store.upsertAnalyticsEvent({
        eventId,
        botId: "my_manga_kindle_bot",
        status: "accepted",
        resultText: `Задание ${result.jobId} принято`,
        metadata: { updateId: update.update_id, jobId: result.jobId }
      });
    } else {
      const finishedAt = new Date().toISOString();
      store.upsertAnalyticsEvent({
        eventId,
        botId: "my_manga_kindle_bot",
        status: "success",
        resultText: "Команда обработана",
        finishedAt,
        durationMs: new Date(finishedAt).valueOf() - new Date(startedAt).valueOf()
      });
    }
  } catch (error) {
    const finishedAt = new Date().toISOString();
    store.upsertAnalyticsEvent({
      eventId,
      botId: "my_manga_kindle_bot",
      status: "error",
      errorText: error instanceof Error ? error.message : String(error),
      finishedAt,
      durationMs: new Date(finishedAt).valueOf() - new Date(startedAt).valueOf()
    });
    throw error;
  }
}

function analyticsRequestType(text, callbackData) {
  if (callbackData) return "choice";
  const value = String(text || "").trim();
  if (value.startsWith("/")) return value.split(/\s+/, 1)[0].slice(1).split("@", 1)[0].toLowerCase();
  return "manga_request";
}
