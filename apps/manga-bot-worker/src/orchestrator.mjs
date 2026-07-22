import fs from "node:fs/promises";
import path from "node:path";

import { boundedInteger, mapWithConcurrency } from "./concurrency.mjs";
import { buildKindleImageVolumesInSubprocess } from "./pdf-subprocess.mjs";
import { cleanTitle, helpText, normalizeTitle, parseCommand } from "./command.mjs";
import { selectChapterRange } from "./chapters.mjs";
import { choicesKeyboard } from "./telegram.mjs";

export class Orchestrator {
  constructor({
    store,
    telegram,
    mangaApp,
    kindle,
    maxPdfBytes,
    chapterProcessingConcurrency = 2,
    epubBuildConcurrency = 2,
    kindleUploadConcurrency = 2,
    tempRoot = "/tmp/manga-jobs"
  }) {
    this.store = store;
    this.telegram = telegram;
    this.mangaApp = mangaApp;
    this.kindle = kindle;
    this.maxPdfBytes = maxPdfBytes;
    this.chapterProcessingConcurrency = boundedInteger(
      chapterProcessingConcurrency,
      2,
      { min: 1, max: 4 }
    );
    this.epubBuildConcurrency = boundedInteger(
      epubBuildConcurrency,
      2,
      { min: 1, max: 4 }
    );
    this.kindleUploadConcurrency = boundedInteger(
      kindleUploadConcurrency,
      2,
      { min: 1, max: 4 }
    );
    this.tempRoot = tempRoot;
    this.running = false;
    this.timer = null;
  }

  start() {
    this.timer = setInterval(() => this.tick().catch((error) => console.error("Worker tick failed", error)), 4000);
    this.tick().catch((error) => console.error("Initial worker tick failed", error));
  }

  async handleMessage(message) {
    const chatId = String(message.chat?.id || "");
    const parsed = parseCommand(message.text || "");
    if (parsed.type === "help" || parsed.type === "unknown") {
      await this.telegram.sendMessage(chatId, parsed.type === "unknown" ? `${helpText()}\n\nНе понял команду.` : helpText());
      return;
    }
    if (parsed.type === "status") return this.sendStatus(chatId);
    if (parsed.type === "cancel") return this.cancel(chatId);
    if (parsed.type === "retry") return this.retry(chatId);
    if (parsed.type === "kindle") return this.sendKindleConnectUrl(chatId);
    if (parsed.type === "merge") return this.mergeVerticalPages(chatId, parsed.enabled);
    if (parsed.type === "send") {
      const existing = this.store.latestJob(chatId, ["queued", "resume_pending", "processing", "delivering", "waiting_auth", "waiting_choice"]);
      if (existing) {
        await this.telegram.sendMessage(chatId, `Уже есть активное задание ${shortId(existing.id)}: ${describeJob(existing)}\n/status — детали, /cancel — отменить.`);
        return;
      }
      const job = this.store.createJob({
        chatId,
        status: "queued",
        titleQuery: parsed.titleQuery,
        fromChapter: parsed.fromChapter,
        toChapter: parsed.toChapter,
        mergeVerticalPages: this.store.getMergeVerticalPages(chatId),
        progress: "Задание принято, ищу мангу"
      });
      await this.telegram.sendMessage(chatId, `Задание ${shortId(job.id)} принято: «${parsed.titleQuery}», ${formatChapterRange(parsed.fromChapter, parsed.toChapter)}.`);
      return;
    }
  }

  async handleCallback(callback) {
    const chatId = String(callback.message?.chat?.id || "");
    const data = String(callback.data || "");
    const match = data.match(/^choose:([\w-]+):(\d+)$/);
    if (!match) return this.telegram.answerCallbackQuery(callback.id, "Неизвестное действие");
    const job = this.store.getJob(match[1]);
    const choice = job?.choiceManifest?.[Number(match[2])];
    if (!job || job.chatId !== chatId || job.status !== "waiting_choice" || !choice) {
      return this.telegram.answerCallbackQuery(callback.id, "Выбор уже недоступен");
    }
    this.store.updateJob(job.id, {
      status: "queued",
      seriesUrl: choice.url,
      seriesTitle: choice.title,
      choiceManifest: [],
      progress: `Выбрано: ${choice.title}`
    });
    await this.telegram.answerCallbackQuery(callback.id, "Выбрано");
    await this.telegram.sendMessage(chatId, `Выбрано: ${choice.title}. Начинаю обработку.`);
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const job = this.store.nextActiveJob();
      if (!job) return;
      if (job.status === "delivering" || job.status === "waiting_auth") {
        await this.reconcileDelivery(job);
      } else {
        await this.runJob(job);
      }
    } finally {
      this.running = false;
    }
  }

  async runJob(initialJob) {
    let job = initialJob;
    const workDir = path.join(this.tempRoot, initialJob.id);
    try {
      job = this.store.updateJob(job.id, { status: "processing", error: null, progress: "Определяю произведение" });
      await this.sendProgress(job.chatId, `Задание ${shortId(job.id)}: ${job.progress}.`);

      job = await this.resolveSeries(job);
      if (job.status === "waiting_choice") return;
      const series = await this.mangaApp.loadSeries(job.seriesUrl);
      const chapters = selectChapterRange(series.chapters, job.fromChapter, job.toChapter);
      job = this.store.updateJob(job.id, {
        seriesTitle: series.title,
        chapterManifest: chapters,
        progress: `Зафиксирован диапазон: ${chapters[0].title} — ${chapters.at(-1).title} (${chapters.length} глав)`
      });
      await this.sendProgress(job.chatId, `Задание ${shortId(job.id)}: ${job.progress}.`);

      const coverPath = path.join(workDir, "cover.img");
      await fs.mkdir(workDir, { recursive: true });
      const cover = await this.mangaApp.downloadCover({
        coverUrl: series.coverUrl,
        seriesUrl: job.seriesUrl
      });
      await fs.writeFile(coverPath, cover, { mode: 0o600 });

      const imageSources = await this.processChapters(job);
      job = this.store.getJob(job.id);
      if (job.status === "cancelled") return;

      job = this.store.updateJob(job.id, { progress: `Собираю Kindle EPUB напрямую из изображений ${imageSources.length} глав` });
      await this.sendProgress(job.chatId, `Задание ${shortId(job.id)}: ${job.progress}.`);
      const volumes = await buildKindleImageVolumesInSubprocess({
        sources: imageSources,
        destinationDir: path.join(workDir, "volumes"),
        baseName: job.seriesTitle,
        maxBytes: this.maxPdfBytes,
        mergeVerticalPages: job.mergeVerticalPages,
        coverPath,
        imageRenderConcurrency: this.epubBuildConcurrency,
        epubBuildConcurrency: this.epubBuildConcurrency
      });
      if (volumes.some((volume) => volume.oversize)) {
        throw new Error("Одна часть превышает безопасный лимит Kindle; требуется разбиение исходной главы");
      }

      const batchId = job.id;
      const queued = await this.enqueueVolumes(job, volumes, batchId);
      job = this.store.getJob(job.id);
      if (job.status === "cancelled") return;
      if (queued.some((item) => item.batchId === batchId)) {
        await this.kindle.startBatch(batchId);
      }
      job = this.store.updateJob(job.id, {
        status: "delivering",
        kindleJobs: queued,
        progress: `EPUB переданы в Kindle uploader: ${queued.length} шт.`
      });
      await this.sendProgress(job.chatId, `Задание ${shortId(job.id)}: собрано и поставлено в Kindle-очередь ${queued.length} EPUB.`);
      await this.reconcileDelivery(job);
    } catch (error) {
      const latest = this.store.getJob(initialJob.id);
      if (latest?.status === "cancelled") return;
      const message = errorMessage(error);
      this.store.updateJob(initialJob.id, { status: "failed", error: message, progress: "Ошибка" });
      await this.sendProgress(initialJob.chatId, `Задание ${shortId(initialJob.id)} остановлено: ${message}\n/retry — повторить.`);
    } finally {
      await fs.rm(workDir, { recursive: true, force: true }).catch((error) => {
        console.error("Cannot clean manga job workspace", workDir, error);
      });
    }
  }

  async resolveSeries(job) {
    if (job.seriesUrl) return job;
    const response = await this.mangaApp.search(job.titleQuery);
    const results = Array.isArray(response.results) ? response.results : [];
    if (results.length === 0) throw new Error(`По запросу «${job.titleQuery}» ничего не найдено`);
    const query = normalizeTitle(job.titleQuery);
    const exact = results.filter((result) => normalizeTitle(result.title) === query);
    const choices = exact.length === 1 ? exact : results;
    if (choices.length !== 1) {
      const waiting = this.store.updateJob(job.id, {
        status: "waiting_choice",
        choiceManifest: choices,
        progress: "Нужно выбрать произведение"
      });
      await this.telegram.sendMessage(waiting.chatId, "Нашёл несколько вариантов. Выберите нужный:", {
        reply_markup: choicesKeyboard(waiting)
      });
      return waiting;
    }
    return this.store.updateJob(job.id, { seriesUrl: choices[0].url, seriesTitle: choices[0].title });
  }

  async processChapters(job) {
    const workDir = path.join(this.tempRoot, job.id, "chapters");
    await fs.mkdir(workDir, { recursive: true });
    const chapters = job.chapterManifest;
    let completedCount = 0;
    const chapterSources = await mapWithConcurrency(
      chapters,
      this.chapterProcessingConcurrency,
      async (chapter, index) => {
        const current = this.store.getJob(job.id);
        if (!current || current.status === "cancelled") return null;
        const processing = `Обрабатываю ${index + 1}/${chapters.length}: ${chapter.title}`;
        this.store.updateJob(job.id, { progress: processing });
        const pages = await this.mangaApp.processChapterImages({
          chapterId: chapter.id,
          mangaTitle: job.seriesTitle,
          chapterTitle: chapter.title
        });

        const latest = this.store.getJob(job.id);
        if (!latest || latest.status === "cancelled") return null;

        const chapterDir = path.join(workDir, String(index + 1).padStart(4, "0"));
        await fs.mkdir(chapterDir, { recursive: true });
        const storedPages = await Promise.all(pages.map(async (page, pageIndex) => {
          const extension = page.format === "jpg" ? "jpg" : "png";
          const filePath = path.join(
            chapterDir,
            `page-${String(pageIndex + 1).padStart(4, "0")}.${extension}`
          );
          await fs.writeFile(filePath, page.bytes);
          return {
            filePath,
            width: page.width,
            height: page.height,
            format: page.format
          };
        }));

        completedCount += 1;
        const completed = `Обработано ${completedCount}/${chapters.length}: ${chapter.title}`;
        this.store.updateJob(job.id, { progress: completed });
        if (completedCount % 3 === 0 || completedCount === chapters.length) {
          await this.sendProgress(job.chatId, `Задание ${shortId(job.id)}: обработано ${completedCount}/${chapters.length} глав.`);
        }
        return {
          name: chapter.title,
          chapterTitle: chapter.title,
          pages: storedPages
        };
      }
    );
    return chapterSources.filter(Boolean);
  }

  async enqueueVolumes(job, volumes, batchId = job.id) {
    const queued = [...job.kindleJobs];
    const volumeOrder = new Map(
      volumes.map((volume, index) => [volume.fileName, index])
    );
    const remaining = volumes.filter(
      (volume) => !queued.some((item) => item.filename === volume.fileName)
    );

    await mapWithConcurrency(
      remaining,
      this.kindleUploadConcurrency,
      async (volume) => {
        let current = this.store.getJob(job.id);
        if (!current || current.status === "cancelled") return null;
        current = this.store.updateJob(job.id, { progress: `Передаю в Kindle: ${volume.fileName}` });
        await this.sendProgress(current.chatId, `Задание ${shortId(job.id)}: ${current.progress}.`);
        const kindleJob = await this.kindle.enqueueFile(
          volume.filePath,
          volume.fileName,
          { batchId, deferStart: true }
        );
        queued.push({
          id: kindleJob.id,
          filename: volume.fileName,
          size: kindleJob.size,
          status: kindleJob.status,
          batchId
        });
        queued.sort((left, right) =>
          (volumeOrder.get(left.filename) ?? Number.MAX_SAFE_INTEGER) -
          (volumeOrder.get(right.filename) ?? Number.MAX_SAFE_INTEGER)
        );
        this.store.updateJob(job.id, { kindleJobs: [...queued] });
        return kindleJob;
      }
    );

    return queued;
  }

  async reconcileDelivery(job) {
    try {
      const entries = await Promise.all(job.kindleJobs.map(async (submitted) => {
        const current = await this.kindle.job(submitted.id);
        return { ...submitted, status: current.job.status, error: current.job.error || null };
      }));
      if (entries.some((entry) => entry.status === "failed")) {
        const failed = entries.find((entry) => entry.status === "failed");
        this.store.updateJob(job.id, { status: "failed", kindleJobs: entries, error: failed.error || "Amazon rejected an EPUB" });
        await this.telegram.sendMessage(job.chatId, `Kindle не принял ${failed.filename}: ${failed.error || "неизвестная ошибка"}`);
        return;
      }
      if (entries.every((entry) => entry.status === "sent")) {
        this.store.updateJob(job.id, { status: "completed", kindleJobs: entries, progress: "Amazon принял все EPUB к доставке" });
        await this.telegram.sendMessage(job.chatId, `Готово: Amazon принял ${entries.length} EPUB к доставке. Синхронизация с Kindle может занять время.`);
        return;
      }
      if (entries.some((entry) => entry.status === "waiting_auth")) {
        const wasWaiting = job.status === "waiting_auth";
        this.store.updateJob(job.id, { status: "waiting_auth", kindleJobs: entries, progress: "Amazon требует вход" });
        if (!wasWaiting) await this.sendKindleConnectUrl(job.chatId, job.id);
        return;
      }
      const progress = "Amazon обрабатывает файлы";
      this.store.updateJob(job.id, { status: "delivering", kindleJobs: entries, progress });
      if (job.progress !== progress) {
        await this.telegram.sendMessage(job.chatId, `Задание ${shortId(job.id)}: ${progress}.`);
      }
    } catch (error) {
      console.error("Delivery reconciliation failed", error);
    }
  }

  async sendStatus(chatId) {
    const job = this.store.latestJob(chatId);
    if (!job) return this.telegram.sendMessage(chatId, "Заданий пока нет.");
    const files = await this.describeKindleFiles(job.kindleJobs);
    await this.telegram.sendMessage(chatId, `Задание ${shortId(job.id)}\n${describeJob(job)}${files ? `\n${files}` : ""}${job.error ? `\nОшибка: ${job.error}` : ""}`);
  }

  async describeKindleFiles(entries) {
    if (!entries?.length) return "";
    const details = await Promise.all(entries.map(async (entry) => {
      try {
        const response = await this.kindle.job(entry.id);
        const current = response.job;
        const size = Number.isFinite(Number(current.size)) ? formatMegabytes(current.size) : "размер неизвестен";
        return `• ${current.filename || entry.filename} — ${size}, ${current.status}`;
      } catch {
        return `• ${entry.filename} — ${entry.size ? formatMegabytes(entry.size) : "размер неизвестен"}, ${entry.status}`;
      }
    }));
    return `Файлы в Kindle:\n${details.join("\n")}`;
  }

  async cancel(chatId) {
    const job = this.store.cancelLatest(chatId);
    await this.telegram.sendMessage(chatId, job ? `Задание ${shortId(job.id)} отменено. Уже переданные в Amazon файлы нельзя отозвать автоматически.` : "Нет активного задания для отмены.");
  }

  async retry(chatId) {
    const job = this.store.retryLatest(chatId);
    await this.telegram.sendMessage(chatId, job ? `Задание ${shortId(job.id)} поставлено на повтор.` : "Нет неудавшегося задания для повтора.");
  }

  async mergeVerticalPages(chatId, enabled) {
    if (enabled === null) {
      const current = this.store.getMergeVerticalPages(chatId);
      await this.telegram.sendMessage(chatId, `Merge vertical pages: ${current ? "включено" : "выключено"}.\n/merge on или /merge off`);
      return;
    }
    this.store.setMergeVerticalPages(chatId, enabled);
    await this.telegram.sendMessage(chatId, `Merge vertical pages ${enabled ? "включено" : "выключено"}. Новые задания будут использовать эту настройку.`);
  }

  async sendKindleConnectUrl(chatId, jobId = null) {
    try {
      const result = await this.kindle.connectToken();
      await this.telegram.sendMessage(chatId, `${jobId ? `Задание ${shortId(jobId)}: ` : ""}Amazon требует вход. Откройте одноразовую ссылку в течение 10 минут:\n${result.url}`);
    } catch (error) {
      await this.telegram.sendMessage(chatId, `Не удалось открыть Amazon-вход: ${errorMessage(error)}`);
    }
  }

  async sendProgress(chatId, text) {
    try {
      await this.telegram.sendMessage(chatId, text);
    } catch (error) {
      console.error("Telegram progress notification failed", error);
    }
  }
}

function shortId(id) { return String(id).slice(0, 8); }
function errorMessage(error) { return error instanceof Error ? error.message : String(error); }
function formatMegabytes(bytes) { return `${(Number(bytes) / 1_000_000).toFixed(1)} МБ`; }
function describeJob(job) {
  const details = [
    `Статус: ${job.status}`,
    job.seriesTitle ? `Манга: ${job.seriesTitle}` : `Поиск: ${job.titleQuery}`,
    job.fromChapter ? `От: ${formatFromChapter(job.fromChapter)}` : null,
    job.toChapter ? `До: ${formatToChapter(job.toChapter)}` : null,
    `Merge vertical pages: ${job.mergeVerticalPages ? "вкл" : "выкл"}`,
    job.progress || null,
    job.kindleJobs?.length ? `Файлы в Kindle: ${job.kindleJobs.length}` : null
  ].filter(Boolean);
  return details.join("\n");
}

function formatToChapter(value) {
  return !value || value === "latest" ? "последней" : value;
}

function formatFromChapter(value) {
  return !value || value === "first" ? "первой" : value;
}

function formatChapterRange(from, to) {
  return from === "first" && to === "latest"
    ? "все главы"
    : `главы ${formatFromChapter(from)}–${formatToChapter(to)}`;
}
