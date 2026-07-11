import fs from "node:fs/promises";
import path from "node:path";

import { buildKindleVolumes } from "./pdf.mjs";
import { cleanTitle, helpText, normalizeTitle, parseCommand } from "./command.mjs";
import { selectChapterRange } from "./chapters.mjs";
import { choicesKeyboard } from "./telegram.mjs";

export class Orchestrator {
  constructor({ store, telegram, mangaApp, kindle, maxPdfBytes, tempRoot = "/tmp/manga-jobs" }) {
    this.store = store;
    this.telegram = telegram;
    this.mangaApp = mangaApp;
    this.kindle = kindle;
    this.maxPdfBytes = maxPdfBytes;
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
    try {
      job = this.store.updateJob(job.id, { status: "processing", error: null, progress: "Определяю произведение" });
      await this.telegram.sendMessage(job.chatId, `Задание ${shortId(job.id)}: ${job.progress}.`);

      job = await this.resolveSeries(job);
      if (job.status === "waiting_choice") return;
      const series = await this.mangaApp.loadSeries(job.seriesUrl);
      const chapters = selectChapterRange(series.chapters, job.fromChapter, job.toChapter);
      job = this.store.updateJob(job.id, {
        seriesTitle: series.title,
        chapterManifest: chapters,
        progress: `Зафиксирован диапазон: ${chapters[0].title} — ${chapters.at(-1).title} (${chapters.length} глав)`
      });
      await this.telegram.sendMessage(job.chatId, `Задание ${shortId(job.id)}: ${job.progress}.`);

      const sourcePdfs = await this.processChapters(job);
      job = this.store.getJob(job.id);
      if (job.status === "cancelled") return;

      const workDir = path.join(this.tempRoot, job.id);
      job = this.store.updateJob(job.id, { progress: `Собираю итоговые PDF из ${sourcePdfs.length} файлов` });
      await this.telegram.sendMessage(job.chatId, `Задание ${shortId(job.id)}: ${job.progress}.`);
      const volumes = await buildKindleVolumes({
        sourcePdfs,
        destinationDir: path.join(workDir, "volumes"),
        baseName: job.seriesTitle,
        maxBytes: this.maxPdfBytes,
        mergeVerticalPages: job.mergeVerticalPages
      });
      if (volumes.some((volume) => volume.oversize)) {
        throw new Error("Одна PDF-часть превышает безопасный лимит Kindle; требуется разбиение исходной главы");
      }

      const queued = [...job.kindleJobs];
      for (const volume of volumes) {
        if (queued.some((item) => item.filename === volume.fileName)) continue;
        job = this.store.getJob(job.id);
        if (job.status === "cancelled") return;
        job = this.store.updateJob(job.id, { progress: `Передаю в Kindle: ${volume.fileName}` });
        await this.telegram.sendMessage(job.chatId, `Задание ${shortId(job.id)}: ${job.progress}.`);
        const kindleJob = await this.kindle.enqueueFile(volume.filePath, volume.fileName);
        queued.push({ id: kindleJob.id, filename: volume.fileName, size: kindleJob.size, status: kindleJob.status });
        this.store.updateJob(job.id, { kindleJobs: queued });
      }
      job = this.store.updateJob(job.id, {
        status: "delivering",
        kindleJobs: queued,
        progress: `PDF переданы в Kindle uploader: ${queued.length} шт.`
      });
      await this.telegram.sendMessage(job.chatId, `Задание ${shortId(job.id)}: собрано и поставлено в Kindle-очередь ${queued.length} PDF.`);
      await this.reconcileDelivery(job);
    } catch (error) {
      const latest = this.store.getJob(initialJob.id);
      if (latest?.status === "cancelled") return;
      const message = errorMessage(error);
      this.store.updateJob(initialJob.id, { status: "failed", error: message, progress: "Ошибка" });
      await this.telegram.sendMessage(initialJob.chatId, `Задание ${shortId(initialJob.id)} остановлено: ${message}\n/retry — повторить.`);
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
    const sources = [];
    const chapters = job.chapterManifest;
    for (let index = 0; index < chapters.length; index += 1) {
      const current = this.store.getJob(job.id);
      if (!current || current.status === "cancelled") return [];
      const chapter = chapters[index];
      const processing = `Обрабатываю ${index + 1}/${chapters.length}: ${chapter.title}`;
      this.store.updateJob(job.id, { progress: processing });
      const outputs = await this.mangaApp.processChapter({
        chapterId: chapter.id,
        mangaTitle: job.seriesTitle,
        chapterTitle: chapter.title,
        shouldMerge: job.mergeVerticalPages
      });
      for (let part = 0; part < outputs.length; part += 1) {
        const filePath = path.join(workDir, `${String(index + 1).padStart(4, "0")}-${String(part + 1).padStart(2, "0")}.pdf`);
        await fs.writeFile(filePath, outputs[part].bytes);
        sources.push({
          name: `${chapter.title} ${outputs[part].name}`,
          chapterTitle: chapter.title,
          filePath
        });
      }
      const completed = `Обработано ${index + 1}/${chapters.length}: ${chapter.title}`;
      this.store.updateJob(job.id, { progress: completed });
      if ((index + 1) % 3 === 0 || index + 1 === chapters.length) {
        await this.telegram.sendMessage(job.chatId, `Задание ${shortId(job.id)}: обработано ${index + 1}/${chapters.length} глав.`);
      }
    }
    return sources;
  }

  async reconcileDelivery(job) {
    try {
      const entries = [];
      for (const submitted of job.kindleJobs) {
        const current = await this.kindle.job(submitted.id);
        entries.push({ ...submitted, status: current.job.status, error: current.job.error || null });
      }
      if (entries.some((entry) => entry.status === "failed")) {
        const failed = entries.find((entry) => entry.status === "failed");
        this.store.updateJob(job.id, { status: "failed", kindleJobs: entries, error: failed.error || "Amazon rejected a PDF" });
        await this.telegram.sendMessage(job.chatId, `Kindle не принял ${failed.filename}: ${failed.error || "неизвестная ошибка"}`);
        return;
      }
      if (entries.every((entry) => entry.status === "sent")) {
        this.store.updateJob(job.id, { status: "completed", kindleJobs: entries, progress: "Amazon подтвердил отправку всех файлов" });
        await this.telegram.sendMessage(job.chatId, `Готово: Amazon подтвердил отправку ${entries.length} PDF на Kindle.`);
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
    return `PDF в Kindle:\n${details.join("\n")}`;
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
    job.kindleJobs?.length ? `PDF в Kindle: ${job.kindleJobs.length}` : null
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
