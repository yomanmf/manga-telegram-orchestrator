import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import {
  DeleteObjectCommand,
  GetObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import express from "express";
import { chromium } from "playwright";
import { WebSocketServer } from "ws";

import {
  evaluateBatchPageText,
  evaluateSubmissionEvidence,
  firstNewEvidence,
  normalizeLoadedJob,
  shouldFinalizeBatchAcknowledgement
} from "./submission.mjs";
import {
  CHROMIUM_SINGLETON_FILES,
  isChromiumProfileLockError
} from "./chromium-profile.mjs";
import { validateResumableChunk } from "./upload-progress.mjs";
import {
  normalizeKindlePdfFileName
} from "./kindle-filename.mjs";
import { canRecycleIdleUploader } from "./idle-recycle.mjs";

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || "/data";
const PROFILE_DIR = path.join(DATA_DIR, "amazon-profile");
const QUEUE_PATH = path.join(DATA_DIR, "kindle-queue.json");
const SESSION_STATE_PATH = path.join(
  DATA_DIR,
  "kindle-session-state.json"
);
const DIAGNOSTICS_DIR = path.join(
  DATA_DIR,
  "kindle-diagnostics"
);
const TEMP_DIR = "/tmp/kindle-uploads";
const SEND_TO_KINDLE_URL =
  "https://www.amazon.com/sendtokindle";
const MAX_FILE_SIZE = 200_000_000;
const BROWSER_IDLE_MS = Number(
  process.env.BROWSER_IDLE_MS || 60_000
);
const IDLE_RECYCLE_MS = Math.max(
  30_000,
  Number(process.env.IDLE_RECYCLE_MS || 120_000)
);
const BATCH_ACK_SETTLE_MS = Math.max(
  15_000,
  Number(process.env.BATCH_ACK_SETTLE_MS || 60_000)
);
const SHARED_SECRET = requiredEnv("KINDLE_SHARED_SECRET");
const PUBLIC_BASE_URL = requiredEnv("PUBLIC_BASE_URL")
  .replace(/\/$/, "");
const APP_ORIGIN = requiredEnv("APP_ORIGIN")
  .replace(/\/$/, "");

const s3 = new S3Client({
  region: process.env.AWS_DEFAULT_REGION || "auto",
  endpoint: requiredEnv("AWS_ENDPOINT_URL"),
  forcePathStyle:
    process.env.AWS_S3_URL_STYLE !== "virtual-host",
  credentials: {
    accessKeyId: requiredEnv("AWS_ACCESS_KEY_ID"),
    secretAccessKey: requiredEnv("AWS_SECRET_ACCESS_KEY")
  }
});
const bucketName = requiredEnv("AWS_S3_BUCKET_NAME");

await fsp.mkdir(DATA_DIR, { recursive: true });
await fsp.mkdir(PROFILE_DIR, { recursive: true });
await fsp.mkdir(DIAGNOSTICS_DIR, { recursive: true });
await fsp.mkdir(TEMP_DIR, { recursive: true });

let queue = await loadQueue();
const savedSessionState = await loadSessionState();
let queueWrite = Promise.resolve();
let sessionWrite = Promise.resolve();
let browserContext = null;
let browserPage = null;
let browserStarting = null;
let browserClosing = null;
let browserIdleTimer = null;
let uploaderRecycleTimer = null;
let recycleEligible = false;
let displayRuntimeStarting = null;
let displayRuntimeStopping = null;
let xvfbProcess = null;
let fluxboxProcess = null;
let vncProcess = null;
let queueRunning = false;
let activeVncConnections = 0;
let kindleConnected = savedSessionState.connected;
let lastSessionCheck = savedSessionState.lastSessionCheck;
let lastWorkerError = "";

const uploadTickets = new Map();
const connectTokens = new Map();

const app = express();
app.disable("x-powered-by");

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.use(
  "/novnc",
  requireConnectToken,
  express.static("/usr/share/novnc", {
    fallthrough: false,
    maxAge: "1h"
  })
);

app.get("/connect", (req, res) => {
  const token = String(req.query.token || "");
  const record = connectTokens.get(token);

  if (!record || record.expiresAt < Date.now()) {
    res.status(403).send("Connection link expired");
    return;
  }

  res.setHeader(
    "Set-Cookie",
    "kindle_connect=" + encodeURIComponent(token) +
      "; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=600"
  );
  res.type("html").send(connectPage(token));
});

app.get("/connect/check", requireConnectToken, async (_req, res) => {
  try {
    const connected = await checkKindleSession();
    if (connected) {
      kickQueue();
    }
    res.json({ connected, url: safePageUrl() });
  } catch (error) {
    res.status(500).json({
      connected: false,
      error: errorMessage(error)
    });
  }
});

app.get("/api/status", requireApiSecret, async (_req, res) => {
  const counts = countQueueStatuses();
  res.json({
    connected: kindleConnected,
    sessionState:
      lastSessionCheck
        ? (kindleConnected ? "connected" : "needs_auth")
        : "unknown",
    browserRunning: isBrowserRunning(),
    displayRuntimeRunning: isDisplayRuntimeRunning(),
    vncRunning: isVncServerRunning(),
    lastSessionCheck,
    browserUrl: safePageUrl(),
    workerError: lastWorkerError,
    counts,
    recent: queue.slice(-20).reverse().map(publicJob)
  });
});

app.get("/api/jobs/:id", requireApiSecret, async (req, res) => {
  const id = String(req.params.id || "");
  const job = queue.find((item) => item.id === id);

  if (!job) {
    res.status(404).json({ error: "Kindle job not found" });
    return;
  }

  res.json({ job: publicJob(job) });
});

app.get(
  "/api/jobs/:id/evidence",
  requireApiSecret,
  async (req, res) => {
    const id = String(req.params.id || "");
    const job = queue.find((item) => item.id === id);

    if (!job) {
      res.status(404).json({ error: "Kindle job not found" });
      return;
    }
    if (!isBrowserRunning()) {
      res.status(409).json({ error: "Kindle browser is not running" });
      return;
    }

    try {
      const page = pickBestBrowserPage() || browserPage;
      const evidence = await collectKindleEvidence(
        page,
        job.filename
      );
      res.json({ job: publicJob(job), evidence });
    } catch (error) {
      res.status(500).json({ error: errorMessage(error) });
    }
  }
);

app.post("/api/cleanup-smoke-tests", requireApiSecret, async (_req, res) => {
  const removed = await cleanupSmokeTestJobs();

  res.json({
    removed,
    counts: countQueueStatuses()
  });
});

app.post("/api/connect-token", requireApiSecret, async (_req, res) => {
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + 10 * 60 * 1000;
  connectTokens.set(token, { expiresAt });
  pruneTokens(connectTokens);

  try {
    await ensureBrowser();
    await ensureVncServer();
    await ensureSendToKindlePage();

    res.json({
      url: PUBLIC_BASE_URL + "/connect?token=" +
        encodeURIComponent(token),
      expiresAt: new Date(expiresAt).toISOString()
    });
  } catch (error) {
    connectTokens.delete(token);
    scheduleBrowserCloseIfIdle();
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.post(
  "/api/tickets",
  requireApiSecret,
  express.json({ limit: "64kb" }),
  (req, res) => {
    const requestedFilename = String(req.body?.filename || "").trim();
    const size = Number(req.body?.size);
    const batchId = normalizeBatchId(req.body?.batchId);
    const deferQueue = Boolean(req.body?.deferQueue);

    if (deferQueue && !batchId) {
      res.status(400).json({
        error: "deferQueue requires a valid batchId"
      });
      return;
    }

    if (!requestedFilename.toLowerCase().endsWith(".pdf")) {
      res.status(400).json({ error: "Only PDF files are supported" });
      return;
    }
    const filename = normalizeKindlePdfFileName(requestedFilename);
    if (!Number.isFinite(size) || size <= 0 || size > MAX_FILE_SIZE) {
      res.status(400).json({
        error: "File must be between 1 byte and 200 MB"
      });
      return;
    }

    const id = crypto.randomUUID();
    const token = crypto.randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + 30 * 60 * 1000;
    uploadTickets.set(id, {
      id,
      token,
      filename,
      size,
      batchId,
      deferQueue,
      receivedBytes: 0,
      partPath: path.join(TEMP_DIR, id + ".upload-part"),
      expiresAt
    });
    pruneTokens(uploadTickets);

    res.json({
      jobId: id,
      uploadUrl:
        PUBLIC_BASE_URL + "/upload/" + id +
        "?token=" + encodeURIComponent(token),
      statusUrl:
        PUBLIC_BASE_URL + "/upload/" + id +
        "/status?token=" + encodeURIComponent(token),
      expiresAt: new Date(expiresAt).toISOString()
    });
  }
);

app.post(
  "/api/batches/:batchId/start",
  requireApiSecret,
  async (req, res) => {
    const batchId = normalizeBatchId(req.params.batchId);
    if (!batchId) {
      res.status(400).json({ error: "Invalid batchId" });
      return;
    }

    const jobs = queue.filter((job) => job.batchId === batchId);
    if (jobs.length === 0) {
      res.status(404).json({ error: "Batch not found" });
      return;
    }

    const startedAt = new Date().toISOString();
    let changed = false;
    for (const job of jobs) {
      if (!job.batchStartedAt) {
        job.batchStartedAt = startedAt;
        changed = true;
      }
      if (job.status === "failed") {
        job.status = "queued";
        job.attempts = 0;
        job.error = "";
        job.resumeVerification = Boolean(job.submittedAt);
        job.updatedAt = startedAt;
        changed = true;
      }
    }
    if (changed) {
      await saveQueue();
    }
    kickQueue();

    res.json({
      batchId,
      jobs: jobs.map(publicJob)
    });
  }
);

app.options("/upload/:id", (req, res) => {
  setUploadCors(req, res);
  res.status(204).end();
});

app.get("/upload/:id/status", async (req, res) => {
  setUploadCors(req, res);

  const ticket = validUploadTicket(req);
  if (!ticket) {
    res.status(403).json({ error: "Upload ticket expired" });
    return;
  }

  if (ticket.completedJob) {
    res.json({
      receivedBytes: ticket.size,
      size: ticket.size,
      complete: true,
      job: publicJob(ticket.completedJob)
    });
    return;
  }

  await syncTicketReceivedBytes(ticket);
  res.json({
    receivedBytes: ticket.receivedBytes,
    size: ticket.size,
    complete: false
  });
});

app.put("/upload/:id", async (req, res) => {
  setUploadCors(req, res);

  const ticket = validUploadTicket(req);
  if (!ticket) {
    res.status(403).json({ error: "Upload ticket expired" });
    return;
  }

  if (ticket.completedJob) {
    res.status(200).json({ job: publicJob(ticket.completedJob) });
    return;
  }

  if (req.query.offset !== undefined) {
    await handleResumableUpload(req, res, ticket);
    return;
  }

  const id = ticket.id;

  if (ticket.inProgress) {
    res.status(409).json({ error: "Upload already in progress" });
    return;
  }

  ticket.inProgress = true;

  const objectKey =
    "kindle-queue/" + id + "/" + ticket.filename;

  let receivedBytes = 0;
  req.on("data", (chunk) => {
    receivedBytes += chunk.length;
    if (receivedBytes > ticket.size || receivedBytes > MAX_FILE_SIZE) {
      req.destroy(new Error("Upload exceeded declared size"));
    }
  });

  try {
    const upload = new Upload({
      client: s3,
      params: {
        Bucket: bucketName,
        Key: objectKey,
        Body: req,
        ContentType: "application/pdf"
      },
      queueSize: 2,
      partSize: 10 * 1024 * 1024,
      leavePartsOnError: false
    });

    await upload.done();

    if (receivedBytes !== ticket.size) {
      await safeDeleteObject(objectKey);
      throw new Error(
        "Upload size mismatch: expected " + ticket.size +
          ", received " + receivedBytes
      );
    }

    const job = {
      id,
      key: objectKey,
      filename: ticket.filename,
      size: ticket.size,
      batchId: ticket.batchId || null,
      batchStartedAt: ticket.deferQueue
        ? null
        : ticket.batchId
          ? new Date().toISOString()
          : null,
      status: "queued",
      attempts: 0,
      error: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    queue.push(job);
    await saveQueue();
    uploadTickets.delete(id);
    kickQueue();

    res.status(201).json({ job: publicJob(job) });
  } catch (error) {
    ticket.inProgress = false;
    console.error("Upload failed", error);
    res.status(500).json({ error: errorMessage(error) });
  }
});

function validUploadTicket(req) {
  const id = String(req.params.id || "");
  const token = String(req.query.token || "");
  const ticket = uploadTickets.get(id);
  return ticket &&
    ticket.token === token &&
    ticket.expiresAt >= Date.now()
    ? ticket
    : null;
}

async function syncTicketReceivedBytes(ticket) {
  try {
    const stat = await fsp.stat(ticket.partPath);
    ticket.receivedBytes = Math.min(stat.size, ticket.size);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    ticket.receivedBytes = 0;
  }
}

async function handleResumableUpload(req, res, ticket) {
  await syncTicketReceivedBytes(ticket);

  const offset = Number(req.query.offset);
  const contentLength = Number(req.headers["content-length"]);
  const range = validateResumableChunk({
    offset,
    receivedBytes: ticket.receivedBytes,
    totalSize: ticket.size,
    contentLength
  });

  if (!range.ok) {
    res.status(range.status).json({
      error: range.error,
      receivedBytes: ticket.receivedBytes,
      size: ticket.size
    });
    return;
  }

  if (ticket.inProgress) {
    res.status(409).json({
      error: "Upload already in progress",
      receivedBytes: ticket.receivedBytes,
      size: ticket.size
    });
    return;
  }

  ticket.inProgress = true;
  try {
    if (!range.finalizeOnly) {
      await pipeline(
        req,
        fs.createWriteStream(ticket.partPath, {
          flags: ticket.receivedBytes === 0 ? "w" : "a"
        })
      );
      await syncTicketReceivedBytes(ticket);

      if (ticket.receivedBytes !== offset + contentLength) {
        throw new Error(
          "Upload chunk size mismatch: expected " +
            (offset + contentLength) +
          ", received " + ticket.receivedBytes
        );
      }
      ticket.expiresAt = Date.now() + 30 * 60 * 1000;
    }

    if (ticket.receivedBytes < ticket.size) {
      res.status(202).json({
        receivedBytes: ticket.receivedBytes,
        size: ticket.size,
        complete: false
      });
      return;
    }

    const job = await finalizeResumableUpload(ticket);
    res.status(201).json({
      receivedBytes: ticket.size,
      size: ticket.size,
      complete: true,
      job: publicJob(job)
    });
  } catch (error) {
    await syncTicketReceivedBytes(ticket).catch(() => {});
    console.error("Resumable upload failed", ticket.id, error);
    if (!res.headersSent && !res.destroyed) {
      res.status(500).json({
        error: errorMessage(error),
        receivedBytes: ticket.receivedBytes,
        size: ticket.size
      });
    }
  } finally {
    ticket.inProgress = false;
  }
}

async function finalizeResumableUpload(ticket) {
  if (ticket.completedJob) return ticket.completedJob;

  const objectKey =
    "kindle-queue/" + ticket.id + "/" + ticket.filename;
  const upload = new Upload({
    client: s3,
    params: {
      Bucket: bucketName,
      Key: objectKey,
      Body: fs.createReadStream(ticket.partPath),
      ContentType: "application/pdf"
    },
    queueSize: 2,
    partSize: 10 * 1024 * 1024,
    leavePartsOnError: false
  });

  await upload.done();

  const job = {
    id: ticket.id,
    key: objectKey,
    filename: ticket.filename,
    size: ticket.size,
    batchId: ticket.batchId || null,
    batchStartedAt: ticket.deferQueue
      ? null
      : ticket.batchId
        ? new Date().toISOString()
        : null,
    status: "queued",
    attempts: 0,
    error: "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  queue.push(job);
  await saveQueue();
  ticket.completedJob = job;
  await fsp.rm(ticket.partPath, { force: true });
  kickQueue();
  return job;
}

app.use((error, _req, res, _next) => {
  console.error("Unhandled request error", error);
  if (!res.headersSent) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

const server = http.createServer(app);
const vncWebSocketServer = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url || "/", "http://localhost");
  if (url.pathname !== "/websockify") {
    socket.destroy();
    return;
  }

  const token =
    url.searchParams.get("token") ||
    cookieValue(request.headers.cookie, "kindle_connect");
  const record = connectTokens.get(String(token || ""));

  if (!record || record.expiresAt < Date.now()) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }

  vncWebSocketServer.handleUpgrade(
    request,
    socket,
    head,
    (webSocket) => {
      vncWebSocketServer.emit("connection", webSocket, request);
    }
  );
});

vncWebSocketServer.on("connection", (webSocket) => {
  activeVncConnections += 1;
  clearBrowserIdleTimer();

  const vncSocket = net.createConnection({
    host: "127.0.0.1",
    port: 5900
  });

  let connectionClosed = false;
  const finishConnection = () => {
    if (connectionClosed) return;
    connectionClosed = true;
    activeVncConnections = Math.max(
      0,
      activeVncConnections - 1
    );
    scheduleBrowserCloseIfIdle();
  };

  vncSocket.on("data", (data) => {
    if (webSocket.readyState === 1) {
      webSocket.send(data);
    }
  });
  webSocket.on("message", (data) => {
    vncSocket.write(data);
  });
  webSocket.on("close", () => {
    finishConnection();
    vncSocket.destroy();
  });
  webSocket.on("error", () => {
    finishConnection();
    vncSocket.destroy();
  });
  vncSocket.on("close", () => {
    finishConnection();
    webSocket.close();
  });
  vncSocket.on("error", () => {
    finishConnection();
    webSocket.close();
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("Kindle uploader listening on port", PORT);
  void cleanupSmokeTestJobs()
    .then(() => runQueue())
    .catch((error) => {
      lastWorkerError = errorMessage(error);
      console.error("Queue startup failed", error);
    });
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("Received " + signal + ", stopping Kindle runtime");
  clearBrowserIdleTimer();
  clearUploaderRecycleTimer();
  try {
    await browserContext?.close();
  } catch (error) {
    console.error("Cannot close Chromium during shutdown", error);
  }
  browserContext = null;
  browserPage = null;
  await stopDisplayRuntime();
  await Promise.allSettled([queueWrite, sessionWrite]);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10_000).unref();
}

process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
process.once("SIGINT", () => { void shutdown("SIGINT"); });

setInterval(() => {
  pruneTokens(uploadTickets);
  pruneTokens(connectTokens);
  kickQueue();
  scheduleBrowserCloseIfIdle();
  scheduleUploaderRecycleIfIdle();
}, 30_000).unref();

async function ensureBrowser() {
  if (browserClosing) {
    await browserClosing;
  }

  clearBrowserIdleTimer();
  clearUploaderRecycleTimer();
  recycleEligible = false;

  if (browserContext && browserPage && !browserPage.isClosed()) {
    browserPage = pickBestBrowserPage() || browserPage;
    return browserPage;
  }
  if (browserContext) {
    browserPage =
      pickBestBrowserPage() ||
      await browserContext.newPage();
    browserPage.setDefaultTimeout(30_000);
    browserPage.setDefaultNavigationTimeout(90_000);
    return browserPage;
  }
  if (browserStarting) {
    return browserStarting;
  }

  browserStarting = (async () => {
    console.log("Starting Chromium for Kindle work");
    await ensureDisplayRuntime();
    const context = await launchKindleBrowser();

    browserContext = context;
    const pages = context.pages();
    browserPage = pickBestBrowserPage() || pages[0] || await context.newPage();
    browserPage.setDefaultTimeout(30_000);
    browserPage.setDefaultNavigationTimeout(90_000);

    context.on("close", () => {
      if (browserContext === context) {
        browserContext = null;
        browserPage = null;
        clearBrowserIdleTimer();
      }
    });

    return browserPage;
  })();

  try {
    return await browserStarting;
  } finally {
    browserStarting = null;
  }
}

async function launchKindleBrowser() {
  const options = {
    headless: false,
    viewport: { width: 1400, height: 820 },
    acceptDownloads: false,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled"
    ]
  };

  try {
    return await chromium.launchPersistentContext(PROFILE_DIR, options);
  } catch (error) {
    if (!isChromiumProfileLockError(error)) throw error;
    await clearStaleChromiumLocks();
    console.warn("Removed stale Chromium profile locks; retrying browser startup");
    return chromium.launchPersistentContext(PROFILE_DIR, options);
  }
}

async function clearStaleChromiumLocks() {
  await Promise.all(CHROMIUM_SINGLETON_FILES.map((name) =>
    fsp.rm(path.join(PROFILE_DIR, name), { force: true })
  ));
}

function displayProcessRunning(process) {
  return Boolean(process && process.exitCode === null && !process.killed);
}

function isDisplayRuntimeRunning() {
  return displayProcessRunning(xvfbProcess) &&
    displayProcessRunning(fluxboxProcess);
}

function isVncServerRunning() {
  return displayProcessRunning(vncProcess);
}

function startDisplayProcess(command, args, label) {
  const child = spawn(command, args, {
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, DISPLAY: ":99" }
  });
  child.stderr.on("data", (chunk) => {
    console.error(label + ":", String(chunk).trim());
  });
  child.on("error", (error) => {
    lastWorkerError = label + " could not start: " + errorMessage(error);
    console.error(lastWorkerError);
  });
  child.on("exit", (code, signal) => {
    console.log(label + " exited", { code, signal });
  });
  return child;
}

async function ensureDisplayRuntime() {
  if (displayRuntimeStopping) {
    await displayRuntimeStopping;
  }
  if (isDisplayRuntimeRunning()) {
    return;
  }
  if (displayRuntimeStarting) {
    return displayRuntimeStarting;
  }

  displayRuntimeStarting = (async () => {
    await stopDisplayRuntime();
    console.log("Starting X display runtime for Kindle work");
    xvfbProcess = startDisplayProcess("Xvfb", [
      ":99", "-screen", "0", "1440x900x24", "-nolisten", "tcp"
    ], "Xvfb");
    await waitForDisplay();
    fluxboxProcess = startDisplayProcess(
      "fluxbox",
      ["-display", ":99"],
      "Fluxbox"
    );
    await waitForProcess(fluxboxProcess, "Fluxbox");
  })();

  try {
    await displayRuntimeStarting;
  } catch (error) {
    await stopDisplayRuntime();
    throw error;
  } finally {
    displayRuntimeStarting = null;
  }
}

async function ensureVncServer() {
  await ensureDisplayRuntime();
  if (isVncServerRunning()) {
    return;
  }
  vncProcess = startDisplayProcess("x11vnc", [
    "-display", ":99", "-forever", "-shared", "-nopw", "-localhost",
    "-rfbport", "5900"
  ], "x11vnc");
  await waitForProcess(vncProcess, "x11vnc");
}

async function waitForDisplay() {
  const socketPath = "/tmp/.X11-unix/X99";
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(socketPath)) {
      return;
    }
    if (!displayProcessRunning(xvfbProcess)) {
      throw new Error("Xvfb exited before the display became ready");
    }
    await delay(50);
  }
  throw new Error("Xvfb did not make display :99 ready in time");
}

async function waitForProcess(child, label) {
  await delay(150);
  if (!displayProcessRunning(child)) {
    throw new Error(label + " exited while starting");
  }
}

async function stopDisplayRuntime() {
  if (displayRuntimeStopping) {
    return displayRuntimeStopping;
  }
  displayRuntimeStopping = (async () => {
    await stopDisplayProcess(vncProcess, "x11vnc");
    vncProcess = null;
    await stopDisplayProcess(fluxboxProcess, "Fluxbox");
    fluxboxProcess = null;
    await stopDisplayProcess(xvfbProcess, "Xvfb");
    xvfbProcess = null;
  })();
  try {
    await displayRuntimeStopping;
  } finally {
    displayRuntimeStopping = null;
  }
}

async function stopDisplayProcess(child, label) {
  if (!displayProcessRunning(child)) {
    return;
  }
  await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 5_000);
    timeout.unref();
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill("SIGTERM");
  });
  console.log("Stopped " + label);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isBrowserRunning() {
  return Boolean(browserContext);
}

function clearBrowserIdleTimer() {
  if (!browserIdleTimer) return;
  clearTimeout(browserIdleTimer);
  browserIdleTimer = null;
}

function hasLiveConnectTokens() {
  pruneTokens(connectTokens);
  return connectTokens.size > 0;
}

function scheduleBrowserCloseIfIdle() {
  if (
    browserIdleTimer ||
    !isBrowserRunning()
  ) return;

  browserIdleTimer = setTimeout(() => {
    browserIdleTimer = null;
    void closeBrowserIfIdle().catch((error) => {
      lastWorkerError = errorMessage(error);
      console.error("Cannot close idle browser", error);
    });
  }, BROWSER_IDLE_MS);
  browserIdleTimer.unref();
}

async function closeBrowserIfIdle() {
  if (
    !isBrowserRunning() ||
    browserStarting ||
    browserClosing ||
    queueRunning ||
    activeVncConnections > 0 ||
    hasLiveConnectTokens() ||
    nextQueueJob()
  ) {
    scheduleBrowserCloseIfIdle();
    return false;
  }

  const context = browserContext;
  browserClosing = context.close();

  try {
    await browserClosing;
    if (browserContext === context) {
      browserContext = null;
      browserPage = null;
    }
    await stopDisplayRuntime();
    console.log("Closed idle Chromium");
    recycleEligible = true;
    scheduleUploaderRecycleIfIdle();
    return true;
  } finally {
    browserClosing = null;
  }
}

function clearUploaderRecycleTimer() {
  if (!uploaderRecycleTimer) return;
  clearTimeout(uploaderRecycleTimer);
  uploaderRecycleTimer = null;
}

function scheduleUploaderRecycleIfIdle() {
  if (
    uploaderRecycleTimer ||
    !recycleEligible ||
    shuttingDown
  ) return;

  uploaderRecycleTimer = setTimeout(() => {
    uploaderRecycleTimer = null;
    void recycleUploaderIfIdle().catch((error) => {
      lastWorkerError = errorMessage(error);
      console.error("Cannot recycle idle Kindle uploader", error);
      scheduleUploaderRecycleIfIdle();
    });
  }, IDLE_RECYCLE_MS);
  uploaderRecycleTimer.unref();
}

async function recycleUploaderIfIdle() {
  pruneTokens(uploadTickets);
  pruneTokens(connectTokens);

  const canRecycle = canRecycleIdleUploader({
    recycleEligible,
    shuttingDown,
    browserRunning: isBrowserRunning(),
    browserStarting: Boolean(browserStarting),
    browserClosing: Boolean(browserClosing),
    displayRuntimeRunning: isDisplayRuntimeRunning(),
    vncRunning: isVncServerRunning(),
    queueRunning,
    hasPendingQueueJob: Boolean(nextQueueJob()),
    activeVncConnections,
    uploadTicketCount: uploadTickets.size,
    connectTokenCount: connectTokens.size
  });

  if (!canRecycle) {
    scheduleUploaderRecycleIfIdle();
    return false;
  }

  console.log("Recycling idle Kindle uploader to release Chromium memory");
  await shutdown("idle recycle");
  return true;
}

function pickBestBrowserPage() {
  if (!browserContext) {
    return null;
  }

  const pages = browserContext.pages()
    .filter((page) => !page.isClosed());

  return pages.find((page) => /sendtokindle/i.test(page.url())) ||
    pages.find((page) => /amazon\./i.test(page.url())) ||
    pages[0] ||
    null;
}

async function ensureSendToKindlePage() {
  await ensureBrowser();
  const page = pickBestBrowserPage() || browserPage;
  browserPage = page;

  if (!/amazon\./i.test(page.url())) {
    await page.goto(SEND_TO_KINDLE_URL, {
      waitUntil: "domcontentloaded"
    });
  }
  return page;
}

async function checkKindleSession() {
  const page = await ensureSendToKindlePage();
  const url = page.url();
  const title = await page.title().catch(() => "");
  const inputCount = await page.locator('input[type="file"]')
    .count()
    .catch(() => 0);
  const bodyText = await page.locator("body")
    .innerText({ timeout: 5_000 })
    .catch(() => "");

  const isSignInPage =
    /signin|ap\/signin/i.test(url) ||
    await page.locator('input[type="password"], #ap_email, #ap_password')
      .count()
      .then((count) => count > 0)
      .catch(() => false);
  const hasUploadSurface =
    inputCount > 0 ||
    /file upload|drag and drop files here|select files from device|ready to send|drop or add more files|add to your library|remove all/i
      .test(bodyText);
  const looksLikeSendToKindle =
    /send\s*to\s*kindle/i.test(url) ||
    /send\s*to\s*kindle/i.test(title) ||
    hasUploadSurface;

  kindleConnected = !isSignInPage &&
    /amazon\./i.test(url) &&
    looksLikeSendToKindle &&
    hasUploadSurface;
  lastSessionCheck = new Date().toISOString();
  if (kindleConnected) {
    lastWorkerError = "";
  }
  await saveSessionState();
  return kindleConnected;
}

function kickQueue() {
  void runQueue().catch((error) => {
    lastWorkerError = errorMessage(error);
    console.error("Queue run failed", error);
    scheduleBrowserCloseIfIdle();
  });
}

async function runQueue() {
  if (queueRunning) {
    return;
  }

  queueRunning = true;
  try {
    while (true) {
      const job = nextQueueJob();

      if (!job) {
        return;
      }

      if (!await checkKindleSession()) {
        await markJobWaitingForAuth(job);
        return;
      }

      try {
        if (job.batchId) {
          await processQueueBatch(job.batchId);
        } else {
          await processQueueJob(job);
        }
      } catch (error) {
        const affectedJobs = job.batchId
          ? queue.filter((item) =>
            item.batchId === job.batchId &&
            ["queued", "processing", "verifying"].includes(item.status)
          )
          : [job];
        for (const affectedJob of affectedJobs) {
          await recordQueueJobFailure(affectedJob, error);
        }

        if (!kindleConnected || affectedJobs.some((item) => item.status === "failed")) {
          return;
        }
      }
    }
  } finally {
    queueRunning = false;
    scheduleBrowserCloseIfIdle();
  }
}

function nextQueueJob() {
  return queue.find((item) =>
    item.status === "queued" &&
    (!item.batchId || item.batchStartedAt)
  ) ||
    (kindleConnected
      ? queue.find((item) => item.status === "waiting_auth")
      : null) ||
    queue.find((item) =>
      item.status === "failed" && item.attempts < 3
    );
}

async function markJobWaitingForAuth(job) {
  job.status = "waiting_auth";
  job.updatedAt = new Date().toISOString();
  await saveQueue();
}

async function processQueueJob(job) {
  if (
    job.resumeVerification &&
    job.submittedAt
  ) {
    if (!job.verificationBaseline) {
      await finalizeVerifiedJob(job, {
        status: "submitted",
        row: "Recovered a legacy submitted job without delivery evidence"
      });
      return;
    }
    job.status = "verifying";
    job.resumeVerification = false;
    job.error = "";
    job.updatedAt = new Date().toISOString();
    await saveQueue();

    const page = await ensureBrowser();
    await page.goto(SEND_TO_KINDLE_URL, {
      waitUntil: "domcontentloaded"
    });

    try {
      const evidence = await waitForAmazonLibraryConfirmation(
        page,
        job.filename,
        job.verificationBaseline
      );
      await finalizeVerifiedJob(job, evidence);
    } catch (error) {
      await saveKindleDiagnostic(page, job, error);
      throw error;
    }
    return;
  }

  job.status = "processing";
  job.attempts += 1;
  job.error = "";
  job.amazonStatus = "";
  job.verificationEvidence = null;
  job.updatedAt = new Date().toISOString();
  await saveQueue();

  const jobTempDir = path.join(TEMP_DIR, job.id);
  await fsp.mkdir(jobTempDir, { recursive: true });
  const tempPath = path.join(
    jobTempDir,
    sanitizeFileName(job.filename)
  );

  try {
    await downloadObject(job.key, tempPath);
    const evidence = await uploadFileToKindle(
      tempPath,
      job
    );
    job.verificationEvidence = evidence;
  } finally {
    await fsp.rm(jobTempDir, {
      recursive: true,
      force: true
    });
  }

  await finalizeVerifiedJob(
    job,
    job.verificationEvidence
  );
}

async function processQueueBatch(batchId) {
  const jobs = queue
    .filter((item) =>
      item.batchId === batchId &&
      item.batchStartedAt &&
      ["queued", "processing", "verifying"].includes(item.status)
    )
    .sort((left, right) =>
      String(left.createdAt).localeCompare(String(right.createdAt))
    );

  if (jobs.length === 0) return;

  const submittedJobs = jobs.filter((job) => job.submittedAt);
  if (submittedJobs.length > 0) {
    if (submittedJobs.length !== jobs.length) {
      throw new Error("Kindle batch has an incomplete submission state");
    }
    await verifySubmittedBatch(jobs);
    return;
  }

  for (const job of jobs) {
    job.status = "processing";
    job.attempts += 1;
    job.error = "";
    job.amazonStatus = "";
    job.verificationEvidence = null;
    job.updatedAt = new Date().toISOString();
  }
  await saveQueue();

  const batchTempDir = path.join(TEMP_DIR, "batch-" + sanitizeFileName(batchId));
  await fsp.mkdir(batchTempDir, { recursive: true });
  const files = [];

  try {
    for (const job of jobs) {
      const jobTempDir = path.join(batchTempDir, sanitizeFileName(job.id));
      await fsp.mkdir(jobTempDir, { recursive: true });
      const tempPath = path.join(jobTempDir, sanitizeFileName(job.filename));
      await downloadObject(job.key, tempPath);
      files.push({ job, tempPath });
    }

    const evidence = await uploadFilesToKindle(
      files.map((item) => item.tempPath),
      jobs
    );
    for (const job of jobs) {
      await finalizeVerifiedJob(job, evidence.get(job.id));
    }
  } finally {
    await fsp.rm(batchTempDir, {
      recursive: true,
      force: true
    });
  }
}

async function verifySubmittedBatch(jobs) {
  const page = await ensureBrowser();
  await page.goto(SEND_TO_KINDLE_URL, {
    waitUntil: "domcontentloaded"
  });

  const evidence = await waitForAmazonBatchConfirmation(page, jobs);
  for (const job of jobs) {
    await finalizeVerifiedJob(job, evidence.get(job.id));
  }
}

async function finalizeVerifiedJob(job, evidence) {
  await safeDeleteObject(job.key);
  job.amazonStatus = evidence?.status || "in_library";
  job.verificationEvidence = evidence;
  job.verifiedAt = new Date().toISOString();
  job.status = "sent";
  job.sentAt = job.verifiedAt;
  job.updatedAt = job.sentAt;
  await saveQueue();
  console.log(
    "Kindle job delivery accepted by Amazon",
    job.id,
    job.filename,
    job.amazonStatus
  );
}

async function recordQueueJobFailure(job, error) {
  const message = errorMessage(error);
  console.error("Kindle job failed", job.id, message);

  if (error?.code === "AUTH_REQUIRED") {
    kindleConnected = false;
    job.status = "waiting_auth";
    await saveSessionState();
  } else {
    job.status = job.attempts >= 3 ? "failed" : "queued";
    if (job.status === "queued" && job.submittedAt && job.verificationBaseline) {
      job.resumeVerification = true;
    }
  }
  job.error = message;
  job.updatedAt = new Date().toISOString();
  lastWorkerError = message;
  await saveQueue();
}

async function uploadFileToKindle(filePath, job) {
  const filename = job.filename;
  const page = await ensureBrowser();
  await page.goto(SEND_TO_KINDLE_URL, {
    waitUntil: "domcontentloaded"
  });

  await clearExistingKindleFiles(page);

  const fileInput = page.locator('input[type="file"]');
  if (await fileInput.count() > 0) {
    await fileInput.first().setInputFiles(filePath);
  } else {
    const selectFileButton =
      page.getByText(/select files from device/i);

    if (await selectFileButton.count() === 0) {
      throw authRequired();
    }

    const fileChooserPromise =
      page.waitForEvent("filechooser", {
        timeout: 30_000
      });

    await selectFileButton.first().click();

    const fileChooser =
      await fileChooserPromise;

    await fileChooser.setFiles(filePath);
  }

  await waitForKindleFileReady(page, filename);
  await requireAddToLibrary(page);

  const baseline = await collectKindleEvidence(
    page,
    filename
  );
  job.verificationBaseline = baseline;
  job.updatedAt = new Date().toISOString();
  await saveQueue();

  await clickKindleSendButton(page);

  job.status = "verifying";
  job.submittedAt = new Date().toISOString();
  job.updatedAt = job.submittedAt;
  await saveQueue();
  console.log(
    "Kindle job submitted to Amazon; waiting for submission acknowledgement",
    job.id,
    filename
  );

  try {
    return await waitForAmazonLibraryConfirmation(
      page,
      filename,
      baseline
    );
  } catch (error) {
    await saveKindleDiagnostic(page, job, error);
    throw error;
  }
}

async function uploadFilesToKindle(filePaths, jobs) {
  const page = await ensureBrowser();
  await page.goto(SEND_TO_KINDLE_URL, {
    waitUntil: "domcontentloaded"
  });

  let baselines;
  try {
    await clearExistingKindleFiles(page);
    await selectKindleFiles(page, filePaths);
    await ensureKindleFileDetails(page, jobs);
    baselines = await waitForKindleFilesReady(page, jobs);
    await requireAddToLibrary(page);
  } catch (error) {
    await saveKindleDiagnostic(page, jobs[0], error);
    throw error;
  }

  for (const job of jobs) {
    job.verificationBaseline = baselines.get(job.id);
  }
  await saveQueue();

  await clickKindleSendButton(page);

  const submittedAt = new Date().toISOString();
  for (const job of jobs) {
    job.status = "verifying";
    job.submittedAt = submittedAt;
    job.updatedAt = submittedAt;
  }
  await saveQueue();
  console.log(
    "Kindle batch submitted to Amazon; waiting for delivery acknowledgement",
    jobs.map((job) => job.filename).join(", ")
  );

  try {
    return await waitForAmazonBatchConfirmation(page, jobs);
  } catch (error) {
    await saveKindleDiagnostic(page, jobs[0], error);
    throw error;
  }
}

async function selectKindleFiles(page, filePaths) {
  const fileInput = page.locator('input[type="file"]');
  if (await fileInput.count() > 0) {
    const multiple = await fileInput.first().getAttribute("multiple");
    if (multiple !== null) {
      await fileInput.first().setInputFiles(filePaths);
      return;
    }
    await fileInput.first().setInputFiles(filePaths[0]);
    filePaths = filePaths.slice(1);
    await page.waitForTimeout(500);
  }

  for (const filePath of filePaths) {
    const selectFileButton = page.getByText(
      /select files from device|drop or add more files|add more files/i
    );
    let visibleButton = null;
    const buttonCount = await selectFileButton.count();
    for (let index = 0; index < buttonCount; index += 1) {
      const candidate = selectFileButton.nth(index);
      if (await candidate.isVisible().catch(() => false)) {
        visibleButton = candidate;
        break;
      }
    }
    if (!visibleButton) {
      throw authRequired();
    }

    const fileChooserPromise = page.waitForEvent("filechooser", {
      timeout: 30_000
    });
    await visibleButton.click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(filePath);
    await page.waitForTimeout(500);
  }
}

async function ensureKindleFileDetails(page, jobs) {
  for (const job of jobs) {
    const filename = job.filename;
    const filenameElement = page.getByText(filename, { exact: true }).first();
    await filenameElement.waitFor({
      state: "visible",
      timeout: 120_000
    });
    let titleInput = await findTitleInputForFile(page, filename);
    if (!titleInput) {
      await toggleKindleFileDetails(filenameElement);
      await page.waitForTimeout(250);
      titleInput = await findTitleInputForFile(page, filename);
    }

    if (!titleInput) {
      console.log("Kindle title input is not available yet", filename);
      continue;
    }
    const title = filename.replace(/\.pdf$/i, "").slice(0, 200);
    await titleInput.click();
    await titleInput.press("Control+A");
    await titleInput.pressSequentially(title, { delay: 5 });
    await titleInput.press("Tab");
    const authorInput = await firstVisibleLocator(
      page.locator('input[aria-label^="Author" i]')
    );
    if (authorInput) {
      await authorInput.click();
      await authorInput.press("Control+A");
      await authorInput.pressSequentially("Personal Document", { delay: 5 });
      await authorInput.press("Tab");
    }
    const originalLayout = await firstVisibleLocator(
      page.locator(
        'input[type="radio"][aria-label^="Keep original layout" i]'
      )
    );
    if (originalLayout && !(await originalLayout.isChecked())) {
      await originalLayout.check();
    }
    await page.waitForTimeout(1_000);
    console.log("Kindle file title updated", filename);
    await toggleKindleFileDetails(filenameElement);
    await page.waitForTimeout(150);
  }
}

async function firstVisibleLocator(locator) {
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    if (await candidate.isVisible().catch(() => false)) {
      return candidate;
    }
  }
  return null;
}

async function toggleKindleFileDetails(filenameElement) {
  const toggled = await filenameElement.evaluate((element) => {
    const filenameRect = element.getBoundingClientRect();
    let container = element;
    for (let depth = 0; container && depth < 10; depth += 1) {
      const controls = Array.from(
        container.querySelectorAll('button, [role="button"]')
      ).filter((control) => {
        const rect = control.getBoundingClientRect();
        const style = window.getComputedStyle(control);
        return rect.width > 0 &&
          rect.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.right <= filenameRect.left + 24;
      });
      if (controls.length > 0) {
        controls.sort((left, right) =>
          right.getBoundingClientRect().right -
          left.getBoundingClientRect().right
        );
        controls[0].click();
        return true;
      }
      container = container.parentElement;
    }
    return false;
  });
  if (!toggled) {
    throw new Error("Amazon file details toggle was not found");
  }
}

async function findTitleInputForFile(page, filename) {
  const titleInputs = page.getByLabel(/title/i);
  const count = await titleInputs.count();
  let fallback = null;
  for (let index = 0; index < count; index += 1) {
    const candidate = titleInputs.nth(index);
    if (!(await candidate.isVisible().catch(() => false))) continue;
    if (!String(await candidate.inputValue()).trim()) {
      fallback ||= candidate;
    }
    const belongsToFile = await candidate.evaluate((input, expected) => {
      let element = input;
      for (let depth = 0; element && depth < 10; depth += 1) {
        const text = String(element.textContent || "")
          .replace(/\s+/g, " ")
          .trim();
        if (text.includes(expected)) return true;
        element = element.parentElement;
      }
      return false;
    }, filename);
    if (belongsToFile) return candidate;
  }
  if (fallback) return fallback;

  const textInputs = page.locator(
    'input[type="text"], input:not([type])'
  );
  const textInputCount = await textInputs.count();
  for (let index = 0; index < textInputCount; index += 1) {
    const candidate = textInputs.nth(index);
    if (!(await candidate.isVisible().catch(() => false))) continue;
    if (String(await candidate.inputValue()).trim()) continue;
    const isTitleInput = await candidate.evaluate((input) => {
      let element = input;
      for (let depth = 0; element && depth < 6; depth += 1) {
        const text = String(element.textContent || "")
          .replace(/\s+/g, " ")
          .trim();
        if (/title(?: \(required\))?/i.test(text)) return true;
        element = element.parentElement;
      }
      return false;
    });
    if (isTitleInput) return candidate;
  }
  return null;
}

async function waitForKindleFileReady(page, filename) {
  const deadline = Date.now() + 120_000;

  while (Date.now() < deadline) {
    if (/signin|ap\/signin/i.test(page.url())) {
      throw authRequired();
    }

    const evidence = await collectKindleEvidence(page, filename);
    if (evidence.readyRows.length > 0) {
      return evidence;
    }
    if (evidence.failureRows.length > 0) {
      throw new Error(evidence.failureRows[0]);
    }

    await page.waitForTimeout(1_000);
  }

  throw new Error(
    "Amazon did not finish preparing the selected PDF"
  );
}

async function waitForKindleFilesReady(page, jobs) {
  const deadline = Date.now() + 20 * 60_000;
  const filenames = jobs.map((job) => job.filename);
  let nextProgressLog = 0;

  while (Date.now() < deadline) {
    if (/signin|ap\/signin/i.test(page.url())) {
      throw authRequired();
    }

    const batch = await collectKindleBatchEvidence(page, filenames);
    if (batch.ready && await isKindleSendEnabled(page)) {
      const evidence = new Map();
      for (const job of jobs) {
        evidence.set(
          job.id,
          await collectKindleEvidence(page, job.filename)
        );
      }
      return evidence;
    }
    if (batch.failureRows.length > 0) {
      const titleFailure = batch.failureRows.find((row) =>
        /title is required|file detail error/i.test(row)
      );
      if (titleFailure) {
        console.log(
          "Kindle batch requires file titles; filling details"
        );
        await ensureKindleFileDetails(page, jobs);
        await page.waitForTimeout(500);
        continue;
      }
      throw new Error(batch.failureRows[0]);
    }
    if (Date.now() >= nextProgressLog) {
      console.log(
        "Kindle batch preparation progress",
        `${batch.presentFilenames.length}/${filenames.length} files visible`,
        batch.missingFilenames.length > 0
          ? `waiting for: ${batch.missingFilenames.join(", ")}`
          : "waiting for Amazon Ready to Send"
      );
      nextProgressLog = Date.now() + 15_000;
    }

    await page.waitForTimeout(1_000);
  }

  throw new Error(
    "Amazon did not finish preparing the selected PDF batch within 20 minutes"
  );
}

async function isKindleSendEnabled(page) {
  const candidates = [
    page.getByRole("button", { name: /^send$/i }),
    page.locator('button:has-text("Send")'),
    page.locator('input[type="button"][value="Send"]'),
    page.locator('input[type="submit"][value="Send"]')
  ];
  for (const locator of candidates) {
    const count = await locator.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index);
      if (!(await candidate.isVisible().catch(() => false))) continue;
      if (!(await candidate.isEnabled().catch(() => false))) continue;
      if (await candidate.getAttribute("aria-disabled") === "true") continue;
      return true;
    }
  }
  return false;
}

async function waitForAmazonBatchConfirmation(page, jobs) {
  const deadline = Date.now() + 15 * 60_000;
  const filenames = jobs.map((job) => job.filename);
  const confirmed = new Map();
  let acknowledgedAt = 0;

  while (Date.now() < deadline) {
    if (/signin|ap\/signin/i.test(page.url())) {
      throw authRequired();
    }

    const batch = await collectKindleBatchEvidence(page, filenames);
    if (batch.failureRows.length > 0) {
      throw new Error(batch.failureRows[0]);
    }

    for (const job of jobs) {
      if (confirmed.has(job.id)) continue;
      const baseline = job.verificationBaseline || {
        readyRows: [],
        inLibraryRows: [],
        failureRows: []
      };
      const current = await collectKindleEvidence(page, job.filename);
      const newFailure = firstNewEvidence(
        current.failureRows,
        baseline.failureRows
      );
      if (newFailure) throw new Error(newFailure);
      const newInLibrary = firstNewEvidence(
        current.inLibraryRows,
        baseline.inLibraryRows
      );
      if (newInLibrary) {
        confirmed.set(job.id, {
          status: "in_library",
          row: newInLibrary
        });
      }
    }

    if (
      batch.inLibrary &&
      !batch.ready &&
      batch.presentFilenames.length === filenames.length
    ) {
      for (const job of jobs) {
        if (!confirmed.has(job.id)) {
          confirmed.set(job.id, {
            status: "in_library",
            row: "Amazon showed the complete batch In library"
          });
        }
      }
    }

    if (confirmed.size === jobs.length) return confirmed;

    if (!batch.ready) {
      acknowledgedAt ||= Date.now();
    } else {
      acknowledgedAt = 0;
    }

    if (shouldFinalizeBatchAcknowledgement({
      acknowledgedAt,
      now: Date.now(),
      settleMs: BATCH_ACK_SETTLE_MS
    })) {
      for (const job of jobs) {
        if (!confirmed.has(job.id)) {
          confirmed.set(job.id, {
            status: "submitted",
            row: "Amazon kept the complete Ready to Send batch cleared"
          });
        }
      }
      return confirmed;
    }

    await page.waitForTimeout(1_500);
  }

  if (acknowledgedAt) {
    for (const job of jobs) {
      if (!confirmed.has(job.id)) {
        confirmed.set(job.id, {
          status: "submitted",
          row: "Amazon cleared the complete Ready to Send batch"
        });
      }
    }
    return confirmed;
  }

  throw new Error(
    "Amazon did not acknowledge the submitted PDF batch within 15 minutes"
  );
}

async function collectKindleBatchEvidence(page, filenames) {
  const snapshot = await page.evaluate((expectedFilenames) => {
    const normalize = (value) => String(value || "")
      .replace(/\s+/g, " ")
      .trim();
    const bodyText = normalize(document.body?.innerText || "");
    const failurePattern =
      /could not be sent|failed|file detail error|please fix errors before sending|unsupported|rejected/i;
    const expected = expectedFilenames.map(normalize);
    const failureRows = Array.from(document.querySelectorAll("body *"))
      .filter((element) => {
        const text = normalize(element.textContent);
        if (!text || text.length > 500 || !failurePattern.test(text)) {
          return false;
        }
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        if (
          rect.width <= 0 ||
          rect.height <= 0 ||
          style.display === "none" ||
          style.visibility === "hidden"
        ) {
          return false;
        }
        if (Array.from(element.children).some((child) =>
          failurePattern.test(normalize(child.textContent)) &&
          child.getBoundingClientRect().width > 0 &&
          child.getBoundingClientRect().height > 0
        )) {
          return false;
        }
        return expected.some((filename) => text.includes(filename)) ||
          !/\.pdf\b/i.test(text);
      })
      .map((element) => normalize(element.textContent));

    return {
      bodyText,
      failureRows: Array.from(new Set(failureRows))
    };
  }, filenames);
  return {
    ...evaluateBatchPageText(snapshot.bodyText, filenames),
    failureRows: snapshot.failureRows
  };
}

async function requireAddToLibrary(page) {
  const checkboxes = page.getByLabel(
    /add to (your )?library/i
  );
  const count = await checkboxes.count();
  let visibleCheckbox = null;

  for (let index = 0; index < count; index += 1) {
    const candidate = checkboxes.nth(index);
    if (await candidate.isVisible().catch(() => false)) {
      visibleCheckbox = candidate;
      break;
    }
  }

  if (!visibleCheckbox) {
    throw new Error(
      "Amazon Add to your library checkbox was not found"
    );
  }

  if (!(await visibleCheckbox.isChecked())) {
    await visibleCheckbox.check();
  }

  if (!(await visibleCheckbox.isChecked())) {
    throw new Error(
      "Amazon Add to your library checkbox is not enabled"
    );
  }

  for (let index = 0; index < count; index += 1) {
    const candidate = checkboxes.nth(index);
    if (!(await candidate.isVisible().catch(() => false))) continue;
    if (!(await candidate.isChecked())) {
      await candidate.check();
    }
    if (!(await candidate.isChecked())) {
      throw new Error(
        "Amazon Add to your library checkbox is not enabled"
      );
    }
  }
}

async function waitForAmazonLibraryConfirmation(
  page,
  filename,
  baseline
) {
  const deadline = Date.now() + 15 * 60_000;

  while (Date.now() < deadline) {
    if (/signin|ap\/signin/i.test(page.url())) {
      throw authRequired();
    }

    const evidence = await collectKindleEvidence(page, filename);
    const newFailure = firstNewEvidence(
      evidence.failureRows,
      baseline.failureRows
    );
    if (newFailure) {
      throw new Error(newFailure);
    }

    const newInLibrary = firstNewEvidence(
      evidence.inLibraryRows,
      baseline.inLibraryRows
    );
    if (newInLibrary) {
      return {
        status: "in_library",
        row: newInLibrary
      };
    }

    await page.waitForTimeout(1_500);
  }

  throw new Error(
    "Amazon did not confirm the PDF as In Library within 15 minutes"
  );
}

async function collectKindleEvidence(page, filename) {
  return page.evaluate((expectedFilename) => {
    const normalize = (value) =>
      String(value || "")
        .replace(/\s+/g, " ")
        .trim();
    const expected = normalize(expectedFilename);
    const filenameElements = Array.from(
      document.querySelectorAll("body *")
    ).filter((element) => {
      const text = normalize(element.textContent);
      if (
        !text.includes(expected) ||
        text.length > expected.length + 120
      ) {
        return false;
      }

      return !Array.from(element.children).some((child) =>
        normalize(child.textContent).includes(expected)
      );
    });

    const rowsFor = (pattern) => {
      const rows = [];

      const statusElements = Array.from(
        document.querySelectorAll("body *")
      ).filter((element) => {
        const text = normalize(element.textContent);
        if (!text || text.length > 200 || !pattern.test(text)) {
          return false;
        }

        return !Array.from(element.children).some((child) =>
          pattern.test(normalize(child.textContent))
        );
      });

      for (const filenameElement of filenameElements) {
        let candidate = filenameElement;
        let foundAncestor = false;

        for (let depth = 0; candidate && depth < 9; depth += 1) {
          const text = normalize(candidate.innerText);
          if (text.length > 2_000) {
            break;
          }
          const pdfReferences =
            text.match(/\.pdf\b/gi) || [];
          if (pdfReferences.length > 1) {
            break;
          }
          if (text.includes(expected) && pattern.test(text)) {
            rows.push(text);
            foundAncestor = true;
            break;
          }
          candidate = candidate.parentElement;
        }

        if (foundAncestor) {
          continue;
        }

        const filenameRect =
          filenameElement.getBoundingClientRect();
        if (filenameRect.width <= 0 || filenameRect.height <= 0) {
          continue;
        }
        const filenameCenterY =
          filenameRect.top + filenameRect.height / 2;

        for (const statusElement of statusElements) {
          const statusRect =
            statusElement.getBoundingClientRect();
          if (statusRect.width <= 0 || statusRect.height <= 0) {
            continue;
          }

          const statusCenterY =
            statusRect.top + statusRect.height / 2;
          const sameVisualRow =
            Math.abs(statusCenterY - filenameCenterY) <=
              Math.max(
                10,
                Math.min(
                  filenameRect.height,
                  statusRect.height
                )
              );
          const statusIsBesideFilename =
            statusRect.left >= filenameRect.left - 20;

          if (sameVisualRow && statusIsBesideFilename) {
            rows.push(
              expected + " " +
                normalize(statusElement.textContent)
            );
            break;
          }
        }
      }

      return rows;
    };

    return {
      readyRows: rowsFor(/ready to send/i),
      inLibraryRows: rowsFor(/\bin library\b/i),
      failureRows: rowsFor(
        /could not be sent|failed|file detail error|please fix errors before sending|unsupported|rejected/i
      )
    };
  }, filename);
}

async function saveKindleDiagnostic(page, job, error) {
  const stamp = new Date().toISOString()
    .replace(/[:.]/g, "-");
  const base = path.join(
    DIAGNOSTICS_DIR,
    sanitizeFileName(job.id + "-" + stamp)
  );

  try {
    await page.screenshot({
      path: base + ".png",
      fullPage: true
    });
    const evidence = await collectKindleEvidence(
      page,
      job.filename
    ).catch(() => ({
      readyRows: [],
      inLibraryRows: [],
      failureRows: []
    }));
    const formControls = await page.evaluate(() =>
      Array.from(document.querySelectorAll("input, textarea, select"))
        .map((element) => {
          const rect = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);
          let container = element;
          for (let depth = 0; container && depth < 4; depth += 1) {
            container = container.parentElement;
          }
          return {
            tag: element.tagName.toLowerCase(),
            type: element.getAttribute("type") || "",
            name: element.getAttribute("name") || "",
            id: element.id || "",
            ariaLabel: element.getAttribute("aria-label") || "",
            placeholder: element.getAttribute("placeholder") || "",
            value: String(element.value || "").slice(0, 250),
            visible:
              rect.width > 0 &&
              rect.height > 0 &&
              style.display !== "none" &&
              style.visibility !== "hidden",
            nearbyText: String(container?.textContent || "")
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 500)
          };
        })
    ).catch(() => []);
    await fsp.writeFile(
      base + ".json",
      JSON.stringify({
        job: publicJob(job),
        url: safePageUrl(),
        error: errorMessage(error),
        evidence,
        formControls
      }, null, 2)
    );
    job.diagnostic = path.basename(base);
    await saveQueue();
  } catch (diagnosticError) {
    console.error(
      "Cannot save Kindle diagnostic",
      job.id,
      diagnosticError
    );
  }
}

async function clearExistingKindleFiles(page) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const removeAll = page.getByText(/remove all/i);
    const count = await removeAll.count();
    let clicked = false;

    for (let index = 0; index < count; index += 1) {
      const candidate = removeAll.nth(index);
      if (!(await candidate.isVisible().catch(() => false))) {
        continue;
      }

      await candidate.scrollIntoViewIfNeeded({
        timeout: 3_000
      }).catch(() => {});
      await candidate.click();
      await page.waitForTimeout(1_000);
      clicked = true;
      break;
    }

    if (!clicked) {
      return;
    }
  }

  throw new Error(
    "Amazon upload area could not be cleared"
  );
}

async function clickKindleSendButton(page) {
  await page.evaluate(() => {
    window.scrollTo(0, document.body.scrollHeight);
  });

  const candidates = [
    page.getByRole("button", { name: /^send$/i }),
    page.locator('button:has-text("Send")'),
    page.locator('input[type="button"][value="Send"]'),
    page.locator('input[type="submit"][value="Send"]'),
    page.locator('[role="button"]:has-text("Send")'),
    page.getByText(/^send$/i)
  ];

  for (const locator of candidates) {
    if (await locator.count().catch(() => 0) === 0) {
      continue;
    }

    const candidate = locator.first();

    try {
      await candidate.scrollIntoViewIfNeeded({
        timeout: 5_000
      });
    } catch {
      await page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight);
      });
    }

    if (await candidate.isVisible().catch(() => false)) {
      await candidate.click();
      return;
    }
  }

  throw new Error("Amazon Send button was not found");
}

async function downloadObject(key, destination) {
  const response = await s3.send(new GetObjectCommand({
    Bucket: bucketName,
    Key: key
  }));
  if (!response.Body) {
    throw new Error("Stored PDF has no body");
  }
  await pipeline(response.Body, fs.createWriteStream(destination));
}

async function safeDeleteObject(key) {
  try {
    await s3.send(new DeleteObjectCommand({
      Bucket: bucketName,
      Key: key
    }));
  } catch (error) {
    console.error("Cannot delete object", key, error);
  }
}

async function loadSessionState() {
  try {
    const parsed = JSON.parse(
      await fsp.readFile(SESSION_STATE_PATH, "utf8")
    );
    return {
      connected: Boolean(parsed.connected),
      lastSessionCheck: parsed.lastSessionCheck || null
    };
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.error("Cannot load Kindle session state", error);
    }
    return {
      connected: false,
      lastSessionCheck: null
    };
  }
}

async function saveSessionState() {
  sessionWrite = sessionWrite.then(async () => {
    const temporary = SESSION_STATE_PATH + ".tmp";
    await fsp.writeFile(
      temporary,
      JSON.stringify({
        connected: kindleConnected,
        lastSessionCheck
      }, null, 2)
    );
    await fsp.rename(temporary, SESSION_STATE_PATH);
  });
  return sessionWrite;
}

async function loadQueue() {
  try {
    const parsed = JSON.parse(await fsp.readFile(QUEUE_PATH, "utf8"));
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.map(normalizeLoadedJob);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.error("Cannot load queue", error);
    }
    return [];
  }
}

async function saveQueue() {
  queueWrite = queueWrite.then(async () => {
    const temporary = QUEUE_PATH + ".tmp";
    await fsp.writeFile(temporary, JSON.stringify(queue, null, 2));
    await fsp.rename(temporary, QUEUE_PATH);
  });
  return queueWrite;
}

function countQueueStatuses() {
  const counts = {
    queued: 0,
    processing: 0,
    verifying: 0,
    waitingAuth: 0,
    sent: 0,
    failed: 0
  };
  for (const job of queue) {
    if (job.status === "queued") counts.queued += 1;
    if (job.status === "processing") counts.processing += 1;
    if (job.status === "verifying") counts.verifying += 1;
    if (job.status === "waiting_auth") counts.waitingAuth += 1;
    if (job.status === "sent") counts.sent += 1;
    if (job.status === "failed") counts.failed += 1;
  }
  return counts;
}

async function cleanupSmokeTestJobs() {
  const before = queue.length;
  queue = queue.filter((job) => !isSmokeTestJob(job));

  const removed = before - queue.length;
  if (removed > 0) {
    await saveQueue();
  }

  return removed;
}

function isSmokeTestJob(job) {
  return /^kindle-upload-.*test.*2026-07-07[.]pdf$/i
    .test(String(job?.filename || ""));
}

function normalizeBatchId(value) {
  const batchId = String(value || "").trim();
  return /^[A-Za-z0-9_-]{1,100}$/.test(batchId)
    ? batchId
    : null;
}

function publicJob(job) {
  return {
    id: job.id,
    filename: job.filename,
    size: job.size,
    status: job.status,
    attempts: job.attempts,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    submittedAt: job.submittedAt || null,
    verifiedAt: job.verifiedAt || null,
    sentAt: job.sentAt || null,
    batchId: job.batchId || null,
    amazonStatus: job.amazonStatus || "",
    verificationEvidence:
      job.verificationEvidence || null,
    diagnostic: job.diagnostic || ""
  };
}

function requireApiSecret(req, res, next) {
  const value = String(req.headers.authorization || "");
  if (value !== "Bearer " + SHARED_SECRET) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

function requireConnectToken(req, res, next) {
  const token =
    String(req.query.token || "") ||
    cookieValue(req.headers.cookie, "kindle_connect");
  const record = connectTokens.get(token);
  if (!record || record.expiresAt < Date.now()) {
    res.status(403).send("Connection link expired");
    return;
  }
  next();
}

function setUploadCors(req, res) {
  const origin = String(req.headers.origin || "");
  if (origin === APP_ORIGIN) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "600");
}

function connectPage(token) {
  const encodedToken = JSON.stringify(token);
  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Amazon session</title>
  <style>
    html,body{height:100%;margin:0;font-family:system-ui,sans-serif;background:#111827;color:white}
    body{display:flex;flex-direction:column}
    header{display:flex;align-items:center;gap:12px;padding:10px 14px;background:#1f2937}
    header span{flex:1;font-size:14px}
    button{padding:9px 14px;border:0;border-radius:8px;background:#f59e0b;color:#111827;font-weight:700;cursor:pointer}
    #screen{flex:1;overflow:hidden;background:#111}
    #status{font-size:13px;color:#d1d5db}
  </style>
</head>
<body>
  <header>
    <span>Войдите в Amazon и откройте Send to Kindle. Пароль не сохраняется приложением.</span>
    <strong id="status">Подключение...</strong>
    <button id="check">Проверить и продолжить</button>
  </header>
  <div id="screen"></div>
  <script type="module">
    const token = ${encodedToken};
    const { default: RFB } = await import(
      "/novnc/core/rfb.js?token=" + encodeURIComponent(token)
    );
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    const rfb = new RFB(
      document.getElementById("screen"),
      protocol + "://" + location.host +
        "/websockify?token=" + encodeURIComponent(token)
    );
    rfb.scaleViewport = true;
    rfb.resizeSession = false;
    rfb.viewOnly = false;
    rfb.addEventListener("connect", () => {
      document.getElementById("status").textContent = "Окно готово";
    });
    document.getElementById("check").addEventListener("click", async () => {
      const status = document.getElementById("status");
      status.textContent = "Проверяю...";
      const response = await fetch(
        "/connect/check?token=" + encodeURIComponent(token)
      );
      const data = await response.json();
      status.textContent = data.connected
        ? "Kindle подключён — окно можно закрыть"
        : "Вход ещё не завершён";
    });
  </script>
</body>
</html>`;
}

function cookieValue(header, name) {
  const cookies = String(header || "").split(";");
  for (const item of cookies) {
    const [key, ...rest] = item.trim().split("=");
    if (key === name) {
      return decodeURIComponent(rest.join("="));
    }
  }
  return "";
}

function pruneTokens(map) {
  for (const [key, value] of map.entries()) {
    if (value.expiresAt < Date.now()) {
      map.delete(key);
      if (value.partPath) {
        void fsp.rm(value.partPath, { force: true }).catch(() => {});
      }
    }
  }
}

function safePageUrl() {
  try {
    return browserPage?.url() || "";
  } catch {
    return "";
  }
}

function authRequired() {
  const error = new Error("Amazon session requires reconnection");
  error.code = "AUTH_REQUIRED";
  return error;
}

function sanitizeFileName(value) {
  const cleaned = String(value || "document.pdf")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
  return cleaned || "document.pdf";
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error("Missing environment variable: " + name);
  }
  return value;
}
