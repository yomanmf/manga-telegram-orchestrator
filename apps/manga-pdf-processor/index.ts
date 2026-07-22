import { Hono } from "hono";
import { PDFDocument } from "pdf-lib";
import JSZip from "jszip";
import { classifyKindleSentJob } from "./kindle-job-contract.mjs";
import {
  acceptedKindleUploadProgress,
  nextKindleUploadRange
} from "./kindle-upload-contract.mjs";
import {
  normalizeKindlePdfFileName
} from "./kindle-filename.mjs";
import {
  parseWeebCentralCoverUrl
} from "./weebcentral-cover.mjs";
import {
  boundedInteger,
  mapWithConcurrency
} from "./processing-performance.mjs";
import {
  writePdfBatches
} from "./pdf-batch-writer.mjs";
import {
  fetchWeebCentralResponse,
  fetchWeebCentralImageBytes
} from "./weebcentral-image-fetch.mjs";
import { loadAnalyticsLockbox } from "./analytics-lockbox.mjs";
import { createAnalyticsReporter } from "./analytics-reporter.mjs";

await loadAnalyticsLockbox();
const analyticsReporter = createAnalyticsReporter();

const app = new Hono();

const MAX_PDF_SIZE = 185 * 1024 * 1024;
const WEEBCENTRAL_IMAGE_CONCURRENCY =
  boundedInteger(
    process.env.WEEBCENTRAL_IMAGE_CONCURRENCY,
    3,
    { min: 1, max: 16 }
  );
const WEEBCENTRAL_IMAGE_TIMEOUT_MS =
  boundedInteger(
    process.env.WEEBCENTRAL_IMAGE_TIMEOUT_MS,
    30_000,
    { min: 5_000, max: 120_000 }
  );
const PDF_SERIALIZATION_BATCH_SIZE =
  boundedInteger(
    process.env.PDF_SERIALIZATION_BATCH_SIZE,
    24,
    { min: 1, max: 64 }
  );

const htmlContent = `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8" />
  <meta
    name="viewport"
    content="width=device-width, initial-scale=1.0"
  />

  <title>Manga PDF Processor</title>

  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family:
        -apple-system,
        BlinkMacSystemFont,
        "Segoe UI",
        Roboto,
        sans-serif;

      background:
        linear-gradient(
          135deg,
          #667eea 0%,
          #764ba2 100%
        );

      min-height: 100vh;

      display: flex;
      align-items: center;
      justify-content: center;

      padding: 20px;
    }

    .container {
      background: white;

      border-radius: 12px;

      box-shadow:
        0 20px 60px rgba(0, 0, 0, 0.3);

      padding: 40px;

      max-width: 500px;
      width: 100%;
    }

    h1 {
      color: #333;
      margin-bottom: 10px;
      font-size: 28px;
    }

    .subtitle {
      color: #666;
      margin-bottom: 30px;
      font-size: 14px;
    }

    .upload-area {
      border: 2px dashed #667eea;
      border-radius: 8px;

      padding: 40px 20px;

      text-align: center;
      cursor: pointer;

      transition: all 0.3s ease;

      background: #f8f9ff;
    }

    .upload-area:hover {
      border-color: #764ba2;
      background: #f0f2ff;
    }

    .upload-area.dragover {
      border-color: #764ba2;
      background: #e8ebff;
    }

    .upload-icon {
      font-size: 48px;
      margin-bottom: 15px;
    }

    .upload-text {
      color: #333;
      font-weight: 500;
      margin-bottom: 5px;
    }

    .upload-hint {
      color: #999;
      font-size: 13px;
    }

    input[type="file"] {
      display: none;
    }

    .files-list {
      margin-top: 20px;

      padding: 15px;

      background: #f0f2ff;

      border-radius: 8px;

      display: none;

      max-height: 250px;
      overflow-y: auto;
    }

    .files-list.show {
      display: block;
    }

    .file-item {
      color: #333;

      font-weight: 500;

      word-break: break-all;

      padding: 8px 0;

      border-bottom: 1px solid #e0e0e0;

      font-size: 13px;
    }

    .file-item:last-child {
      border-bottom: none;
    }

    .file-count {
      color: #666;

      font-size: 12px;

      margin-top: 8px;
      padding-top: 8px;

      border-top: 1px solid #e0e0e0;
    }

    .settings-section {
      margin-top: 20px;

      padding: 15px;

      background: #f8f9ff;

      border-radius: 8px;

      border: 1px solid #e0e0e0;
    }

    .settings-title {
      color: #333;

      font-weight: 600;

      font-size: 13px;

      margin-bottom: 12px;
    }

    .text-input {
      width: 100%;
      padding: 10px 12px;
      border: 1px solid #d0d0d0;
      border-radius: 8px;
      font-size: 13px;
      color: #333;
      background: white;
    }

    .text-input + .text-input {
      margin-top: 10px;
    }

    .weeb-search {
      position: relative;
    }

    .weeb-search-hint {
      margin: 8px 2px 0;
      color: #777;
      font-size: 11px;
    }

    .weeb-suggestions {
      display: none;
      position: absolute;
      top: calc(100% + 4px);
      left: 0;
      right: 0;
      z-index: 20;
      max-height: 280px;
      overflow-y: auto;
      border: 1px solid #d9dcf2;
      border-radius: 8px;
      background: white;
      box-shadow: 0 12px 28px rgba(42, 48, 96, 0.18);
    }

    .weeb-suggestions.show {
      display: block;
    }

    .weeb-suggestion {
      display: block;
      width: 100%;
      padding: 11px 12px;
      border: 0;
      border-bottom: 1px solid #eeeeF7;
      background: white;
      color: #333;
      font: inherit;
      font-size: 13px;
      line-height: 1.35;
      text-align: left;
      cursor: pointer;
    }

    .weeb-suggestion:last-child {
      border-bottom: 0;
    }

    .weeb-suggestion:hover,
    .weeb-suggestion.active {
      background: #f0f2ff;
      color: #4f5fce;
    }

    .weeb-suggestion-status {
      padding: 12px;
      color: #777;
      font-size: 12px;
    }

    .weeb-actions {
      display: flex;
      gap: 10px;
      margin-top: 10px;
    }

    .chapter-preview {
      display: none;
      max-height: 220px;
      overflow-y: auto;
      margin-top: 10px;
      padding: 10px;
      border-radius: 8px;
      background: white;
      color: #444;
      font-size: 12px;
      line-height: 1.6;
      white-space: pre-wrap;
    }

    .chapter-preview.show {
      display: block;
    }

    .kindle-status {
      margin-bottom: 12px;
      padding: 11px 12px;
      border: 1px solid #d9dcf2;
      border-radius: 8px;
      background: white;
      color: #555;
      font-size: 12px;
      line-height: 1.5;
    }

    .kindle-status.connected {
      border-color: #b9dfc2;
      background: #f0fbf3;
      color: #236b34;
    }

    .kindle-status.disconnected {
      border-color: #efd2a8;
      background: #fff8ec;
      color: #845312;
    }

    .kindle-queue {
      margin-top: 10px;
      color: #666;
      font-size: 11px;
      line-height: 1.5;
    }

    .success-screen .kindle-queue {
      white-space: pre-wrap;
    }

    .toggle-option {
      display: flex;

      align-items: center;

      gap: 10px;
    }

    .toggle-switch {
      position: relative;

      width: 44px;
      height: 24px;

      background: #ccc;

      border-radius: 12px;

      cursor: pointer;

      transition: background 0.3s ease;
    }

    .toggle-switch.active {
      background: #667eea;
    }

    .toggle-switch::after {
      content: "";

      position: absolute;

      width: 20px;
      height: 20px;

      background: white;

      border-radius: 50%;

      top: 2px;
      left: 2px;

      transition: left 0.3s ease;
    }

    .toggle-switch.active::after {
      left: 22px;
    }

    .toggle-label {
      color: #333;

      font-size: 13px;

      font-weight: 500;

      cursor: pointer;

      flex: 1;
    }

    .button-group {
      display: flex;

      gap: 10px;

      margin-top: 20px;
    }

    button {
      flex: 1;

      padding: 12px 20px;

      border: none;

      border-radius: 8px;

      font-size: 14px;

      font-weight: 600;

      cursor: pointer;

      transition: all 0.3s ease;
    }

    .btn-process {
      background:
        linear-gradient(
          135deg,
          #667eea 0%,
          #764ba2 100%
        );

      color: white;
    }

    .btn-process:hover:not(:disabled) {
      transform: translateY(-2px);

      box-shadow:
        0 10px 20px rgba(102, 126, 234, 0.3);
    }

    .btn-process:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .btn-clear,
    .btn-new {
      background: #e0e0e0;
      color: #333;
    }

    .btn-clear:hover,
    .btn-new:hover {
      background: #d0d0d0;
    }

    .progress-screen {
      display: none;
      text-align: center;
    }

    .progress-screen.show {
      display: block;
    }

    .progress-screen h2 {
      color: #333;

      margin-bottom: 30px;

      font-size: 24px;
    }

    .progress-text {
      color: #666;

      font-size: 14px;

      margin-bottom: 20px;

      word-break: break-word;
    }

    .spinner {
      width: 80px;
      height: 80px;

      margin: 20px auto;

      border: 8px solid #eee;

      border-top-color: #667eea;

      border-radius: 50%;

      animation: spin 1s linear infinite;
    }

    @keyframes spin {
      to {
        transform: rotate(360deg);
      }
    }

    .success-screen {
      display: none;
      text-align: center;
    }

    .success-screen.show {
      display: block;
    }

    .success-icon {
      font-size: 80px;
      margin-bottom: 20px;
    }

    .success-title {
      color: #333;

      font-size: 28px;

      font-weight: 700;

      margin-bottom: 10px;
    }

    .success-subtitle {
      color: #666;

      font-size: 14px;

      margin-bottom: 30px;
    }

    .success-details {
      background: #f0f2ff;

      border-radius: 8px;

      padding: 20px;

      margin-bottom: 30px;

      text-align: left;
    }

    .detail-item {
      display: flex;

      justify-content: space-between;

      padding: 8px 0;

      border-bottom: 1px solid #e0e0e0;
    }

    .detail-item:last-child {
      border-bottom: none;
    }

    .detail-label {
      color: #666;
      font-size: 13px;
    }

    .detail-value {
      color: #333;

      font-weight: 600;

      font-size: 13px;
    }

    .download-status {
      background: #d4edda;

      color: #155724;

      border: 1px solid #c3e6cb;

      border-radius: 8px;

      padding: 12px;

      margin-bottom: 20px;

      font-size: 13px;
    }

    .message {
      margin-top: 20px;

      padding: 12px;

      border-radius: 8px;

      display: none;

      font-size: 14px;

      word-break: break-word;
    }

    .message.show {
      display: block;
    }

    .message.error {
      background: #f8d7da;

      color: #721c24;

      border: 1px solid #f5c6cb;
    }

    .main-content {
      display: block;
    }

    .main-content.hidden {
      display: none;
    }

    @media (min-width: 900px) {
      body {
        padding: 16px;
      }

      .container {
        max-width: 1080px;
        padding: 22px;
      }

      .main-content {
        display: grid;
        grid-template-columns:
          minmax(300px, 0.9fr)
          minmax(420px, 1.1fr);
        grid-template-areas:
          "title title"
          "subtitle subtitle"
          "upload weeb"
          "kindle weeb"
          "files weeb"
          "settings actions"
          "message message";
        gap: 10px 16px;
        align-items: start;
      }

      h1 {
        grid-area: title;
        margin-bottom: 0;
        font-size: 24px;
        line-height: 1.1;
      }

      .subtitle {
        grid-area: subtitle;
        margin-bottom: 2px;
        font-size: 13px;
      }

      .upload-area {
        grid-area: upload;
        min-height: 118px;
        padding: 18px 16px;
        display: flex;
        flex-direction: column;
        justify-content: center;
      }

      .upload-icon {
        font-size: 34px;
        margin-bottom: 8px;
      }

      .upload-text {
        margin-bottom: 3px;
      }

      .files-list {
        grid-area: files;
        margin-top: 0;
        max-height: 86px;
        padding: 10px 12px;
      }

      .file-item {
        padding: 5px 0;
        font-size: 12px;
      }

      .settings-section {
        margin-top: 0;
        padding: 12px;
      }

      .kindle-section {
        grid-area: kindle;
      }

      .weeb-section {
        grid-area: weeb;
      }

      .processing-settings-section {
        grid-area: settings;
      }

      .settings-title {
        margin-bottom: 8px;
      }

      .text-input {
        padding: 8px 10px;
      }

      .text-input + .text-input {
        margin-top: 8px;
      }

      .weeb-search-hint {
        margin-top: 6px;
      }

      .weeb-actions {
        margin-top: 8px;
      }

      .weeb-suggestions {
        max-height: 180px;
      }

      .chapter-preview {
        max-height: 96px;
        margin-top: 8px;
        padding: 8px;
        line-height: 1.4;
      }

      .kindle-status {
        margin-bottom: 8px;
        padding: 8px 10px;
        line-height: 1.35;
      }

      .kindle-queue {
        margin-top: 7px;
        line-height: 1.35;
      }

      .toggle-option {
        gap: 8px;
      }

      .toggle-switch {
        width: 38px;
        height: 22px;
        border-radius: 11px;
        flex: 0 0 auto;
      }

      .toggle-switch::after {
        width: 18px;
        height: 18px;
      }

      .toggle-switch.active::after {
        left: 18px;
      }

      .toggle-label {
        font-size: 12px;
      }

      .main-content > .button-group {
        grid-area: actions;
        margin-top: 0;
        align-self: end;
      }

      button {
        padding: 10px 16px;
      }

      .main-content > .message {
        grid-area: message;
        margin-top: 0;
      }

      .progress-screen,
      .success-screen {
        max-width: 540px;
        margin: 0 auto;
      }
    }
  </style>
</head>

<body>

  <div class="container">

    <div
      class="main-content"
      id="mainContent"
    >

      <h1>Manga PDF Processor</h1>

      <p class="subtitle">
        Processing manga to PDF
      </p>


      <div
        class="upload-area"
        id="uploadArea"
      >

        <div class="upload-icon">
          📄
        </div>

        <div class="upload-text">
          Upload PDF or CBZ files
        </div>

        <div class="upload-hint">
          or drag and drop here
        </div>

        <input
          type="file"
          id="fileInput"
          accept=".pdf,.cbz"
          multiple
        />

      </div>


      <div
        class="files-list"
        id="filesList"
      >

        <div id="filesContainer"></div>

        <div
          class="file-count"
          id="fileCount"
        ></div>

      </div>


      <div class="settings-section kindle-section">

        <div class="settings-title">
          Automatic Send to Kindle
        </div>

        <div
          class="kindle-status"
          id="kindleStatus"
        >
          Checking Amazon session...
        </div>

        <div class="toggle-option">
          <div
            class="toggle-switch"
            id="kindleToggle"
          ></div>

          <label
            class="toggle-label"
            for="kindleToggle"
          >
            Send each ready PDF to Kindle instead of downloading an archive
          </label>
        </div>

        <div class="weeb-actions">
          <button
            class="btn-clear"
            id="kindleConnectBtn"
            type="button"
          >
            Connect Amazon
          </button>

          <button
            class="btn-clear"
            id="kindleRefreshBtn"
            type="button"
          >
            Refresh status
          </button>
        </div>

        <div
          class="kindle-queue"
          id="kindleQueue"
        ></div>

      </div>


      <div class="settings-section weeb-section">

        <div class="settings-title">
          Search and download from WeebCentral
        </div>

        <div class="weeb-search">
          <input
            class="text-input"
            id="weebSearch"
            type="search"
            placeholder="Start typing a manga title..."
            autocomplete="off"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded="false"
            aria-controls="weebSuggestions"
          />

          <div
            class="weeb-suggestions"
            id="weebSuggestions"
            role="listbox"
          ></div>
        </div>

        <div class="weeb-search-hint">
          Select a title from the suggestions, or paste its URL below.
        </div>

        <input
          class="text-input"
          id="weebUrl"
          type="url"
          placeholder="https://weebcentral.com/series/..."
        />

        <div class="weeb-actions">
          <button
            class="btn-clear"
            id="weebLoadBtn"
            type="button"
          >
            Load chapters
          </button>
        </div>

        <div
          class="chapter-preview"
          id="weebChapterPreview"
        ></div>

        <input
          class="text-input"
          id="weebSelection"
          type="text"
          placeholder="all, single 5, range 1-10, or 1,5,9"
          disabled
        />

        <div class="weeb-actions">
          <button
            class="btn-process"
            id="weebDownloadBtn"
            type="button"
            disabled
          >
            Download and process
          </button>
        </div>

      </div>


      <div class="settings-section processing-settings-section">

        <div class="settings-title">
          Settings
        </div>

        <div class="toggle-option">

          <div
            class="toggle-switch active"
            id="mergeToggle"
          ></div>

          <label class="toggle-label">
            Merge vertical pages
          </label>

        </div>

      </div>


      <div class="button-group">

        <button
          class="btn-process"
          id="processBtn"
          disabled
        >
          Process
        </button>

        <button
          class="btn-clear"
          id="clearBtn"
        >
          Clear
        </button>

      </div>


      <div
        class="message"
        id="message"
      ></div>

    </div>


    <div
      class="progress-screen"
      id="progressScreen"
    >

      <h2>Processing...</h2>

      <div
        class="progress-text"
        id="progressText"
      >
        Loading files...
      </div>

      <div class="spinner"></div>

    </div>


    <div
      class="success-screen"
      id="successScreen"
    >

      <div class="success-icon">
        ✨
      </div>

      <div class="success-title">
        Done!
      </div>

      <div class="success-subtitle">
        Manga processed successfully
      </div>


      <div class="success-details">

        <div class="detail-item">

          <span class="detail-label">
            Files processed:
          </span>

          <span
            class="detail-value"
            id="successFileCount"
          >
            -
          </span>

        </div>


        <div class="detail-item">

          <span class="detail-label">
            Output files:
          </span>

          <span
            class="detail-value"
            id="successOutputCount"
          >
            -
          </span>

        </div>

      </div>


      <div
        class="download-status"
        id="downloadStatus"
      >
        Archive ready
      </div>


      <div
        class="kindle-queue"
        id="successKindleQueue"
      ></div>


      <div class="button-group">

        <button
          class="btn-new"
          id="newFileBtn"
        >
          Process more
        </button>

      </div>

    </div>

  </div>


  <script src="https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js"></script>
  <script>
    ${classifyKindleSentJob.toString()}
    ${acceptedKindleUploadProgress.toString()}
    ${nextKindleUploadRange.toString()}

    const ANALYTICS_CLIENT_KEY =
      "mangaWebAnalyticsClientId";

    const analyticsUserId =
      readAnalyticsUserId();

    function readAnalyticsUserId() {
      try {
        const current =
          localStorage.getItem(
            ANALYTICS_CLIENT_KEY
          );
        if (
          current &&
          /^[a-zA-Z0-9._:@-]+$/.test(
            current
          )
        ) {
          return current;
        }
        const created =
          "manga_web:anon_" +
          Date.now().toString(36) +
          "_" +
          Math.random()
            .toString(36)
            .slice(2, 12);
        localStorage.setItem(
          ANALYTICS_CLIENT_KEY,
          created
        );
        return created;
      } catch (error) {
        return (
          "manga_web:session_" +
          Date.now().toString(36) +
          "_" +
          Math.random()
            .toString(36)
            .slice(2, 12)
        );
      }
    }

    function mangaAnalyticsEventId(
      prefix
    ) {
      return (
        "manga_web:" +
        (prefix || "event") +
        "_" +
        Date.now().toString(36) +
        "_" +
        Math.random()
          .toString(36)
          .slice(2, 10)
      );
    }

    function sendMangaAnalytics(
      details
    ) {
      details = details || {};
      const now =
        new Date().toISOString();
      fetch("/analytics/events", {
        method: "POST",
        headers: {
          "Content-Type":
            "application/json"
        },
        body: JSON.stringify({
          eventId:
            details.eventId ||
            mangaAnalyticsEventId(),
          userId: analyticsUserId,
          requestType:
            details.requestType ||
            "page_view",
          requestText:
            details.requestText ||
            "GET /",
          resultText:
            details.resultText || null,
          errorText:
            details.errorText || null,
          status:
            details.status || "success",
          startedAt:
            details.startedAt || now,
          finishedAt:
            details.finishedAt || now,
          durationMs:
            Math.max(
              0,
              Math.round(
                details.durationMs || 0
              )
            ),
          metadata:
            details.metadata || {}
        }),
        keepalive: true
      }).catch(function () {
        // Analytics must never interrupt processing.
      });
    }

    sendMangaAnalytics({
      eventId:
        mangaAnalyticsEventId("page"),
      requestType: "page_view",
      requestText: "GET /",
      resultText: "Processor page loaded",
      status: "success"
    });


    const uploadArea =
      document.getElementById("uploadArea");

    const fileInput =
      document.getElementById("fileInput");

    const filesList =
      document.getElementById("filesList");

    const filesContainer =
      document.getElementById("filesContainer");

    const fileCount =
      document.getElementById("fileCount");

    const processBtn =
      document.getElementById("processBtn");

    const clearBtn =
      document.getElementById("clearBtn");

    const message =
      document.getElementById("message");

    const mainContent =
      document.getElementById("mainContent");

    const progressScreen =
      document.getElementById("progressScreen");

    const progressText =
      document.getElementById("progressText");

    const successScreen =
      document.getElementById("successScreen");

    const newFileBtn =
      document.getElementById("newFileBtn");

    const successFileCount =
      document.getElementById("successFileCount");

    const successOutputCount =
      document.getElementById("successOutputCount");

    const downloadStatus =
      document.getElementById("downloadStatus");

    const successKindleQueue =
      document.getElementById("successKindleQueue");

    const mergeToggle =
      document.getElementById("mergeToggle");

    const kindleToggle =
      document.getElementById("kindleToggle");

    const kindleStatus =
      document.getElementById("kindleStatus");

    const kindleQueue =
      document.getElementById("kindleQueue");

    const kindleConnectBtn =
      document.getElementById(
        "kindleConnectBtn"
      );

    const kindleRefreshBtn =
      document.getElementById(
        "kindleRefreshBtn"
      );

    const weebSearch =
      document.getElementById("weebSearch");

    const weebSuggestions =
      document.getElementById(
        "weebSuggestions"
      );

    const weebUrl =
      document.getElementById("weebUrl");

    const weebLoadBtn =
      document.getElementById("weebLoadBtn");

    const weebChapterPreview =
      document.getElementById(
        "weebChapterPreview"
      );

    const weebSelection =
      document.getElementById(
        "weebSelection"
      );

    const weebDownloadBtn =
      document.getElementById(
        "weebDownloadBtn"
      );


    let shouldMerge = true;

    const kindlePreferenceKey =
      "mangaPdfProcessor.sendToKindle";

    let shouldSendToKindle = true;

    let kindleConnected = false;

    let kindleSessionState = "unknown";

    let latestKindleCounts = {};

    let successKindleSummary = null;

    let selectedFiles = [];

    let weebMangaTitle = "";

    let weebChapters = [];

    let weebLoadedSeriesUrl = "";

    let weebSearchResults = [];

    let weebSearchTimer = null;

    let weebSearchController = null;

    let weebSearchActiveIndex = -1;

    let weebSelectedSearchTitle = "";


    mergeToggle.addEventListener(
      "click",
      function () {

        shouldMerge = !shouldMerge;

        mergeToggle.classList.toggle(
          "active",
          shouldMerge
        );

      }
    );


    function getKindlePreference() {

      try {
        return localStorage.getItem(
          kindlePreferenceKey
        );
      } catch (_) {
        return null;
      }

    }


    function setKindlePreference(
      value
    ) {

      try {
        localStorage.setItem(
          kindlePreferenceKey,
          value
        );
      } catch (_) {}

    }


    function setKindleSendingEnabled(
      enabled
    ) {

      shouldSendToKindle = Boolean(
        enabled
      );

      kindleToggle.classList.toggle(
        "active",
        shouldSendToKindle
      );

      kindleToggle.setAttribute(
        "aria-pressed",
        String(shouldSendToKindle)
      );

    }


    setKindleSendingEnabled(true);


    kindleToggle.addEventListener(
      "click",
      function () {

        const nextValue =
          !shouldSendToKindle;

        setKindleSendingEnabled(
          nextValue
        );

        setKindlePreference(
          nextValue ? "on" : "off"
        );

        if (
          nextValue &&
          kindleSessionState ===
            "needs_auth"
        ) {
          showMessage(
            "Connect Amazon first, then press Refresh status.",
            "error"
          );
        }

      }
    );


    kindleConnectBtn.addEventListener(
      "click",
      function () {
        window.open(
          "/kindle/connect",
          "_blank",
          "noopener"
        );
      }
    );


    kindleRefreshBtn.addEventListener(
      "click",
      refreshKindleStatus
    );


    function formatKindleQueueText(
      counts
    ) {

      return (
        "Queued: " +
        Number(counts.queued || 0) +
        " · Uploading: " +
        Number(counts.processing || 0) +
        " · Verifying in Amazon: " +
        Number(counts.verifying || 0) +
        " · Waiting for login: " +
        Number(counts.waitingAuth || 0) +
        " · Sent: " +
        Number(counts.sent || 0) +
        " · Failed: " +
        Number(counts.failed || 0)
      );

    }


    function setKindleQueueSummary(
      counts
    ) {

      const text =
        formatKindleQueueText(
          counts || {}
        );

      latestKindleCounts =
        counts || {};

      kindleQueue.textContent = text;

      renderSuccessKindleSummary();

    }


    function formatPdfCount(
      count
    ) {

      return (
        count +
        " PDF " +
        (count === 1 ? "file" : "files")
      );

    }


    function renderSuccessKindleSummary() {

      if (!successKindleSummary) {
        return;
      }

      if (successKindleSummary.sentToKindle) {
        successKindleQueue.textContent =
          "This run: Amazon confirmed " +
          formatPdfCount(
            successKindleSummary.queuedThisRun
          ) +
          " to Kindle\\nQueue total: " +
          formatKindleQueueText(
            latestKindleCounts
          );
      } else {
        successKindleQueue.textContent =
          "This run: Kindle auto-send was off\\nQueue total: " +
          formatKindleQueueText(
            latestKindleCounts
          );
      }

    }


    function setSuccessKindleSummary(
      sentToKindle,
      queuedThisRun
    ) {

      successKindleSummary = {
        sentToKindle,
        queuedThisRun
      };

      renderSuccessKindleSummary();

    }


    async function refreshKindleStatus() {

      kindleRefreshBtn.disabled = true;


      try {

        const response = await fetch(
          "/kindle/status"
        );

        const data = await response.json();


        if (!response.ok) {
          throw new Error(
            data.error ||
            "Kindle status unavailable"
          );
        }

        kindleConnected =
          Boolean(data.connected);

        kindleSessionState =
          data.sessionState ||
          (data.connected
            ? "connected"
            : "needs_auth");

        const storedPreference =
          getKindlePreference();

        if (kindleConnected) {
          setKindleSendingEnabled(
            storedPreference === "off"
              ? false
              : true
          );
        } else {
          setKindleSendingEnabled(
            storedPreference === "off"
              ? false
              : true
          );
        }


        kindleStatus.className =
          "kindle-status " +
          (data.connected
            ? "connected"
            : "disconnected");

        kindleStatus.textContent =
          data.connected
            ? "Amazon session connected · Kindle auto-send " +
              (shouldSendToKindle ? "ON" : "OFF")
            : kindleSessionState ===
                "unknown"
              ? "Amazon session will be checked on the next upload · Kindle auto-send " +
                (shouldSendToKindle ? "ON" : "OFF")
              : "Amazon session needs connection · Kindle auto-send " +
              (shouldSendToKindle
                ? "will start after connection"
                : "OFF");


        const counts = data.counts || {};

        setKindleQueueSummary(counts);

        return data;

      } catch (error) {

        kindleConnected = false;

        kindleSessionState =
          "unavailable";

        setKindleSendingEnabled(
          getKindlePreference() === "off"
            ? false
            : true
        );

        kindleStatus.className =
          "kindle-status disconnected";

        kindleStatus.textContent =
          "Kindle uploader unavailable: " +
          error.message;

        return null;

      } finally {

        kindleRefreshBtn.disabled = false;

      }

    }


    const kindleStatusRefreshMs =
      15000;

    let kindleStatusTimer = null;


    function stopKindleStatusPolling() {

      if (!kindleStatusTimer) {
        return;
      }

      clearInterval(
        kindleStatusTimer
      );

      kindleStatusTimer = null;

    }


    function startKindleStatusPolling(
      refreshImmediately = true
    ) {

      stopKindleStatusPolling();

      if (document.hidden) {
        return;
      }

      if (refreshImmediately) {
        void refreshKindleStatus();
      }

      kindleStatusTimer = setInterval(
        function () {
          void refreshKindleStatus();
        },
        kindleStatusRefreshMs
      );

    }


    document.addEventListener(
      "visibilitychange",
      function () {

        if (document.hidden) {
          stopKindleStatusPolling();
          return;
        }

        startKindleStatusPolling(true);

      }
    );


    startKindleStatusPolling(true);


    async function getKindleSendingForRun() {

      if (!shouldSendToKindle) {
        return false;
      }

      const data =
        await refreshKindleStatus();

      if (
        !data
      ) {
        throw new Error(
          "Kindle uploader is unavailable. Try again in a moment."
        );
      }

      if (
        !data.connected ||
        data.sessionState !==
          "connected"
      ) {
        throw new Error(
          "Amazon session is not connected. Click Connect Amazon, finish login, then Refresh status."
        );
      }

      return true;

    }


    function hideWeebSuggestions() {

      weebSuggestions.classList.remove(
        "show"
      );

      weebSearch.setAttribute(
        "aria-expanded",
        "false"
      );

      weebSearch.removeAttribute(
        "aria-activedescendant"
      );

      weebSearchActiveIndex = -1;

    }


    function clearLoadedWeebSeries() {

      weebChapters = [];
      weebLoadedSeriesUrl = "";

      weebChapterPreview.textContent = "";
      weebChapterPreview.classList.remove(
        "show"
      );

    }


    function updateWeebControls() {

      const hasUrl =
        Boolean(weebUrl.value.trim());

      weebSelection.disabled = !hasUrl;
      weebDownloadBtn.disabled = !hasUrl;

      if (
        hasUrl &&
        !weebSelection.value.trim()
      ) {
        weebSelection.value = "all";
      }

    }


    function setWeebSearchActiveIndex(
      index
    ) {

      const options =
        weebSuggestions.querySelectorAll(
          ".weeb-suggestion"
        );


      if (options.length === 0) {
        return;
      }


      weebSearchActiveIndex =
        Math.max(
          0,
          Math.min(
            index,
            options.length - 1
          )
        );


      options.forEach(
        function (option, optionIndex) {
          option.classList.toggle(
            "active",
            optionIndex ===
              weebSearchActiveIndex
          );
        }
      );


      const activeOption =
        options[weebSearchActiveIndex];


      weebSearch.setAttribute(
        "aria-activedescendant",
        activeOption.id
      );

      activeOption.scrollIntoView({
        block: "nearest"
      });

    }


    async function selectWeebSearchResult(
      index
    ) {

      const result =
        weebSearchResults[index];


      if (!result) {
        return;
      }


      weebSearch.value = result.title;
      weebUrl.value = result.url;
      weebSelectedSearchTitle =
        result.title;

      weebMangaTitle = result.title;
      clearLoadedWeebSeries();
      updateWeebControls();
      hideWeebSuggestions();

      await loadWeebSeries();

    }


    function renderWeebSuggestions(
      results
    ) {

      weebSuggestions.textContent = "";
      weebSearchResults = results;
      weebSearchActiveIndex = -1;


      if (results.length === 0) {

        const empty =
          document.createElement("div");

        empty.className =
          "weeb-suggestion-status";

        empty.textContent =
          "No matching titles found";

        weebSuggestions.appendChild(empty);

      } else {

        results.forEach(
          function (result, index) {

            const option =
              document.createElement(
                "button"
              );

            option.type = "button";
            option.className =
              "weeb-suggestion";
            option.id =
              "weeb-suggestion-" + index;
            option.setAttribute(
              "role",
              "option"
            );
            option.textContent =
              result.title;

            option.addEventListener(
              "click",
              function () {
                selectWeebSearchResult(
                  index
                );
              }
            );

            weebSuggestions.appendChild(
              option
            );

          }
        );

      }


      weebSuggestions.classList.add(
        "show"
      );

      weebSearch.setAttribute(
        "aria-expanded",
        "true"
      );

    }


    async function searchWeebCentralTitles(
      query
    ) {

      if (weebSearchController) {
        weebSearchController.abort();
      }


      weebSearchController =
        new AbortController();

      weebSuggestions.innerHTML =
        '<div class="weeb-suggestion-status">Searching...</div>';

      weebSuggestions.classList.add(
        "show"
      );

      weebSearch.setAttribute(
        "aria-expanded",
        "true"
      );


      try {

        const response = await fetch(
          "/weebcentral/search?q=" +
            encodeURIComponent(query),
          {
            signal:
              weebSearchController.signal
          }
        );

        const data = await response.json();


        if (!response.ok) {
          throw new Error(
            data.error ||
            "Cannot search titles"
          );
        }


        if (
          weebSearch.value.trim() !== query
        ) {
          return;
        }


        renderWeebSuggestions(
          Array.isArray(data.results)
            ? data.results
            : []
        );

      } catch (error) {

        if (error.name === "AbortError") {
          return;
        }


        weebSuggestions.innerHTML =
          '<div class="weeb-suggestion-status">Search is temporarily unavailable</div>';

      }

    }


    weebSearch.addEventListener(
      "input",
      function () {

        clearTimeout(weebSearchTimer);

        const query =
          weebSearch.value.trim();


        if (
          query !== weebSelectedSearchTitle
        ) {
          weebUrl.value = "";
          weebSelectedSearchTitle = "";
          weebMangaTitle = "";
          clearLoadedWeebSeries();
          updateWeebControls();
        }


        if (query.length < 2) {

          if (weebSearchController) {
            weebSearchController.abort();
          }

          hideWeebSuggestions();
          return;

        }


        weebSearchTimer = setTimeout(
          function () {
            searchWeebCentralTitles(
              query
            );
          },
          350
        );

      }
    );


    weebSearch.addEventListener(
      "keydown",
      function (event) {

        if (
          !weebSuggestions.classList.contains(
            "show"
          )
        ) {
          return;
        }


        if (event.key === "ArrowDown") {

          event.preventDefault();

          setWeebSearchActiveIndex(
            weebSearchActiveIndex + 1
          );

        } else if (event.key === "ArrowUp") {

          event.preventDefault();

          setWeebSearchActiveIndex(
            weebSearchActiveIndex <= 0
              ? weebSearchResults.length - 1
              : weebSearchActiveIndex - 1
          );

        } else if (
          event.key === "Enter" &&
          weebSearchActiveIndex >= 0
        ) {

          event.preventDefault();

          selectWeebSearchResult(
            weebSearchActiveIndex
          );

        } else if (event.key === "Escape") {

          hideWeebSuggestions();

        }

      }
    );


    document.addEventListener(
      "click",
      function (event) {

        if (
          !weebSearch.parentElement.contains(
            event.target
          )
        ) {
          hideWeebSuggestions();
        }

      }
    );


    weebUrl.addEventListener(
      "input",
      function () {
        clearLoadedWeebSeries();
        updateWeebControls();
      }
    );


    updateWeebControls();


    async function loadWeebSeries(
      options = {}
    ) {

        const seriesUrl =
          weebUrl.value.trim();

        const selectionBeforeLoad =
          weebSelection.value.trim();

        const shouldThrow =
          Boolean(options.throwOnError);


        if (!seriesUrl) {
          const error =
            new Error(
              "Enter a WeebCentral series URL"
            );

          if (shouldThrow) {
            throw error;
          }

          showMessage(
            error.message,
            "error"
          );
          return false;
        }


        weebLoadBtn.disabled = true;
        weebDownloadBtn.disabled = true;
        weebLoadBtn.textContent =
          "Loading...";


        try {

          const response =
            await fetch(
              "/weebcentral/series?url=" +
              encodeURIComponent(seriesUrl)
            );


          const data =
            await response.json();


          if (!response.ok) {
            throw new Error(
              data.error ||
              "Cannot load chapters"
            );
          }


          weebMangaTitle = data.title;
          weebChapters =
            Array.isArray(data.chapters)
              ? data.chapters
              : [];
          weebLoadedSeriesUrl = seriesUrl;


          weebChapterPreview.textContent =
            weebMangaTitle +
            "\\n\\n" +
            weebChapters.map(
              function (chapter) {
                return (
                  String(chapter.index)
                    .padStart(4, " ") +
                  "  " +
                  chapter.title +
                  (chapter.date
                    ? "  " + chapter.date
                    : "")
                );
              }
            ).join("\\n");


          weebChapterPreview.classList.add(
            "show"
          );

          weebSelection.disabled = false;
          weebSelection.value =
            selectionBeforeLoad || "all";
          weebDownloadBtn.disabled = false;


          message.classList.remove("show");

          return true;

        } catch (error) {

          if (shouldThrow) {
            throw error;
          }

          showMessage(
            "WeebCentral: " +
              error.message,
            "error"
          );

          return false;

        } finally {

          weebLoadBtn.disabled = false;
          weebLoadBtn.textContent =
            "Load chapters";
          updateWeebControls();

        }

      }


    weebLoadBtn.addEventListener(
      "click",
      loadWeebSeries
    );


    weebDownloadBtn.addEventListener(
      "click",
      runWeebCentralProcessing
    );


    async function runWeebCentralProcessing() {

      let selectedChapters;

      weebDownloadBtn.disabled = true;


      try {

        const seriesUrl =
          weebUrl.value.trim();

        if (
          !weebChapters.length ||
          weebLoadedSeriesUrl !== seriesUrl
        ) {
          await loadWeebSeries({
            throwOnError: true
          });
        }

        selectedChapters =
          parseChapterSelection(
            weebSelection.value,
            weebChapters
          );
      } catch (error) {
        showMessage(
          "WeebCentral: " +
            error.message,
          "error"
        );
        updateWeebControls();
        return;
      }


      let sendToKindleForRun;


      try {
        sendToKindleForRun =
          await getKindleSendingForRun();
      } catch (error) {
        showMessage(
          error.message,
          "error"
        );
        updateWeebControls();
        return;
      }


      showProcessingScreen();

      const analyticsEventId =
        mangaAnalyticsEventId(
          "weebcentral"
        );
      const analyticsStartedAt =
        new Date().toISOString();
      const analyticsStartedMs =
        Date.now();
      const analyticsRequest =
        weebMangaTitle +
        ": " +
        selectedChapters
          .map(function (chapter) {
            return chapter.title;
          })
          .join(", ");
      sendMangaAnalytics({
        eventId: analyticsEventId,
        requestType: "manga_download",
        requestText: analyticsRequest,
        resultText: "Processing started",
        status: "received",
        startedAt: analyticsStartedAt,
        metadata: {
          chapters:
            selectedChapters.length,
          sendToKindle:
            sendToKindleForRun
        }
      });


      try {

        const firstChapter =
          selectedChapters[0];

        const lastChapter =
          selectedChapters[
            selectedChapters.length - 1
          ];


        const outputCount =
          await processPdfSourceBatch({
            items: selectedChapters,
            sendToKindleForRun,
            getProgressText:
              function (chapter, index) {
                return (
                  "Downloading " +
                  (index + 1) +
                  "/" +
                  selectedChapters.length +
                  ": " +
                  chapter.title
                );
              },
            fetchPdfZipResponse:
              function (chapter) {
                return fetch(
                  "/weebcentral/chapter",
                  {
                    method: "POST",
                    headers: {
                      "Content-Type":
                        "application/json"
                    },
                    body: JSON.stringify({
                      chapterId: chapter.id,
                      chapterTitle:
                        chapter.title,
                      mangaTitle:
                        weebMangaTitle,
                      shouldMerge
                    })
                  }
                );
              },
            errorPrefix:
              "Chapter download failed",
            getErrorContext:
              function (chapter) {
                return chapter.title;
              },
            getPdfFileName:
              function (chapter) {
                return (
                  weebMangaTitle +
                  " " +
                  chapter.title +
                  ".pdf"
                );
              },
            archiveFileName:
              sanitizeClientFileName(
                weebMangaTitle +
                " " +
                firstChapter.title +
                (firstChapter.id ===
                  lastChapter.id
                  ? ""
                  : " - " +
                    lastChapter.title)
              ) +
              "_processed.zip"
          });


        showProcessingSuccess(
          selectedChapters.length,
          outputCount,
          sendToKindleForRun
        );

        sendMangaAnalytics({
          eventId: analyticsEventId,
          requestType: "manga_download",
          requestText: analyticsRequest,
          resultText:
            outputCount +
            " PDF files created",
          status: "success",
          startedAt: analyticsStartedAt,
          finishedAt:
            new Date().toISOString(),
          durationMs:
            Date.now() -
            analyticsStartedMs,
          metadata: {
            chapters:
              selectedChapters.length,
            outputCount,
            sendToKindle:
              sendToKindleForRun
          }
        });

      } catch (error) {

        showProcessingError(error);

        sendMangaAnalytics({
          eventId: analyticsEventId,
          requestType: "manga_download",
          requestText: analyticsRequest,
          errorText:
            error.message ||
            "Processing failed",
          status: "error",
          startedAt: analyticsStartedAt,
          finishedAt:
            new Date().toISOString(),
          durationMs:
            Date.now() -
            analyticsStartedMs
        });

      } finally {

        weebDownloadBtn.disabled = false;

      }

    }


    uploadArea.addEventListener(
      "click",
      function () {

        fileInput.click();

      }
    );


    uploadArea.addEventListener(
      "dragover",
      function (event) {

        event.preventDefault();

        uploadArea.classList.add(
          "dragover"
        );

      }
    );


    uploadArea.addEventListener(
      "dragleave",
      function () {

        uploadArea.classList.remove(
          "dragover"
        );

      }
    );


    uploadArea.addEventListener(
      "drop",
      function (event) {

        event.preventDefault();

        uploadArea.classList.remove(
          "dragover"
        );

        handleFiles(
          event.dataTransfer.files
        );

      }
    );


    fileInput.addEventListener(
      "change",
      function () {

        handleFiles(
          fileInput.files
        );

      }
    );


    function isSupportedFile(file) {

      const name =
        file.name.toLowerCase();

      return (
        name.endsWith(".pdf") ||
        name.endsWith(".cbz")
      );

    }


    function handleFiles(fileList) {

      selectedFiles =
        Array
          .from(fileList)
          .filter(isSupportedFile);


      if (selectedFiles.length === 0) {

        showMessage(
          "Please select PDF or CBZ files",
          "error"
        );

        filesList.classList.remove(
          "show"
        );

        processBtn.disabled = true;

        return;

      }


      filesContainer.innerHTML = "";


      selectedFiles.forEach(
        function (file) {

          const item =
            document.createElement("div");

          item.className =
            "file-item";

          item.textContent =
            file.name;

          filesContainer.appendChild(
            item
          );

        }
      );


      fileCount.textContent =
        "Files: " +
        selectedFiles.length;


      filesList.classList.add(
        "show"
      );


      processBtn.disabled = false;

      message.classList.remove(
        "show"
      );

    }


    clearBtn.addEventListener(
      "click",
      resetMainScreen
    );


    processBtn.addEventListener(
      "click",
      runUploadedFilesProcessing
    );


    async function runUploadedFilesProcessing() {

      if (
        selectedFiles.length === 0
      ) {
        return;
      }


      let sendToKindleForRun;


      try {
        sendToKindleForRun =
          await getKindleSendingForRun();
      } catch (error) {
        showMessage(
          error.message,
          "error"
        );
        return;
      }


      processBtn.disabled = true;

      showProcessingScreen();

      const analyticsEventId =
        mangaAnalyticsEventId("upload");
      const analyticsStartedAt =
        new Date().toISOString();
      const analyticsStartedMs =
        Date.now();
      const analyticsRequest =
        selectedFiles
          .map(function (file) {
            return file.name;
          })
          .join(", ");
      sendMangaAnalytics({
        eventId: analyticsEventId,
        requestType: "file_processing",
        requestText: analyticsRequest,
        resultText: "Processing started",
        status: "received",
        startedAt: analyticsStartedAt,
        metadata: {
          files: selectedFiles.length,
          sendToKindle:
            sendToKindleForRun
        }
      });


      try {

        const outputCount =
          await processPdfSourceBatch({
            items: selectedFiles,
            sendToKindleForRun,
            getProgressText:
              function (file, index) {
                return (
                  "File " +
                  (index + 1) +
                  "/" +
                  selectedFiles.length +
                  ": " +
                  file.name
                );
              },
            fetchPdfZipResponse:
              function (file) {
                const formData =
                  new FormData();

                formData.append(
                  "file",
                  file
                );

                formData.append(
                  "shouldMerge",
                  String(shouldMerge)
                );

                return fetch(
                  "/process",
                  {
                    method: "POST",
                    body: formData
                  }
                );
              },
            errorPrefix:
              "Processing error",
            getErrorContext:
              function (file) {
                return file.name;
              },
            getPdfFileName:
              function (file) {
                return file.name;
              },
            archiveFileName:
              buildArchiveBaseName(
                selectedFiles
              ) +
              "_processed.zip",
            beforeDownloadText:
              "Creating archive..."
          });


        showProcessingSuccess(
          selectedFiles.length,
          outputCount,
          sendToKindleForRun
        );

        sendMangaAnalytics({
          eventId: analyticsEventId,
          requestType: "file_processing",
          requestText: analyticsRequest,
          resultText:
            outputCount +
            " PDF files created",
          status: "success",
          startedAt: analyticsStartedAt,
          finishedAt:
            new Date().toISOString(),
          durationMs:
            Date.now() -
            analyticsStartedMs,
          metadata: {
            files: selectedFiles.length,
            outputCount,
            sendToKindle:
              sendToKindleForRun
          }
        });

      } catch (error) {

        showProcessingError(error);

        sendMangaAnalytics({
          eventId: analyticsEventId,
          requestType: "file_processing",
          requestText: analyticsRequest,
          errorText:
            error.message ||
            "Processing failed",
          status: "error",
          startedAt: analyticsStartedAt,
          finishedAt:
            new Date().toISOString(),
          durationMs:
            Date.now() -
            analyticsStartedMs
        });


        processBtn.disabled = false;

      }

    }


    async function processPdfSourceBatch(options) {

      const finalZip =
        createFinalZip(
          options.sendToKindleForRun
        );

      const mergeCollector =
        await createPdfMergeCollector(
          finalZip,
          options.sendToKindleForRun,
          shouldMerge
        );


      for (
        let i = 0;
        i < options.items.length;
        i++
      ) {

        const item =
          options.items[i];

        progressText.textContent =
          options.getProgressText(
            item,
            i
          );

        const response =
          await options.fetchPdfZipResponse(
            item,
            i
          );

        await ensureSuccessfulResponse(
          response,
          options.errorPrefix,
          options.getErrorContext(item)
        );

        await addPdfEntriesFromZipResponse(
          response,
          mergeCollector,
          options.getPdfFileName(item)
        );

      }


      progressText.textContent =
        "Merging PDFs up to 200 MB...";

      const outputCount =
        await mergeCollector.finish();


      if (!options.sendToKindleForRun) {

        if (options.beforeDownloadText) {
          progressText.textContent =
            options.beforeDownloadText;
        }

        await downloadFinalZip(
          finalZip,
          options.archiveFileName
        );

      }


      return outputCount;

    }


    newFileBtn.addEventListener(
      "click",
      function () {

        resetMainScreen();

        showMainInputScreen();

      }
    );


    function resetMainScreen() {

      fileInput.value = "";

      selectedFiles = [];

      successKindleSummary = null;
      successKindleQueue.textContent = "";

      filesList.classList.remove(
        "show"
      );

      processBtn.disabled = true;

      message.classList.remove(
        "show"
      );

    }


    function parseChapterSelection(
      value,
      chapters
    ) {

      const normalized =
        String(value || "")
          .trim()
          .toLowerCase();


      if (!normalized) {
        throw new Error(
          "Enter a chapter selection"
        );
      }


      if (normalized === "all") {
        return chapters.slice();
      }


      let expression = normalized
        .replace(/^single\\s+/, "")
        .replace(/^range\\s+/, "");


      let indices = [];


      if (expression.includes(",")) {

        indices = expression
          .split(",")
          .map(function (item) {
            return Number(item.trim());
          });

      } else if (
        /^\\d+\\s*-\\s*\\d+$/.test(
          expression
        )
      ) {

        const limits = expression
          .split("-")
          .map(function (item) {
            return Number(item.trim());
          });


        const start = limits[0];
        const end = limits[1];


        if (start > end) {
          throw new Error(
            "The range start must not exceed the end"
          );
        }


        for (let i = start; i <= end; i++) {
          indices.push(i);
        }

      } else {

        indices = [Number(expression)];

      }


      const uniqueIndices =
        Array.from(new Set(indices));


      if (
        uniqueIndices.length === 0 ||
        uniqueIndices.some(
          function (index) {
            return (
              !Number.isInteger(index) ||
              index < 1 ||
              index > chapters.length
            );
          }
        )
      ) {
        throw new Error(
          "Chapter numbers must be between 1 and " +
          chapters.length
        );
      }


      return uniqueIndices.map(
        function (index) {
          return chapters[index - 1];
        }
      );

    }


    function triggerBlobDownload(
      blob,
      fileName
    ) {

      const url =
        window.URL.createObjectURL(blob);

      const link =
        document.createElement("a");

      link.href = url;
      link.download = fileName;

      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      setTimeout(
        function () {
          window.URL.revokeObjectURL(url);
        },
        1000
      );

    }


    function createFinalZip(
      sendToKindleForRun
    ) {

      return sendToKindleForRun
        ? null
        : new JSZip();

    }


    async function createZipBlob(
      zip
    ) {

      return zip.generateAsync({
        type: "blob",
        compression: "DEFLATE",
        compressionOptions: {
          level: 6
        }
      });

    }


    async function downloadFinalZip(
      zip,
      fileName
    ) {

      const blob =
        await createZipBlob(
          zip
        );

      triggerBlobDownload(
        blob,
        fileName
      );

    }


    function showProcessingSuccess(
      processedCount,
      outputCount,
      sendToKindleForRun
    ) {

      showSuccessScreen();

      successFileCount.textContent =
        processedCount;

      successOutputCount.textContent =
        outputCount;

      downloadStatus.textContent =
        sendToKindleForRun
          ? "Amazon confirmed the PDF files in your Kindle library. Device sync may take a few minutes."
          : "Archive downloaded. Kindle auto-send is off.";

      setSuccessKindleSummary(
        sendToKindleForRun,
        outputCount
      );

    }


    function showProcessingError(
      error
    ) {

      showMainInputScreen();

      showMessage(
        "Error: " +
        error.message,
        "error"
      );

    }


    function showProcessingScreen() {

      mainContent.classList.add(
        "hidden"
      );

      successScreen.classList.remove(
        "show"
      );

      progressScreen.classList.add(
        "show"
      );

    }


    function showSuccessScreen() {

      progressScreen.classList.remove(
        "show"
      );

      mainContent.classList.add(
        "hidden"
      );

      successScreen.classList.add(
        "show"
      );

    }


    function showMainInputScreen() {

      progressScreen.classList.remove(
        "show"
      );

      successScreen.classList.remove(
        "show"
      );

      mainContent.classList.remove(
        "hidden"
      );

    }


    async function readErrorTextFromResponse(
      response,
      fallback
    ) {

      try {
        const errorData =
          await response.json();

        return (
          errorData.error ||
          fallback
        );
      } catch (_) {
        return fallback;
      }

    }


    async function ensureSuccessfulResponse(
      response,
      fallback,
      contextLabel
    ) {

      if (response.ok) {
        return;
      }


      const errorText =
        await readErrorTextFromResponse(
          response,
          fallback
        );


      throw new Error(
        contextLabel +
        ": " +
        errorText
      );

    }


    async function addPdfEntriesFromZipResponse(
      response,
      mergeCollector,
      sourceName
    ) {

      const archiveZip =
        await JSZip.loadAsync(
          await response.arrayBuffer()
        );


      for (
        const [name, entry]
        of Object.entries(
          archiveZip.files
        )
      ) {

        if (
          entry.dir ||
          !name
            .toLowerCase()
            .endsWith(".pdf")
        ) {
          continue;
        }


        await mergeCollector.add({
          bytes:
            await entry.async(
              "uint8array"
            ),
          sourceName
        });

      }

    }


    function createPdfCollectorOperationTools(
      combineAcrossSources
    ) {

      function assertPageSize(
        width,
        height,
        label
      ) {

        if (
          !Number.isFinite(width) ||
          !Number.isFinite(height) ||
          width <= 0 ||
          height <= 0
        ) {
          throw new Error(
            label +
            ": invalid page size " +
            width +
            "x" +
            height
          );
        }

      }


      function addSinglePageSpread(
        targetPdf,
        item
      ) {

        const pageWidth =
          item.width * 2;

        assertPageSize(
          pageWidth,
          item.height,
          "Single manga spread"
        );

        return targetPdf.embedPage(
          item.page
        ).then((embeddedPage) => {
          const spreadPage =
            targetPdf.addPage([
              pageWidth,
              item.height
            ]);

          spreadPage.drawPage(
            embeddedPage,
            {
              x: item.width,
              y: 0,
              width: item.width,
              height: item.height
            }
          );
        });

      }


      async function addOperation(
        targetPdf,
        operation
      ) {

        if (
          operation.type === "single"
        ) {

          const item =
            operation.item;

          if (
            combineAcrossSources &&
            item.isVertical
          ) {
            await addSinglePageSpread(
              targetPdf,
              item
            );
            return;
          }

          const copiedPages =
            await targetPdf.copyPages(
              item.sourcePdf,
              [item.pageIndex]
            );

          targetPdf.addPage(
            copiedPages[0]
          );
          return;
        }

        const first =
          operation.first;
        const second =
          operation.second;
        const pageWidth =
          first.width + second.width;
        const pageHeight =
          Math.max(
            first.height,
            second.height
          );

        assertPageSize(
          pageWidth,
          pageHeight,
          "Merged PDF page"
        );

        const embeddedFirst =
          await targetPdf.embedPage(
            first.page
          );
        const embeddedSecond =
          await targetPdf.embedPage(
            second.page
          );
        const mergedPage =
          targetPdf.addPage([
            pageWidth,
            pageHeight
          ]);

        mergedPage.drawPage(
          embeddedSecond,
          {
            x: 0,
            y:
              (pageHeight - second.height) /
              2,
            width: second.width,
            height: second.height
          }
        );
        mergedPage.drawPage(
          embeddedFirst,
          {
            x: second.width,
            y:
              (pageHeight - first.height) /
              2,
            width: first.width,
            height: first.height
          }
        );

      }


      function getOperationSources(
        operation
      ) {

        const names = [
          operation.type === "single"
            ? operation.item.sourceName
            : operation.first.sourceName
        ];

        if (
          operation.type === "pair" &&
          !names.includes(
            operation.second.sourceName
          )
        ) {
          names.push(
            operation.second.sourceName
          );
        }

        return names;

      }


      return {
        assertPageSize,
        addOperation,
        getOperationSources
      };

    }


    async function createPdfMergeCollector(
      zip,
      sendToKindleForRun,
      combineAcrossSources
    ) {

      const maxSize =
        185 * 1024 * 1024;

      const operationTools =
        createPdfCollectorOperationTools(
          combineAcrossSources
        );

      let currentPdf =
        await PDFLib.PDFDocument.create();

      let currentBytes = null;
      let currentHasPages = false;
      let currentSources = [];
      let outputCount = 0;
      let pendingSinglePage = null;


      function rememberSourceName(
        sourceName
      ) {

        if (
          !currentSources.includes(
            sourceName
          )
        ) {
          currentSources.push(
            sourceName
          );
        }

      }


      function getPdfPageInfo(
        sourcePdf,
        sourcePages,
        pageIndex,
        sourceName
      ) {

        const page =
          sourcePages[pageIndex];

        const size =
          page.getSize();

        operationTools.assertPageSize(
          size.width,
          size.height,
          sourceName +
          " page " +
          (pageIndex + 1)
        );

        return {
          sourcePdf,
          sourceName,
          pageIndex,
          page,
          width:
            size.width,
          height:
            size.height,
          isVertical:
            size.width <= size.height,
          canBridgeWithoutCurrentPages:
            false
        };

      }


      async function addCollectorOperationToPdf(
        targetPdf,
        operation
      ) {
        await operationTools.addOperation(
          targetPdf,
          operation
        );

      }


      function getOperationSources(
        operation
      ) {
        return operationTools.getOperationSources(
          operation
        );

      }


      async function operationFitsCurrentPdf(
        operation
      ) {

        if (
          !currentHasPages ||
          !currentBytes
        ) {
          return true;
        }

        const trialPdf =
          await PDFLib.PDFDocument.load(
            currentBytes,
            {
              ignoreEncryption: true
            }
          );

        await addCollectorOperationToPdf(
          trialPdf,
          operation
        );

        const trialBytes =
          await trialPdf.save({
            useObjectStreams: true
          });

        return trialBytes.length <= maxSize;

      }


      async function commitOperation(
        operation
      ) {

        await addCollectorOperationToPdf(
          currentPdf,
          operation
        );

        const candidateBytes =
          await currentPdf.save({
            useObjectStreams: true
          });

        const operationSources =
          getOperationSources(
            operation
          );

        if (
          candidateBytes.length > maxSize &&
          currentHasPages &&
          currentBytes
        ) {

          await emitCurrentPdf();


          await addCollectorOperationToPdf(
            currentPdf,
            operation
          );

          currentBytes =
            await currentPdf.save({
              useObjectStreams: true
            });

          currentHasPages = true;

          operationSources.forEach(
            rememberSourceName
          );

        } else {

          currentBytes =
            candidateBytes;

          currentHasPages = true;

          operationSources.forEach(
            rememberSourceName
          );

        }


        if (
          currentBytes.length > maxSize
        ) {

          await emitCurrentPdf();

        }

      }


      async function flushPendingSinglePage() {

        if (
          !pendingSinglePage
        ) {
          return;
        }

        const item =
          pendingSinglePage;

        pendingSinglePage = null;

        await commitOperation({
          type: "single",
          item
        });

      }


      async function emitCurrentPdf() {

        if (
          !currentHasPages ||
          !currentBytes
        ) {
          return;
        }


        outputCount += 1;

        const fileName =
          buildMergedPdfName(
            currentSources,
            outputCount
          );


        if (sendToKindleForRun) {

          progressText.textContent =
            "Queueing for Kindle: " +
            fileName;

          await uploadPdfToKindle(
            fileName,
            currentBytes
          );

        } else {

          zip.file(
            fileName,
            currentBytes
          );

        }


        currentPdf =
          await PDFLib.PDFDocument.create();

        currentBytes = null;
        currentHasPages = false;
        currentSources = [];

      }


      async function add(part) {

        const partBytes =
          part.bytes;

        const sourceName =
          part.sourceName;

        const sourcePdf =
          await PDFLib.PDFDocument.load(
            partBytes,
            {
              ignoreEncryption: true
            }
          );


        const sourcePages =
          sourcePdf.getPages();


        if (
          sourcePages.length === 0
        ) {
          return;
        }


        let startIndex = 0;
        let committedSourceOperations = 0;


        if (
          pendingSinglePage
        ) {

          const firstPage =
            getPdfPageInfo(
              sourcePdf,
              sourcePages,
              0,
              sourceName
            );

          const canBridgeInCurrentFile =
            currentHasPages ||
            pendingSinglePage
              .canBridgeWithoutCurrentPages;

          const pairOperation = {
            type: "pair",
            first:
              pendingSinglePage,
            second:
              firstPage
          };

          if (
            combineAcrossSources &&
            pendingSinglePage.sourceName !==
              sourceName &&
            firstPage.isVertical &&
            canBridgeInCurrentFile &&
            await operationFitsCurrentPdf(
              pairOperation
            )
          ) {

            pendingSinglePage = null;

            await commitOperation(
              pairOperation
            );

            startIndex = 1;
            committedSourceOperations += 1;

          } else {

            await flushPendingSinglePage();

          }

        }


        for (
          let pageIndex = startIndex;
          pageIndex < sourcePages.length;
          pageIndex++
        ) {

          const pageInfo =
            getPdfPageInfo(
              sourcePdf,
              sourcePages,
              pageIndex,
              sourceName
            );

          const isLastPage =
            pageIndex ===
            sourcePages.length - 1;

          if (
            combineAcrossSources &&
            isLastPage &&
            pageInfo.isVertical
          ) {

            pageInfo
              .canBridgeWithoutCurrentPages =
              committedSourceOperations === 0;

            pendingSinglePage =
              pageInfo;

            continue;

          }


          await commitOperation({
            type: "single",
            item: pageInfo
          });

          committedSourceOperations += 1;

        }

      }


      async function finish() {

        await flushPendingSinglePage();


        await emitCurrentPdf();


        if (outputCount === 0) {
          throw new Error(
            "No processed PDF files"
          );
        }


        return outputCount;

      }


      return {
        add,
        finish
      };

    }


    async function uploadPdfToKindle(
      fileName,
      pdfBytes
    ) {

      const blob = new Blob(
        [pdfBytes],
        {
          type: "application/pdf"
        }
      );


      const ticketResponse = await fetch(
        "/kindle/upload-ticket",
        {
          method: "POST",
          headers: {
            "Content-Type":
              "application/json"
          },
          body: JSON.stringify({
            filename: fileName,
            size: blob.size
          })
        }
      );

      const ticket =
        await ticketResponse.json();


      if (!ticketResponse.ok) {
        throw new Error(
          ticket.error ||
          "Cannot create Kindle upload"
        );
      }


      const maxChunkAttempts = 5;
      let uploadResult = null;
      let lastUploadError = null;
      let receivedBytes = 0;

      while (!uploadResult) {
        const range = nextKindleUploadRange(
          blob.size,
          receivedBytes
        );
        const finalizing =
          range.start === blob.size;
        let chunkAdvanced = false;

        for (
          let attempt = 1;
          attempt <= maxChunkAttempts;
          attempt += 1
        ) {
          progressText.textContent =
            (finalizing
              ? "Finalizing Kindle upload"
              : "Uploading PDF to Kindle worker: " +
                range.percent + "%") +
            " (chunk attempt " +
            attempt +
            "/" +
            maxChunkAttempts +
            "): " +
            fileName;

          try {
            const separator =
              ticket.uploadUrl.includes("?")
                ? "&"
                : "?";
            const uploadResponse = await fetch(
              ticket.uploadUrl +
                separator +
                "offset=" +
                encodeURIComponent(range.start),
              {
                method: "PUT",
                headers: {
                  "Content-Type":
                    "application/pdf"
                },
                body: blob.slice(
                  range.start,
                  range.end,
                  "application/pdf"
                )
              }
            );

            let currentResult = {};
            try {
              currentResult =
                await uploadResponse.json();
            } catch (_) {}

            if (uploadResponse.ok && currentResult.job) {
              uploadResult = currentResult;
              receivedBytes = blob.size;
              chunkAdvanced = true;
              break;
            }

            const reported =
              acceptedKindleUploadProgress(
                currentResult.receivedBytes,
                blob.size
              );
            if (
              !finalizing &&
              reported !== null &&
              reported > receivedBytes
            ) {
              receivedBytes = reported;
              chunkAdvanced = true;
              break;
            }

            lastUploadError = new Error(
              currentResult.error ||
              "Cannot queue PDF for Kindle"
            );
          } catch (error) {
            lastUploadError = error;
          }

          const recovered =
            await getKindleUploadProgress(
              ticket.statusUrl
            );
          if (recovered?.job) {
            uploadResult = recovered;
            receivedBytes = blob.size;
            chunkAdvanced = true;
            break;
          }

          const existingJob =
            await getKindleJobIfExists(
              ticket.jobId
            );
          if (existingJob) {
            uploadResult = { job: existingJob };
            receivedBytes = blob.size;
            chunkAdvanced = true;
            break;
          }

          const recoveredBytes =
            acceptedKindleUploadProgress(
              recovered?.receivedBytes,
              blob.size
            );
          if (
            !finalizing &&
            recoveredBytes !== null &&
            recoveredBytes > receivedBytes
          ) {
            receivedBytes = recoveredBytes;
            chunkAdvanced = true;
            break;
          }

          if (attempt < maxChunkAttempts) {
            progressText.textContent =
              "Retrying interrupted Kindle upload at " +
              Math.floor(
                (receivedBytes / blob.size) * 100
              ) +
              "%: " +
              fileName;

            await new Promise(
              function (resolve) {
                setTimeout(
                  resolve,
                  Math.min(2000 * attempt, 8000)
                );
              }
            );
          }
        }

        if (!chunkAdvanced) break;
      }


      if (!uploadResult) {
        throw lastUploadError ||
          new Error(
            "Cannot queue PDF for Kindle"
          );
      }


      const jobId =
        uploadResult.job?.id ||
        ticket.jobId;

      if (!jobId) {
        throw new Error(
          "Kindle uploader did not return a job ID"
        );
      }


      await waitForKindleJob(
        jobId,
        fileName
      );


      const refreshed =
        await refreshKindleStatus();

      if (!refreshed) {
        throw new Error(
          "Amazon confirmed the file, but Kindle status refresh failed"
        );
      }

    }


    async function getKindleUploadProgress(
      statusUrl
    ) {

      if (!statusUrl) {
        return null;
      }

      try {
        const response = await fetch(
          statusUrl,
          { cache: "no-store" }
        );
        const data = await response.json();
        return response.ok ? data : null;
      } catch (_) {
        return null;
      }

    }


    async function getKindleJobIfExists(
      jobId
    ) {

      if (!jobId) {
        return null;
      }

      try {
        const response = await fetch(
          "/kindle/jobs/" +
            encodeURIComponent(jobId),
          { cache: "no-store" }
        );

        if (response.status === 404) {
          return null;
        }

        const data = await response.json();

        return response.ok
          ? (data.job || null)
          : null;
      } catch (_) {
        return null;
      }

    }


    async function waitForKindleJob(
      jobId,
      fileName
    ) {

      const deadline =
        Date.now() + 50 * 60 * 1000;

      let consecutiveStatusErrors = 0;


      while (Date.now() < deadline) {

        let response;
        let data;

        try {
          response = await fetch(
            "/kindle/jobs/" +
              encodeURIComponent(jobId),
            { cache: "no-store" }
          );

          data = await response.json();

          if (!response.ok) {
            throw new Error(
              data.error ||
              "Kindle job status unavailable"
            );
          }

          consecutiveStatusErrors = 0;
        } catch (error) {
          consecutiveStatusErrors += 1;

          if (consecutiveStatusErrors >= 5) {
            throw error;
          }

          await new Promise(
            function (resolve) {
              setTimeout(resolve, 2500);
            }
          );
          continue;
        }


        const job = data.job || {};

        if (job.status === "sent") {
          const delivery =
            classifyKindleSentJob(job);

          if (!delivery.accepted) {
            throw new Error(
              "Worker marked the file sent without Amazon submission confirmation"
            );
          }

          progressText.textContent =
            delivery.confirmation ===
              "in_library"
              ? "Confirmed in Amazon library: " +
                fileName
              : "Accepted by Amazon; delivery to the library continues: " +
                fileName;

          return job;
        }

        if (job.status === "failed") {
          throw new Error(
            job.error ||
            "Amazon did not accept " +
              fileName
          );
        }

        if (job.status === "waiting_auth") {
          throw new Error(
            "Amazon session expired while sending " +
              fileName +
              ". Reconnect Amazon and try again."
          );
        }

        if (job.status === "verifying") {
          progressText.textContent =
            "Waiting for Amazon to accept the submission: " +
            fileName;
        } else if (job.status === "processing") {
          progressText.textContent =
            "Uploading to Amazon: " +
            fileName;
        } else {
          progressText.textContent =
            "Queued for Amazon: " +
            fileName;
        }


        await new Promise(
          function (resolve) {
            setTimeout(resolve, 2500);
          }
        );

      }


      throw new Error(
        "Timed out waiting for Amazon to accept " +
          fileName
      );

    }


    function buildArchiveBaseName(
      files
    ) {

      const names =
        files.map(
          function (file) {
            return getClientFileBaseName(
              file.name
            );
          }
        );


      let common =
        names[0] || "manga";


      for (
        let i = 1;
        i < names.length;
        i++
      ) {

        while (
          common &&
          !names[i]
            .toLowerCase()
            .startsWith(
              common.toLowerCase()
            )
        ) {
          common =
            common.slice(0, -1);
        }

      }


      common = common
        .replace(
          /[\\s._-]*\\d[\\d\\s._-]*$/,
          ""
        )
        .replace(
          /[\\s._-]+$/,
          ""
        );


      if (common.length >= 3) {
        return sanitizeClientFileName(
          common
        );
      }


      const fallback =
        names[0] || "manga";


      return sanitizeClientFileName(
        names.length > 1
          ? fallback +
            "_and_" +
            (names.length - 1) +
            "_more"
          : fallback
      );

    }


    function buildMergedPdfName(
      sourceNames,
      outputIndex
    ) {

      const labels = [];


      sourceNames.forEach(
        function (sourceName) {

          const label =
            getClientFileBaseName(
              sourceName
            );


          if (!labels.includes(label)) {
            labels.push(label);
          }

        }
      );


      let sourceLabel =
        labels.join(" + ");


      if (sourceLabel.length > 170) {

        sourceLabel =
          labels[0] +
          " -- " +
          labels[labels.length - 1] +
          " (" +
          labels.length +
          " files)";

      }


      return sanitizeClientFileName(
        sourceLabel || "manga"
      ) +
      "__part_" +
      outputIndex +
      ".pdf";

    }


    function getClientFileBaseName(
      fileName
    ) {

      const cleanName =
        String(fileName)
          .split("/")
          .pop() || "manga";


      return cleanName.replace(
        /\\.[^/.]+$/,
        ""
      );

    }


    function sanitizeClientFileName(
      name
    ) {

      return (
        String(name)
          .replace(
            /[<>:"|?*]/g,
            "_"
          )
          .split("/")
          .join("_")
          .split(
            String.fromCharCode(92)
          )
          .join("_")
          .replace(
            /\\s+/g,
            " "
          )
          .trim()
          .slice(0, 220) ||
        "manga"
      );

    }


    function showMessage(
      text,
      type
    ) {

      message.textContent = text;

      message.className =
        "message show " +
        type;

    }

  </script>

</body>
</html>`;


function buildLoginPage(errorText = "") {

  const safeError = String(errorText)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");


  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Manga PDF Processor — вход</title>
  <style>
    *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:20px;font-family:system-ui,sans-serif;background:linear-gradient(135deg,#667eea,#764ba2)}
    form{width:min(420px,100%);padding:32px;border-radius:14px;background:white;box-shadow:0 20px 60px rgba(0,0,0,.3)}
    h1{margin:0 0 8px;color:#333;font-size:24px}p{margin:0 0 22px;color:#666;font-size:14px;line-height:1.5}
    input,button{width:100%;padding:12px 14px;border-radius:8px;font:inherit}input{border:1px solid #d0d0d0;margin-bottom:12px}button{border:0;background:#667eea;color:white;font-weight:700;cursor:pointer}.error{margin-bottom:12px;color:#8c2530;font-size:13px}
  </style>
</head>
<body>
  <form method="post" action="/login">
    <h1>Manga PDF Processor</h1>
    <p>Введите пароль приложения. Пароль Amazon здесь не используется.</p>
    ${safeError ? `<div class="error">${safeError}</div>` : ""}
    <input type="password" name="password" placeholder="Пароль приложения" autocomplete="current-password" required autofocus>
    <button type="submit">Войти</button>
  </form>
</body>
</html>`;

}


app.use("*", async (c, next) => {

  const pathname =
    new URL(c.req.url).pathname;

  const appPassword =
    process.env.APP_PASSWORD || "";

  const sessionToken =
    process.env.APP_SESSION_TOKEN || "";


  if (
    !appPassword ||
    pathname === "/login" ||
    pathname === "/health"
  ) {
    await next();
    return;
  }


  const cookie =
    c.req.header("Cookie") || "";

  const authenticated =
    readCookie(cookie, "manga_session") ===
      sessionToken;


  if (authenticated) {
    await next();
    return;
  }


  if (
    pathname.startsWith("/process") ||
    pathname.startsWith("/weebcentral/") ||
    pathname.startsWith("/kindle/") ||
    pathname.startsWith("/analytics/")
  ) {
    return c.json(
      { error: "Authentication required" },
      401
    );
  }


  return c.html(
    buildLoginPage(),
    401
  );

});


/* ============================================================
   ROUTES
   ============================================================ */


app.get("/health", (c) => {
  return c.json({ ok: true });
});


app.get("/login", (c) => {
  return c.html(buildLoginPage());
});


app.post("/login", async (c) => {

  const formData =
    await c.req.formData();

  const password = String(
    formData.get("password") || ""
  );

  const appPassword =
    process.env.APP_PASSWORD || "";

  const sessionToken =
    process.env.APP_SESSION_TOKEN || "";


  if (
    !appPassword ||
    !sessionToken ||
    password !== appPassword
  ) {
    return c.html(
      buildLoginPage("Неверный пароль"),
      401
    );
  }


  c.header(
    "Set-Cookie",
    "manga_session=" +
      encodeURIComponent(sessionToken) +
      "; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000"
  );

  return c.redirect("/");

});


app.get("/logout", (c) => {
  c.header(
    "Set-Cookie",
    "manga_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0"
  );
  return c.redirect("/login");
});


app.get("/", (c) => {

  return c.html(
    htmlContent
  );

});


app.post("/analytics/events", async (c) => {
  try {
    const body = await c.req.json();
    await analyticsReporter.report(body);
    return c.json(
      { ok: true, eventId: body.eventId },
      202
    );
  } catch (error) {
    console.warn(
      "Manga web analytics event failed",
      error
    );
    return c.json(
      { error: "Analytics event rejected" },
      400
    );
  }
});


app.get(
  "/kindle/status",
  async (c) => {

    try {
      const data =
        await getKindleWorkerStatus();


      return c.json(data);
    } catch (error) {
      return c.json(
        {
          error:
            error.message ||
            "Kindle worker unavailable"
        },
        502
      );
    }

  }
);


app.get(
  "/kindle/jobs/:id",
  async (c) => {

    try {
      const result =
        await getKindleWorkerJob(
          c.req.param("id")
        );


      return c.json(
        result.data,
        result.status
      );
    } catch (error) {
      return c.json(
        {
          error:
            error.message ||
            "Kindle job status unavailable"
        },
        502
      );
    }

  }
);


app.get(
  "/kindle/connect",
  async (c) => {

    try {
      const url =
        await createKindleConnectionUrl();


      return c.redirect(url);
    } catch (error) {
      return c.text(
        "Cannot open Amazon connection: " +
          (error.message || error),
        502
      );
    }

  }
);


app.post(
  "/kindle/upload-ticket",
  async (c) => {

    try {
      const body = await c.req.json();

      const result =
        await createKindleUploadTicket(
          body.filename,
          body.size
        );


      return c.json(
        result.data,
        result.status
      );
    } catch (error) {
      return c.json(
        {
          error:
            error.message ||
            "Cannot create Kindle upload"
        },
        502
      );
    }

  }
);

app.get(
  "/weebcentral/search",
  async (c) => {

    try {

      const query = String(
        c.req.query("q") || ""
      ).trim();


      const results =
        await searchWeebCentralSeries(
          query
        );


      return c.json({
        results
      });

    } catch (error) {

      console.error(
        "WeebCentral search error:",
        error
      );


      return c.json(
        {
          error:
            error.message ||
            "Cannot search WeebCentral"
        },
        502
      );

    }

  }
);


app.get(
  "/weebcentral/series",
  async (c) => {

    try {

      const seriesUrl =
        c.req.query("url");

      const series =
        await loadWeebCentralSeries(
          seriesUrl
        );


      return c.json({
        title:
          series.title,
        coverUrl:
          series.coverUrl,
        chapters:
          series.chapters
      });

    } catch (error) {

      return c.json(
        {
          error:
            error.message ||
            "Cannot load WeebCentral series"
        },
        400
      );

    }

  }
);


app.post(
  "/weebcentral/chapter",
  async (c) => {

    try {

      const body =
        await c.req.json();

      const result =
        await processWeebCentralChapterArchive(
          body
        );


      return c.body(
        result.archiveData,
        {
          headers:
            createZipArchiveHeaders(
              result.outputCount
            )
        }
      );

    } catch (error) {

      const status =
        getRouteErrorStatus(error);


      if (status >= 500) {

        console.error(
          "WeebCentral chapter error:",
          error
        );

      }

      return c.json(
        {
          error:
            getRouteErrorMessage(
              error,
              "Cannot process chapter"
            )
        },
        status
      );

    }

  }
);


app.post(
  "/process",
  async (c) => {

    try {

      const formData =
        await c.req.formData();

      const result =
        await processUploadedArchive(
          formData
        );


      return c.body(
        result.archiveData,
        {
          headers:
            createZipArchiveHeaders(
              result.outputCount
            )
        }
      );

    } catch (error) {

      const status =
        getRouteErrorStatus(error);


      if (status >= 500) {

        console.error(
          "Error in /process:",
          error
        );

      }


      return c.json(
        {
          error:
            getRouteErrorMessage(
              error,
              "Processing error"
            )
        },
        status
      );

    }

  }
);


/* ============================================================
   WEEBCENTRAL ARCHIVE HELPERS
   ============================================================ */


async function processWeebCentralChapterArchive(
  body
) {

  const input =
    getWeebCentralChapterArchiveInput(
      body
    );

  const images =
    await downloadWeebCentralChapterImages(
      input.chapterId
    );

  const session =
    createZipSession();

  if (
    input.outputFormat === "images"
  ) {
    writeChapterImagesToZip(
      images,
      session
    );

    return {
      archiveData:
        await generateZipArchive(
          session
        ),
      outputCount: images.length
    };
  }

  const outputCount =
    await writeOperationsToZip({
      operations:
        buildOperations(
          images,
          input.shouldMerge
        ),
      baseFileName:
        input.mangaTitle +
        " " +
        input.chapterTitle,
      session,
      addOperation:
        async function (
          targetPdf,
          operation
        ) {
          await addImageOperation(
            targetPdf,
            operation
          );
        }
    });


  return {
    archiveData:
      await generateZipArchive(
        session
      ),
    outputCount
  };

}


function getWeebCentralChapterArchiveInput(
  body
) {

  const chapterId =
    String(
      body.chapterId || ""
    );


  if (
    !isValidWeebCentralChapterId(
      chapterId
    )
  ) {

    throw createRouteError(
      "Invalid chapter ID",
      400
    );

  }

  const outputFormat =
    String(
      body.outputFormat || "pdf"
    ).toLowerCase();

  if (
    outputFormat !== "pdf" &&
    outputFormat !== "images"
  ) {
    throw createRouteError(
      "Invalid chapter output format",
      400
    );
  }


  return {
    chapterId,
    mangaTitle:
      sanitizeFileName(
        body.mangaTitle || "Manga"
      ),
    chapterTitle:
      sanitizeFileName(
        body.chapterTitle ||
        "Chapter"
      ),
    outputFormat,
    shouldMerge:
      body.shouldMerge !== false
  };

}


function writeChapterImagesToZip(
  images,
  session
) {

  const pages =
    images.map(
      function (image, index) {
        const extension =
          image.format === "jpg"
            ? "jpg"
            : "png";
        const fileName =
          "pages/page_" +
          String(index + 1)
            .padStart(4, "0") +
          "." + extension;

        session.zip.file(
          fileName,
          image.bytes
        );

        return {
          fileName,
          width: image.width,
          height: image.height,
          format: image.format
        };
      }
    );

  session.zip.file(
    "manifest.json",
    JSON.stringify({
      version: 1,
      pages
    })
  );

}


/* ============================================================
   UPLOAD ARCHIVE HELPERS
   ============================================================ */


async function processUploadedArchive(
  formData
) {

  const input =
    getUploadedArchiveInput(
      formData
    );

  const session =
    createZipSession();

  const outputCount =
    await processUploadedFile(
      input.file,
      input.shouldMerge,
      session
    );


  if (outputCount < 1) {

    throw createRouteError(
      "No pages or images found",
      400
    );

  }


  return {
    archiveData:
      await generateZipArchive(
        session
      ),
    outputCount
  };

}


function getUploadedArchiveInput(
  formData
) {

  const file =
    formData.get("file");


  if (
    !file ||
    typeof file === "string"
  ) {

    throw createRouteError(
      "Missing file",
      400
    );

  }


  return {
    file,
    shouldMerge:
      formData.get(
        "shouldMerge"
      ) === "true"
  };

}


async function processUploadedFile(
  file,
  shouldMerge,
  session
) {

  const fileName =
    file.name || "input";

  const baseFileName =
    getBaseFileName(
      fileName
    );

  const inputBytes =
    await file.arrayBuffer();

  const lowerName =
    fileName.toLowerCase();


  if (
    lowerName.endsWith(".pdf")
  ) {

    return processPdfFile(
      inputBytes,
      baseFileName,
      shouldMerge,
      session
    );

  }


  if (
    lowerName.endsWith(".cbz")
  ) {

    return processCbzFile(
      inputBytes,
      baseFileName,
      shouldMerge,
      session
    );

  }


  throw createRouteError(
    "Unsupported file type",
    400
  );

}


function createZipSession() {

  return {
    zip: new JSZip()
  };

}


async function generateZipArchive(
  session
) {

  return session.zip.generateAsync({
    type: "arraybuffer",
    compression: "STORE"
  });

}


function createZipArchiveHeaders(
  outputCount
) {

  return {
    "Content-Type":
      "application/zip",
    "X-Output-Count":
      String(outputCount)
  };

}


function createRouteError(
  message,
  status
) {

  const error =
    new Error(message);

  error.status = status;

  return error;

}


function getRouteErrorStatus(
  error
) {

  if (
    !error ||
    typeof error !== "object"
  ) {

    return 500;

  }


  const status =
    Number(error.status);


  if (
    status >= 400 &&
    status < 600
  ) {

    return status;

  }


  return 500;

}


function getRouteErrorMessage(
  error,
  fallback
) {

  if (
    error &&
    typeof error === "object" &&
    error.message
  ) {

    return error.message;

  }


  return String(
    error || fallback
  );

}


/* ============================================================
   KINDLE HELPERS
   ============================================================ */


function readCookie(header, name) {

  const items = String(header || "")
    .split(";");


  for (const item of items) {

    const parts = item.trim().split("=");

    const key = parts.shift();


    if (key === name) {
      return decodeURIComponent(
        parts.join("=")
      );
    }

  }


  return "";

}


async function fetchKindleWorker(
  pathname,
  options = {}
) {

  const config =
    getKindleWorkerConfig();

  const headers =
    buildKindleWorkerHeaders(
      options.headers,
      config.sharedSecret
    );


  return fetch(
    config.workerUrl + pathname,
    {
      ...options,
      headers
    }
  );

}


function getKindleWorkerConfig() {

  const workerUrl = String(
    process.env.KINDLE_WORKER_URL || ""
  ).replace(/\/$/, "");

  const sharedSecret =
    process.env.KINDLE_SHARED_SECRET || "";


  if (!workerUrl || !sharedSecret) {
    throw new Error(
      "Kindle worker is not configured"
    );
  }

  return {
    workerUrl,
    sharedSecret
  };

}


function buildKindleWorkerHeaders(
  initialHeaders = {},
  sharedSecret
) {

  const headers = new Headers(
    initialHeaders || {}
  );

  headers.set(
    "Authorization",
    "Bearer " + sharedSecret
  );

  return headers;

}


async function fetchKindleWorkerJson(
  pathname,
  options = {}
) {

  const response =
    await fetchKindleWorker(
      pathname,
      options
    );

  const data =
    await response.json();


  return {
    response,
    data
  };

}


async function getKindleWorkerStatus() {

  const result =
    await fetchKindleWorkerJson(
      "/api/status"
    );


  if (!result.response.ok) {
    throw new Error(
      result.data.error ||
      "Kindle worker unavailable"
    );
  }


  return result.data;

}


async function getKindleWorkerJob(id) {

  const jobId = String(id || "").trim();

  if (!/^[A-Za-z0-9-]{1,100}$/.test(jobId)) {
    throw new Error(
      "Invalid Kindle job ID"
    );
  }

  const result =
    await fetchKindleWorkerJson(
      "/api/jobs/" +
        encodeURIComponent(jobId)
    );


  return {
    data: result.data,
    status: result.response.status
  };

}


async function createKindleConnectionUrl() {

  const result =
    await fetchKindleWorkerJson(
      "/api/connect-token",
      { method: "POST" }
    );


  if (
    !result.response.ok ||
    !result.data.url
  ) {
    throw new Error(
      result.data.error ||
      "Cannot open Amazon connection"
    );
  }


  return String(result.data.url);

}


async function createKindleUploadTicket(
  filename,
  size
) {

  const result =
    await fetchKindleWorkerJson(
      "/api/tickets",
      {
        method: "POST",
        headers: {
          "Content-Type":
            "application/json"
        },
        body: JSON.stringify({
          filename:
            normalizeKindlePdfFileName(
              filename ||
              "document.pdf"
            ),
          size: Number(size)
        })
      }
    );


  return {
    data: result.data,
    status: result.response.status
  };

}


/* ============================================================
   WEEBCENTRAL HELPERS
   ============================================================ */


const WEEBCENTRAL_BASE_URL =
  "https://weebcentral.com";

const WEEBCENTRAL_USER_AGENT =
  "Mozilla/5.0 Manga PDF Processor";


function getWeebCentralSeriesUrl(
  seriesId
) {

  return (
    WEEBCENTRAL_BASE_URL +
    "/series/" +
    seriesId
  );

}


function getWeebCentralChapterUrl(
  chapterId
) {

  return (
    WEEBCENTRAL_BASE_URL +
    "/chapters/" +
    chapterId
  );

}


function assertWeebCentralSearchQuery(
  query
) {

  if (query.length > 120) {
    throw new Error(
      "Search query is too long"
    );
  }

}


function isValidWeebCentralChapterId(
  value
) {

  return /^[0-9A-HJKMNP-TV-Z]{26}$/i.test(
    String(value || "")
  );

}


async function searchWeebCentralSeries(
  query
) {

  if (query.length < 2) {
    return [];
  }


  assertWeebCentralSearchQuery(
    query
  );


  const searchHtml =
    await fetchWeebCentralSearchHtml(
      query
    );


  return parseWeebCentralSearchResults(
    searchHtml
  );

}


async function fetchWeebCentralSearchHtml(
  query
) {

  const result = await fetchWeebCentralResponse(
    WEEBCENTRAL_BASE_URL +
      "/search/simple?location=main",
    {
      headers: {
        "User-Agent":
          WEEBCENTRAL_USER_AGENT,
        "Accept": "text/html",
        "Content-Type":
          "application/x-www-form-urlencoded;charset=UTF-8",
        "HX-Request": "true",
        "Origin":
          WEEBCENTRAL_BASE_URL,
        "Referer":
          WEEBCENTRAL_BASE_URL +
          "/search"
      },
      requestOptions: {
        method: "POST",
        body: new URLSearchParams({
          text: query
        }).toString()
      },
      consume: function (response) {
        return response.text();
      }
    }
  );


  if (!result.response.ok) {
    throw new Error(
      "WeebCentral returned HTTP " +
      result.response.status
    );
  }


  return result.value;

}


function parseWeebCentralSearchResults(
  searchHtml
) {

  const results = [];
  const seenSeriesIds = new Set();

  const seriesPattern =
    /<a\b[^>]*href="(https:\/\/weebcentral\.com\/series\/([0-9A-HJKMNP-TV-Z]{26})[^\"]*)"[^>]*>([\s\S]*?)<\/a>/gi;

  let seriesMatch;


  while (
    results.length < 10 &&
    (
      seriesMatch =
        seriesPattern.exec(
          searchHtml
        )
    ) !== null
  ) {

    const seriesId =
      seriesMatch[2];


    if (seenSeriesIds.has(seriesId)) {
      continue;
    }


    const itemHtml =
      seriesMatch[3];

    const title =
      getWeebCentralSearchResultTitle(
        itemHtml
      );


    if (!title) {
      continue;
    }


    const url = decodeHtmlText(
      seriesMatch[1]
    );

    getWeebCentralSeriesId(url);

    seenSeriesIds.add(seriesId);

    results.push({
      title,
      url
    });

  }


  return results;

}


function getWeebCentralSearchResultTitle(
  itemHtml
) {

  const titleMatch =
    itemHtml.match(
      /alt="([^\"]+?) cover"/i
    );


  return decodeHtmlText(
    titleMatch
      ? titleMatch[1]
      : stripHtmlTags(itemHtml)
  ).trim();

}


async function loadWeebCentralSeries(
  seriesUrl
) {

  const seriesId =
    getWeebCentralSeriesId(
      seriesUrl
    );


  const canonicalUrl =
    getWeebCentralSeriesUrl(
      seriesId
    );


  const seriesHtml =
    await fetchWeebCentralText(
      canonicalUrl
    );


  const chapterHtml =
    await fetchWeebCentralText(
      canonicalUrl +
      "/full-chapter-list",
      {
        "HX-Request": "true"
      }
    );


  const chapters =
    parseWeebCentralChapters(
      chapterHtml
    );


  if (chapters.length === 0) {
    throw new Error(
      "No chapters found"
    );
  }


  return {
    title:
      parseWeebCentralSeriesTitle(
        seriesHtml
      ),
    coverUrl:
      parseWeebCentralCoverUrl(
        seriesHtml
      ),
    chapters
  };

}


function parseWeebCentralSeriesTitle(
  seriesHtml
) {

  const titleMatch =
    seriesHtml.match(
      /<meta property="og:title" content="([^"]+?)(?: \| Weeb Central)?">/i
    );


  return decodeHtmlText(
    titleMatch
      ? titleMatch[1]
      : "Manga"
  );

}


function parseWeebCentralChapters(
  chapterHtml
) {

  const chapters = [];

  const chapterPattern =
    /href="https:\/\/weebcentral\.com\/chapters\/([0-9A-HJKMNP-TV-Z]{26})"[\s\S]*?<span class="">\s*([^<]+?)\s*<\/span>[\s\S]*?<time[^>]*datetime="([^"]*)"/gi;

  let chapterMatch;


  while (
    (
      chapterMatch =
        chapterPattern.exec(
          chapterHtml
        )
    ) !== null
  ) {

    chapters.push({
      id: chapterMatch[1],
      title: decodeHtmlText(
        chapterMatch[2].trim()
      ),
      date: chapterMatch[3]
        ? chapterMatch[3].slice(0, 10)
        : ""
    });

  }


  chapters.reverse();


  chapters.forEach(
    function (chapter, index) {
      chapter.index = index + 1;
    }
  );


  return chapters;

}


async function downloadWeebCentralChapterImages(
  chapterId
) {

  const imageUrls =
    await loadWeebCentralChapterImageUrls(
      chapterId
    );

  return mapWithConcurrency(
    imageUrls,
    WEEBCENTRAL_IMAGE_CONCURRENCY,
    function (imageUrl, index) {
      return downloadWeebCentralChapterImage(
        imageUrl,
        chapterId,
        index
      );
    }
  );

}


async function loadWeebCentralChapterImageUrls(
  chapterId
) {

  const imageListHtml =
    await fetchWeebCentralText(
      getWeebCentralChapterUrl(
        chapterId
      ) +
      "/images?is_prev=False&" +
      "current_page=1&" +
      "reading_style=long_strip",
      {
        "HX-Request": "true"
      }
    );


  const imageUrls =
    parseWeebCentralImageUrls(
      imageListHtml
    );


  if (imageUrls.length === 0) {
    throw new Error(
      "No chapter images found"
    );
  }


  return imageUrls;

}


function parseWeebCentralImageUrls(
  imageListHtml
) {

  const imageUrls = [];
  const imagePattern =
    /<img[\s\S]*?\ssrc="([^"]+)"/gi;

  let imageMatch;


  while (
    (
      imageMatch =
        imagePattern.exec(
          imageListHtml
        )
    ) !== null
  ) {

    const imageUrl =
      decodeHtmlText(
        imageMatch[1]
      );

    assertSafeRemoteImageUrl(
      imageUrl
    );

    imageUrls.push(imageUrl);

  }


  return imageUrls;

}


async function downloadWeebCentralChapterImage(
  imageUrl,
  chapterId,
  zeroBasedIndex
) {

  const pageNumber =
    zeroBasedIndex + 1;

  const result =
    await fetchWeebCentralChapterImage(
      imageUrl,
      chapterId,
      zeroBasedIndex
    );


  if (!result.response.ok) {
    throw new Error(
      "Image " +
      pageNumber +
      " download failed: HTTP " +
      result.response.status
    );
  }


  return normalizeImageForPdf(
    result.bytes,
    "page_" +
      String(pageNumber)
        .padStart(4, "0") +
      getImageExtensionFromUrl(
        imageUrl
      )
  );

}


async function fetchWeebCentralChapterImage(
  imageUrl,
  chapterId,
  zeroBasedIndex
) {

  const jitter =
    (zeroBasedIndex % 6) * 25;

  return fetchWeebCentralImageBytes(
    imageUrl,
    {
      headers: {
        "User-Agent":
          WEEBCENTRAL_USER_AGENT,
        "Referer":
          getWeebCentralChapterUrl(
            chapterId
          )
      },
      timeoutMs:
        WEEBCENTRAL_IMAGE_TIMEOUT_MS,
      retryDelays: [
        1_000 + jitter,
        2_000 + jitter,
        4_000 + jitter,
        8_000 + jitter
      ]
    }
  );

}


function getWeebCentralSeriesId(
  value
) {

  let url;


  try {
    url = new URL(String(value));
  } catch (_) {
    throw new Error(
      "Invalid WeebCentral URL"
    );
  }


  if (
    url.protocol !== "https:" ||
    ![
      "weebcentral.com",
      "www.weebcentral.com"
    ].includes(
      url.hostname.toLowerCase()
    )
  ) {
    throw new Error(
      "Only https://weebcentral.com/series/... URLs are allowed"
    );
  }


  const match = url.pathname.match(
    /^\/series\/([0-9A-HJKMNP-TV-Z]{26})(?:\/|$)/i
  );


  if (!match) {
    throw new Error(
      "The URL does not contain a valid series ID"
    );
  }


  return match[1];

}


async function fetchWeebCentralText(
  url,
  extraHeaders = {}
) {

  const result = await fetchWeebCentralResponse(url, {
    headers: {
      "User-Agent":
        WEEBCENTRAL_USER_AGENT,
      "Accept": "text/html",
      ...extraHeaders
    },
    consume: function (response) {
      return response.text();
    }
  });


  if (!result.response.ok) {
    throw new Error(
      "WeebCentral returned HTTP " +
      result.response.status
    );
  }


  return result.value;

}


function assertSafeRemoteImageUrl(
  value
) {

  let url;


  try {
    url = new URL(value);
  } catch (_) {
    throw new Error(
      "Invalid chapter image URL"
    );
  }


  const host =
    url.hostname.toLowerCase();


  if (
    url.protocol !== "https:" ||
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host.endsWith(".local") ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(
      host
    )
  ) {
    throw new Error(
      "Unsafe chapter image URL"
    );
  }

}


function getImageExtensionFromUrl(
  value
) {

  try {
    const pathname =
      new URL(value).pathname
        .toLowerCase();


    const match = pathname.match(
      /\.(jpe?g|png|gif|webp)$/
    );


    return match
      ? "." + match[1]
      : ".img";

  } catch (_) {
    return ".img";
  }

}


function stripHtmlTags(value) {

  return String(value)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

}


function decodeHtmlText(value) {

  return String(value)
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(
      /&#(\d+);/g,
      function (_, code) {
        return String.fromCodePoint(
          Number(code)
        );
      }
    )
    .replace(
      /&#x([0-9a-f]+);/gi,
      function (_, code) {
        return String.fromCodePoint(
          parseInt(code, 16)
        );
      }
    );

}


/* ============================================================
   PDF PROCESSING
   ============================================================ */


async function processPdfFile(
  inputBytes,
  baseFileName,
  shouldMerge,
  session
) {

  const sourcePdf =
    await PDFDocument.load(
      inputBytes,
      {
        ignoreEncryption: true
      }
    );


  const sourcePages =
    sourcePdf.getPages();


  if (
    sourcePages.length === 0
  ) {

    return 0;

  }


  const items =
    sourcePages.map(
      function (
        page,
        index
      ) {

        const size =
          page.getSize();


        assertValidSize(
          size.width,
          size.height,
          "PDF page " +
          (index + 1)
        );


        return {

          type: "pdf",

          index,

          page,

          width:
            size.width,

          height:
            size.height

        };

      }
    );


  const operations =
    buildOperations(
      items,
      shouldMerge
    );


  return writeOperationsToZip({

    operations,

    baseFileName,

    session,

    addOperation:
      async function (
        targetPdf,
        operation
      ) {

        await addPdfOperation(
          targetPdf,
          sourcePdf,
          operation
        );

      }

  });

}


/* ============================================================
   CBZ PROCESSING
   ============================================================ */


async function processCbzFile(
  inputBytes,
  baseFileName,
  shouldMerge,
  session
) {

  const zip =
    await JSZip.loadAsync(
      inputBytes
    );


  const entries = [];


  zip.forEach(
    function (
      relativePath,
      zipFile
    ) {

      if (zipFile.dir) {
        return;
      }


      if (
        relativePath.startsWith(
          "__MACOSX/"
        )
      ) {
        return;
      }


      if (
        !/\.(jpg|jpeg|png|gif|webp)$/i.test(
          relativePath
        )
      ) {
        return;
      }


      entries.push({
        path: relativePath,
        file: zipFile
      });

    }
  );


  entries.sort(
    function (a, b) {

      return a.path.localeCompare(
        b.path,
        undefined,
        {
          numeric: true,
          sensitivity: "base"
        }
      );

    }
  );


  if (
    entries.length === 0
  ) {

    return 0;

  }


  const images = [];


  for (
    const entry of entries
  ) {

    const rawBuffer =
      Buffer.from(
        await entry.file.async(
          "arraybuffer"
        )
      );


    const image =
      await normalizeImageForPdf(
        rawBuffer,
        entry.path
      );


    images.push(
      image
    );

  }


  const operations =
    buildOperations(
      images,
      shouldMerge
    );


  return writeOperationsToZip({

    operations,

    baseFileName,

    session,

    addOperation:
      async function (
        targetPdf,
        operation
      ) {

        await addImageOperation(
          targetPdf,
          operation
        );

      }

  });

}


/* ============================================================
   PAGE PAIRING
   ============================================================ */


function createSingleOperation(
  item
) {

  return {

    type: "single",

    item

  };

}


function createPairOperation(
  first,
  second
) {

  return {

    type: "pair",

    first,

    second

  };

}


function isVerticalPageItem(
  item
) {

  return item.width <= item.height;

}


function shouldPairPageItems(
  first,
  second,
  shouldMerge
) {

  return Boolean(
    shouldMerge &&
    first &&
    second &&
    isVerticalPageItem(first) &&
    isVerticalPageItem(second)
  );

}


function buildOperations(
  items,
  shouldMerge
) {

  const operations = [];


  if (
    items.length === 0
  ) {

    return operations;

  }


  /*
    Первая страница остается отдельной.
    Обычно это обложка.
  */

  operations.push(
    createSingleOperation(
      items[0]
    )
  );


  let i = 1;


  while (
    i < items.length
  ) {

    const current =
      items[i];


    const next =
      items[i + 1];


    if (
      shouldPairPageItems(
        current,
        next,
        shouldMerge
      )
    ) {

      operations.push(
        createPairOperation(
          current,
          next
        )
      );


      i += 2;

    } else {

      operations.push(
        createSingleOperation(
          current
        )
      );


      i += 1;

    }

  }


  return operations;

}


/* ============================================================
   OUTPUT SPLITTING
   ============================================================ */


async function writeOperationsToZip({
  operations,
  baseFileName,
  session,
  addOperation
}) {
  return writePdfBatches({
    operations,
    maxBytes: MAX_PDF_SIZE,
    batchSize:
      PDF_SERIALIZATION_BATCH_SIZE,
    addOperation,
    emitPdf(bytes, outputIndex) {
      addPdfBytesToSessionZip(
        session,
        baseFileName,
        outputIndex,
        bytes
      );
    }
  });

}


/* ============================================================
   ADD PDF PAGES
   ============================================================ */


async function addSinglePdfPageOperation(
  targetPdf,
  sourcePdf,
  item
) {

  const copiedPages =
    await targetPdf.copyPages(
      sourcePdf,
      [
        item.index
      ]
    );


  targetPdf.addPage(
    copiedPages[0]
  );

}


async function addPdfPairAsRightToLeftSpread(
  targetPdf,
  first,
  second
) {

  const pageWidth =
    first.width +
    second.width;


  const pageHeight =
    Math.max(
      first.height,
      second.height
    );


  assertValidSize(
    pageWidth,
    pageHeight,
    "Merged PDF page"
  );


  const embeddedFirst =
    await targetPdf.embedPage(
      first.page
    );


  const embeddedSecond =
    await targetPdf.embedPage(
      second.page
    );


  const mergedPage =
    targetPdf.addPage([
      pageWidth,
      pageHeight
    ]);


  mergedPage.drawPage(
    embeddedSecond,
    {
      x: 0,

      y:
        (
          pageHeight -
          second.height
        ) / 2,

      width:
        second.width,

      height:
        second.height
    }
  );


  mergedPage.drawPage(
    embeddedFirst,
    {
      x:
        second.width,

      y:
        (
          pageHeight -
          first.height
        ) / 2,

      width:
        first.width,

      height:
        first.height
    }
  );

}


async function addPdfOperation(
  targetPdf,
  sourcePdf,
  operation
) {

  if (
    operation.type ===
    "single"
  ) {

    await addSinglePdfPageOperation(
      targetPdf,
      sourcePdf,
      operation.item
    );

    return;

  }


  await addPdfPairAsRightToLeftSpread(
    targetPdf,
    operation.first,
    operation.second
  );

}



/* ============================================================
   ADD CBZ IMAGES
   ============================================================ */


async function addSingleImagePageOperation(
  targetPdf,
  image
) {

  const embedded =
    await embedImage(
      targetPdf,
      image
    );


  const page =
    targetPdf.addPage([
      image.width,
      image.height
    ]);


  page.drawImage(
    embedded,
    {
      x: 0,
      y: 0,

      width:
        image.width,

      height:
        image.height
    }
  );

}


async function addImagePairAsRightToLeftSpread(
  targetPdf,
  first,
  second
) {

  const pageWidth =
    first.width +
    second.width;


  const pageHeight =
    Math.max(
      first.height,
      second.height
    );


  assertValidSize(
    pageWidth,
    pageHeight,
    "Merged image page"
  );


  const embeddedFirst =
    await embedImage(
      targetPdf,
      first
    );


  const embeddedSecond =
    await embedImage(
      targetPdf,
      second
    );


  const page =
    targetPdf.addPage([
      pageWidth,
      pageHeight
    ]);


  page.drawImage(
    embeddedSecond,
    {
      x: 0,

      y:
        (
          pageHeight -
          second.height
        ) / 2,

      width:
        second.width,

      height:
        second.height
    }
  );


  page.drawImage(
    embeddedFirst,
    {
      x:
        second.width,

      y:
        (
          pageHeight -
          first.height
        ) / 2,

      width:
        first.width,

      height:
        first.height
    }
  );

}


async function addImageOperation(
  targetPdf,
  operation
) {

  if (
    operation.type ===
    "single"
  ) {

    await addSingleImagePageOperation(
      targetPdf,
      operation.item
    );

    return;

  }


  await addImagePairAsRightToLeftSpread(
    targetPdf,
    operation.first,
    operation.second
  );

}


/* ============================================================
   IMAGE EMBEDDING
   ============================================================ */


async function embedImage(
  pdfDoc,
  image
) {

  if (
    image.format === "jpg"
  ) {

    return pdfDoc.embedJpg(
      image.bytes
    );

  }


  if (
    image.format === "png"
  ) {

    return pdfDoc.embedPng(
      image.bytes
    );

  }


  throw new Error(
    "Unsupported normalized image format: " +
    image.format
  );

}


/* ============================================================
   IMAGE NORMALIZATION
   ============================================================ */


let sharpPromise = null;


async function getSharp() {

  if (!sharpPromise) {

    sharpPromise =
      import("sharp")
        .then(
          function (module) {

            return (
              module.default ||
              module
            );

          }
        );

  }


  return sharpPromise;

}


async function normalizeImageForPdf(
  buffer,
  path
) {

  const sharp =
    await getSharp();


  const detectedFormat =
    detectImageFormat(
      buffer,
      path
    );


  const metadata =
    await sharp(
      buffer,
      {
        animated: false
      }
    ).metadata();


  if (
    !metadata.width ||
    !metadata.height
  ) {

    throw new Error(
      "Cannot read image dimensions: " +
      path
    );

  }


  let bytes =
    buffer;


  let format =
    detectedFormat;


  let width =
    metadata.width;


  let height =
    metadata.height;


  /*
    pdf-lib поддерживает JPG и PNG.

    GIF и WEBP преобразуем в PNG.
  */

  if (
    format !== "jpg" &&
    format !== "png"
  ) {

    bytes =
      await sharp(
        buffer,
        {
          animated: false
        }
      )
        .png()
        .toBuffer();


    format = "png";


    const convertedMetadata =
      await sharp(
        bytes
      ).metadata();


    width =
      convertedMetadata.width ||
      width;


    height =
      convertedMetadata.height ||
      height;

  }


  assertValidSize(
    width,
    height,
    path
  );


  return {

    type: "image",

    bytes,

    format,

    width,

    height,

    path

  };

}


/* ============================================================
   IMAGE FORMAT DETECTION
   ============================================================ */


function detectImageFormat(
  buffer,
  path
) {

  /*
    JPEG signature
  */

  if (
    buffer.length >= 2 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8
  ) {

    return "jpg";

  }


  /*
    PNG signature
  */

  if (
    buffer.length >= 4 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {

    return "png";

  }


  const lowerPath =
    path.toLowerCase();


  if (
    lowerPath.endsWith(".jpg") ||
    lowerPath.endsWith(".jpeg")
  ) {

    return "jpg";

  }


  if (
    lowerPath.endsWith(".png")
  ) {

    return "png";

  }


  if (
    lowerPath.endsWith(".gif")
  ) {

    return "gif";

  }


  if (
    lowerPath.endsWith(".webp")
  ) {

    return "webp";

  }


  throw new Error(
    "Unsupported image: " +
    path
  );

}


/* ============================================================
   ZIP OUTPUT
   ============================================================ */


function addPdfBytesToSessionZip(
  session,
  baseFileName,
  outputIndex,
  pdfBytes
) {

  const preferredName =
    outputIndex === 1
      ? baseFileName +
        ".pdf"
      : baseFileName +
        "_" +
        outputIndex +
        ".pdf";


  const uniqueName =
    getUniqueZipFileName(
      session.zip,
      preferredName
    );


  session.zip.file(
    uniqueName,
    pdfBytes
  );

}


function getUniqueZipFileName(
  zip,
  preferredName
) {

  if (
    !zip.files[
      preferredName
    ]
  ) {

    return preferredName;

  }


  const extensionIndex =
    preferredName
      .toLowerCase()
      .endsWith(".pdf")

      ? preferredName.length - 4

      : preferredName.length;


  const base =
    preferredName.slice(
      0,
      extensionIndex
    );


  const extension =
    preferredName.slice(
      extensionIndex
    );


  let counter = 2;


  while (
    zip.files[
      base +
      "_" +
      counter +
      extension
    ]
  ) {

    counter += 1;

  }


  return (
    base +
    "_" +
    counter +
    extension
  );

}


function sanitizeFileName(name) {
  return (
    String(name)
      .replace(/[<>:"/\\|?*]/g, "_")
      .replace(/[\u0000-\u001F]/g, "_")
      .replace(/\\s+/g, " ")
      .trim()
      .slice(0, 120) || "file"
  );
}


function getBaseFileName(fileName) {
  const cleanName =
    String(fileName).split(/[\\/]/).pop() || "file";
  const withoutExtension =
    cleanName.replace(/\.[^/.]+$/, "");
  return sanitizeFileName(
    withoutExtension || "file"
  );
}


function assertValidSize(width, height, label) {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new Error(
      label + ": invalid page size " +
      width + "x" + height
    );
  }
}


export default app;
