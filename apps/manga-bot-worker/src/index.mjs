import express from "express";

import { createKindleClient } from "./kindle-client.mjs";
import { createMangaAppClient } from "./manga-app.mjs";
import { Orchestrator } from "./orchestrator.mjs";
import { createStore } from "./store.mjs";
import { createTelegram } from "./telegram.mjs";

const DEFAULT_MAX_PDF_BYTES = 150_000_000;
const MAX_ALLOWED_PDF_BYTES = 150_000_000;

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
  maxPdfBytes: config.maxPdfBytes
}) : null;

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, configured: ready, missing: missingConfiguration, service: "manga-telegram-orchestrator" });
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
  if (!store.rememberUpdate(update.update_id)) {
    res.sendStatus(200);
    return;
  }
  res.sendStatus(200);
  try {
    const chatId = update.message?.chat?.id ?? update.callback_query?.message?.chat?.id;
    if (String(chatId) !== config.allowedChatId) {
      console.warn("Rejected Telegram update from unauthorized chat", chatId);
      return;
    }
    if (update.message) await orchestrator.handleMessage(update.message);
    if (update.callback_query) await orchestrator.handleCallback(update.callback_query);
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
    configureWebhook().catch((error) => console.error("Telegram webhook setup failed", error));
  }
  else console.warn(`Setup required. Missing: ${missingConfiguration.join(", ")}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

function readConfig(env) {
  const config = {
    port: Number(env.PORT || 3000),
    dataDir: env.DATA_DIR || "/data",
    telegramToken: optional(env, "TELEGRAM_BOT_TOKEN"),
    webhookSecret: optional(env, "TELEGRAM_WEBHOOK_SECRET"),
    allowedChatId: optional(env, "TELEGRAM_ALLOWED_CHAT_ID"),
    mangaAppUrl: optional(env, "MANGA_APP_URL"),
    mangaAppSessionToken: optional(env, "MANGA_APP_SESSION_TOKEN"),
    kindleWorkerUrl: optional(env, "KINDLE_WORKER_URL"),
    kindleSharedSecret: optional(env, "KINDLE_SHARED_SECRET"),
    publicBaseUrl: String(env.PUBLIC_BASE_URL || "").replace(/\/$/, ""),
    adminToken: env.ADMIN_API_TOKEN || "",
    maxPdfBytes: Number(env.MAX_PDF_BYTES || DEFAULT_MAX_PDF_BYTES)
  };
  if (!Number.isFinite(config.maxPdfBytes) || config.maxPdfBytes < 10_000_000 || config.maxPdfBytes > MAX_ALLOWED_PDF_BYTES) {
    throw new Error("MAX_PDF_BYTES must be between 10 MB and 150 MB");
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
    ["allowedChatId", "TELEGRAM_ALLOWED_CHAT_ID"],
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

async function configureTelegramMenu() {
  const result = await telegram.configureMenu();
  console.log(`Telegram command menu configured: ${result.description || "ok"}`);
}
