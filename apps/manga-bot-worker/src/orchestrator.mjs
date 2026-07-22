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
    chapterProcessingConcurrency = 1,
    epubBuildConcurrency = 2,
    kindleUploadConcurrency = 2,
    tempRoot = "/data/manga-jobs"
  }) {
    this.store = store;
    this.telegram = telegram;
    this.mangaApp = mangaApp;
    this.kindle = kindle;
    this.maxPdfBytes = maxPdfBytes;
    this.chapterProcessingConcurrency = boundedInteger(
      chapterProcessingConcurrency,
      1,
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
    this.progressUpdates = new Map();
  }

  start() {
    this.timer = setInterval(() => this.tick().catch((error) => console.error("Worker tick failed", error)), 4000);
    this.tick().catch((error) => console.error("Initial worker tick failed", error));
  }

  async handleMessage(message) {
    const chatId = String(message.chat?.id || "");
    const parsed = parseCommand(message.text || "");
    if (parsed.type === "help" || parsed.type === "unknown") {
      await this.telegram.sendMessage(chatId, parsed.type === "unknown" ? `❓ Не понял команду.\n\n${helpText()}` : helpText());
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
        await this.telegram.sendMessage(chatId, `⏳ Уже скачиваю ${jobTitle(existing)}.\n${describeJob(existing)}\n/status — детали, /cancel — отменить.`);
        return;
      }
      const job = this.store.createJob({
        chatId,
        status: "queued",
        titleQuery: parsed.titleQuery,
        fromChapter: parsed.fromChapter,
        toChapter: parsed.toChapter,
        mergeVerticalPages: this.store.getMergeVerticalPages(chatId),
        progress: "Ищу мангу"
      });
      await this.sendProgress(job.id, `⬇️ Начинаю скачивать ${parsed.titleQuery}: ${formatChapterRange(parsed.fromChapter, parsed.toChapter)}.`);
      return;
    }
  }

  async handleCallback(callback) {
    const chatId = String(callback.message?.chat?.id || "");
    const data = String(callback.data || "");
    const match = data.match(/^choose:([\w-]+):(\d+)$/);
    if (!match) return this.telegram.answerCallbackQuery(callback.id, "❌ Неизвестное действие");
    const job = this.store.getJob(match[1]);
    const choice = job?.choiceManifest?.[Number(match[2])];
    if (!job || job.chatId !== chatId || job.status !== "waiting_choice" || !choice) {
      return this.telegram.answerCallbackQuery(callback.id, "⏳ Выбор уже недоступен");
    }
    const choiceMessageId = Number(callback.message?.message_id);
    this.store.updateJob(job.id, {
      status: "queued",
      seriesUrl: choice.url,
      seriesTitle: choice.title,
      choiceManifest: [],
      progress: `Выбрано: ${choice.title}`,
      ...(Number.isInteger(choiceMessageId) && choiceMessageId > 0
        ? { statusMessageId: choiceMessageId }
        : {})
    });
    await this.telegram.answerCallbackQuery(callback.id, "✅ Выбрано");
    if (Number.isInteger(choiceMessageId) && choiceMessageId > 0 && typeof this.telegram.editMessage === "function") {
      try {
        await this.telegram.editMessage(
          chatId,
          choiceMessageId,
          `✅ Выбрано: ${choice.title}`,
          { reply_markup: { inline_keyboard: [] } }
        );
      } catch (error) {
        console.error("Cannot replace Telegram choice keyboard with confirmation", error);
      }
    }
    await this.sendProgress(job.id, `✅ Скачиваю ${choice.title}: выбор подтверждён, начинаю обработку.`);
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
      await this.sendProgress(job.id, downloadProgress(job, job.progress));

      job = await this.resolveSeries(job);
      if (job.status === "waiting_choice") return;
      const coverPath = path.join(workDir, "cover.img");
      await fs.mkdir(workDir, { recursive: true });
      const canResume = initialJob.status === "resume_pending" &&
        job.seriesUrl && job.seriesTitle && job.chapterManifest.length > 0 &&
        await isNonEmptyFile(coverPath);
      if (canResume) {
        job = this.store.updateJob(job.id, {
          progress: `Возобновляю сохранённый диапазон (${job.chapterManifest.length} глав)`
        });
        await this.sendProgress(job.id, downloadProgress(job, job.progress));
      } else {
        const series = await this.mangaApp.loadSeries(job.seriesUrl);
        const chapters = selectChapterRange(series.chapters, job.fromChapter, job.toChapter);
        job = this.store.updateJob(job.id, {
          seriesTitle: series.title,
          chapterManifest: chapters,
          progress: `Зафиксирован диапазон: ${chapters[0].title} — ${chapters.at(-1).title} (${chapters.length} глав)`
        });
        await this.sendProgress(job.id, downloadProgress(job, job.progress));
        if (!await isNonEmptyFile(coverPath)) {
          const cover = await this.mangaApp.downloadCover({
            coverUrl: series.coverUrl,
            seriesUrl: job.seriesUrl
          });
          await fs.writeFile(coverPath, cover, { mode: 0o600 });
        }
      }

      const imageSources = await this.processChapters(job);
      job = this.store.getJob(job.id);
      if (job.status === "cancelled") return;

      job = this.store.updateJob(job.id, { progress: `Собираю Kindle EPUB напрямую из изображений ${imageSources.length} глав` });
      await this.sendProgress(job.id, downloadProgress(job, job.progress));
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
      await this.sendProgress(job.id, `📤 Скачиваю ${jobTitle(job)}: собрано и поставлено в Kindle-очередь ${queued.length} EPUB.`);
      await this.reconcileDelivery(job);
    } catch (error) {
      const latest = this.store.getJob(initialJob.id);
      if (latest?.status === "cancelled") return;
      const message = errorMessage(error);
      this.store.updateJob(initialJob.id, { status: "failed", error: message, progress: "Ошибка" });
      await this.sendProgress(initialJob.id, `❌ Не удалось скачать ${jobTitle(latest || initialJob)}: ${message}\n/retry — повторить.`);
    } finally {
      const latest = this.store.getJob(initialJob.id);
      if (["completed", "cancelled"].includes(latest?.status)) {
        await this.cleanupWorkspace(initialJob.id);
      }
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
      await this.sendProgress(waiting.id, `🔎 Скачиваю ${jobTitle(waiting)}: нужно выбрать произведение.`);
      await this.telegram.sendMessage(waiting.chatId, "📚 Нашёл несколько вариантов. Выберите нужный:", {
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
        const chapterDir = path.join(workDir, String(index + 1).padStart(4, "0"));
        const checkpoint = await readChapterCheckpoint(chapterDir, chapter);
        if (checkpoint) {
          completedCount += 1;
          this.store.updateJob(job.id, {
            progress: `Восстановлено ${completedCount}/${chapters.length}: ${chapter.title}`
          });
          return checkpoint;
        }
        const processing = `Обрабатываю ${index + 1}/${chapters.length}: ${chapter.title}`;
        this.store.updateJob(job.id, { progress: processing });
        const pages = await this.mangaApp.processChapterImages({
          chapterId: chapter.id,
          mangaTitle: job.seriesTitle,
          chapterTitle: chapter.title
        });

        const latest = this.store.getJob(job.id);
        if (!latest || latest.status === "cancelled") return null;

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
        await writeChapterCheckpoint(chapterDir, chapter, storedPages);

        completedCount += 1;
        const completed = `Обработано ${completedCount}/${chapters.length}: ${chapter.title}`;
        this.store.updateJob(job.id, { progress: completed });
        if (completedCount % 3 === 0 || completedCount === chapters.length) {
          await this.sendProgress(job.id, `⬇️ Скачиваю ${jobTitle(job)}: обработано ${completedCount}/${chapters.length} глав`);
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
        await this.sendProgress(job.id, downloadProgress(current, current.progress));
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
        await this.sendProgress(job.id, `❌ Не удалось скачать ${jobTitle(job)}: Kindle не принял ${failed.filename}: ${failed.error || "неизвестная ошибка"}`);
        return;
      }
      if (entries.every((entry) => entry.status === "sent")) {
        this.store.updateJob(job.id, { status: "completed", kindleJobs: entries, progress: "Amazon принял все EPUB к доставке" });
        await this.sendProgress(job.id, `✅ Готово: Amazon принял ${entries.length} EPUB к доставке. Синхронизация с Kindle может занять время.`);
        await this.cleanupWorkspace(job.id);
        return;
      }
      if (entries.some((entry) => entry.status === "waiting_auth")) {
        const wasWaiting = job.status === "waiting_auth";
        this.store.updateJob(job.id, { status: "waiting_auth", kindleJobs: entries, progress: "Amazon требует вход" });
        if (!wasWaiting) await this.sendKindleConnectUrl(job.chatId, job);
        return;
      }
      const progress = "Amazon обрабатывает файлы";
      this.store.updateJob(job.id, { status: "delivering", kindleJobs: entries, progress });
      if (job.progress !== progress) {
        await this.sendProgress(job.id, downloadProgress(job, progress));
      }
    } catch (error) {
      console.error("Delivery reconciliation failed", error);
    }
  }

  async sendStatus(chatId) {
    const job = this.store.latestJob(chatId);
    if (!job) return this.telegram.sendMessage(chatId, "ℹ️ Заданий пока нет.");
    const files = await this.describeKindleFiles(job.kindleJobs);
    await this.telegram.sendMessage(chatId, `ℹ️ ${jobTitle(job)}\n${describeJob(job)}${files ? `\n${files}` : ""}${job.error ? `\nОшибка: ${job.error}` : ""}`);
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
    if (job) {
      await this.sendProgress(job.id, `🛑 Скачивание ${jobTitle(job)} отменено. Уже переданные в Amazon файлы нельзя отозвать автоматически.`);
    } else {
      await this.telegram.sendMessage(chatId, "ℹ️ Нет активного задания для отмены.");
    }
  }

  async retry(chatId) {
    const job = this.store.retryLatest(chatId);
    if (job) {
      await this.sendProgress(job.id, `🔄 Повторно скачиваю ${jobTitle(job)}.`);
    } else {
      await this.telegram.sendMessage(chatId, "ℹ️ Нет неудавшегося задания для повтора.");
    }
  }

  async cleanupWorkspace(jobId) {
    const workDir = path.join(this.tempRoot, jobId);
    await fs.rm(workDir, { recursive: true, force: true }).catch((error) => {
      console.error("Cannot clean manga job workspace", workDir, error);
    });
  }

  async mergeVerticalPages(chatId, enabled) {
    if (enabled === null) {
      const current = this.store.getMergeVerticalPages(chatId);
      await this.telegram.sendMessage(chatId, `⚙️ Merge vertical pages: ${current ? "включено" : "выключено"}.\n/merge on или /merge off`);
      return;
    }
    this.store.setMergeVerticalPages(chatId, enabled);
    await this.telegram.sendMessage(chatId, `⚙️ Merge vertical pages ${enabled ? "включено" : "выключено"}. Новые задания будут использовать эту настройку.`);
  }

  async sendKindleConnectUrl(chatId, job = null) {
    try {
      const result = await this.kindle.connectToken();
      const text = `🔐 ${job ? `Скачиваю ${jobTitle(job)}: ` : ""}Amazon требует вход. Откройте одноразовую ссылку в течение 10 минут:\n${result.url}`;
      if (job) await this.sendProgress(job.id, text);
      else await this.telegram.sendMessage(chatId, text);
    } catch (error) {
      const text = `❌ Не удалось открыть Amazon-вход: ${errorMessage(error)}`;
      if (job) await this.sendProgress(job.id, text);
      else await this.telegram.sendMessage(chatId, text);
    }
  }

  async sendProgress(jobId, text) {
    const previous = this.progressUpdates.get(jobId) || Promise.resolve();
    const update = previous
      .catch(() => {})
      .then(() => this.updateProgressMessage(jobId, text));
    this.progressUpdates.set(jobId, update);
    try {
      await update;
    } finally {
      if (this.progressUpdates.get(jobId) === update) {
        this.progressUpdates.delete(jobId);
      }
    }
  }

  async updateProgressMessage(jobId, text) {
    const job = this.store.getJob(jobId);
    if (!job) return;
    try {
      if (job.statusMessageId && typeof this.telegram.editMessage === "function") {
        try {
          await this.telegram.editMessage(job.chatId, job.statusMessageId, text);
          return;
        } catch (error) {
          console.error("Cannot edit Telegram progress message; creating a replacement", error);
        }
      }
      const message = await this.telegram.sendMessage(job.chatId, text);
      const messageId = Number(message?.message_id);
      if (Number.isInteger(messageId) && messageId > 0) {
        this.store.updateJob(job.id, { statusMessageId: messageId });
      }
    } catch (error) {
      console.error("Telegram progress notification failed", error);
    }
  }
}

async function isNonEmptyFile(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

async function readChapterCheckpoint(chapterDir, chapter) {
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(chapterDir, "manifest.json"), "utf8"));
    if (
      manifest.version !== 1 ||
      manifest.chapterId !== chapter.id ||
      manifest.chapterTitle !== chapter.title ||
      !Array.isArray(manifest.pages) ||
      manifest.pages.length === 0
    ) {
      return null;
    }
    const pages = [];
    for (const page of manifest.pages) {
      if (
        !/^page-\d{4}\.(?:jpg|png)$/.test(page.fileName) ||
        !["jpg", "png"].includes(page.format) ||
        !Number.isInteger(page.width) || page.width < 1 ||
        !Number.isInteger(page.height) || page.height < 1
      ) {
        return null;
      }
      const filePath = path.join(chapterDir, page.fileName);
      if (!await isNonEmptyFile(filePath)) return null;
      pages.push({
        filePath,
        width: page.width,
        height: page.height,
        format: page.format
      });
    }
    return { name: chapter.title, chapterTitle: chapter.title, pages };
  } catch {
    return null;
  }
}

async function writeChapterCheckpoint(chapterDir, chapter, pages) {
  const manifest = {
    version: 1,
    chapterId: chapter.id,
    chapterTitle: chapter.title,
    pages: pages.map((page) => ({
      fileName: path.basename(page.filePath),
      width: page.width,
      height: page.height,
      format: page.format
    }))
  };
  const temporary = path.join(chapterDir, "manifest.json.tmp");
  const destination = path.join(chapterDir, "manifest.json");
  await fs.writeFile(temporary, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
  await fs.rename(temporary, destination);
}

function errorMessage(error) { return error instanceof Error ? error.message : String(error); }
function formatMegabytes(bytes) { return `${(Number(bytes) / 1_000_000).toFixed(1)} МБ`; }
function jobTitle(job) { return job.seriesTitle || job.titleQuery; }
function downloadProgress(job, progress) {
  const normalized = String(progress).replace(/^[А-ЯЁ]/u, (letter) => letter.toLocaleLowerCase("ru-RU"));
  return `${progressEmoji(progress)} Скачиваю ${jobTitle(job)}: ${normalized}.`;
}
function progressEmoji(progress) {
  if (/^(?:Определяю|Ищу)/u.test(progress)) return "🔎";
  if (/^Зафиксирован/u.test(progress)) return "📚";
  if (/^Собираю/u.test(progress)) return "🛠️";
  if (/^Передаю/u.test(progress)) return "📤";
  if (/^Amazon/u.test(progress)) return "⏳";
  return "⬇️";
}
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
