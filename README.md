# Manga to Kindle Monorepo

The complete production project lives in one repository: Telegram controls,
the existing manga processing web interface, and browser automation for Send
to Kindle.

## Structure

```text
apps/
├── manga-bot-worker/       Telegram webhook, job queue, PDF collector
├── manga-pdf-processor/    web UI, WeebCentral, page processing
└── kindle-uploader/        S3 queue, Playwright, Chromium, and noVNC
.github/workflows/ci.yml    checks for all services
```

| Yandex Cloud service | Root directory | Runtime |
| --- | --- | --- |
| `manga-bot-worker` | `/apps/manga-bot-worker` | Node.js 20, Express, SQLite |
| `manga-pdf-processor` | `/apps/manga-pdf-processor` | Bun, Hono, pdf-lib, Sharp |
| `kindle-uploader` | `/apps/kindle-uploader` | Node.js, Playwright, Chromium |

## Data flow

```text
Telegram
  → manga-bot-worker
  → manga-pdf-processor
  → WeebCentral
  → normalized chapter images
  → one-shot image layout subprocess
  → fixed-layout EPUB packaging with the selected manga cover
  → kindle-uploader
  → Amazon Send to Kindle
```

The web interface remains directly available through `manga-pdf-processor`
and uses the same Kindle uploader. Browser uploads to the Kindle queue are sent
in resumable 8 MiB chunks, so a network interruption resumes from the byte
offset already stored by the uploader instead of restarting a 200 MB file.

The Telegram path writes normalized chapter images to its per-job temporary
workspace and creates right-to-left spreads directly with Sharp. It packages
those JPEG pages into fixed-layout EPUB volumes without first creating and then
re-rendering intermediate PDFs. The legacy PDF/CBZ web interface remains
available and uses batched PDF checkpoints for compatibility.
The processor downloads up to six chapter images concurrently and commits PDF
operations in batches instead of serializing the growing document after every
page. The bot processes two chapters concurrently, and split EPUB volumes are
rendered in a pool of two workers. All pools preserve source order and stop
scheduling new work after an error. Internal ZIP responses use `STORE` because
their PDF and image payloads are already compressed.
For every generated file, the worker maps its first included chapter to the
corresponding manga volume and looks up that volume's English-edition cover.
The resolver prefers the exact Apple Books artwork requested at up to
1600x2560, then other publisher/catalog sources, and ranks real image dimensions
ahead of thumbnail-source priority. Publisher artwork is embedded byte-for-byte
without labels, cropping, or other visual changes. If chapter-to-volume metadata
or an English volume cover is not available, the selected title's regular series
cover is used as the fallback.
The EPUB sets both EPUB 3 `cover-image` metadata and the legacy Kindle
`meta name="cover"` entry, because a first PDF page alone is not a reliable
Kindle library cover. The cover image is intentionally absent from the reading
spine, so opening the book starts on the first manga page rather than a cover
page.
The subprocess exits after packaging so the operating system reclaims PDF and
image memory immediately, and the complete job workspace is removed after
success, cancellation, or failure.

## Local verification

```bash
npm ci
npm ci --prefix apps/manga-bot-worker
npm ci --prefix apps/manga-pdf-processor
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --prefix apps/kindle-uploader
npm run verify
```

The root command checks the syntax of all three services, the Telegram → PDF
→ Kindle orchestration tests, and the web processor contract tests.

## Yandex Cloud

Production runs in Yandex Cloud and uses three services, a Yandex Object
Storage bucket, and two persistent disks:

- the `manga-bot-worker` volume stores SQLite data at `/data`;
- completed chapter images are checkpointed under `/data/manga-jobs` while a
  request is active, so `/retry` and container restarts reuse finished chapters;
- the `kindle-uploader` volume stores the Amazon browser profile and queue at
  `/data`;
- the `kindle-pdf-queue` Object Storage bucket temporarily stores books between
  services through its S3-compatible API.

Each Telegram request gets its own Kindle batch. The worker first stages all of
the request's PDF volumes in the Kindle uploader, then starts one Amazon
submission containing the whole batch. This prevents a later upload from
replacing an earlier pending submission in the Send to Kindle page. The uploader
accepts Amazon's `In library` confirmation when it is available. If Amazon does
not expose that status, the uploader finalizes the request after the complete
`Ready to Send` batch has stayed cleared for a protective interval. Device
synchronization remains asynchronous after Amazon accepts the batch.

Secrets are never committed. The Yandex Cloud runtime stores the Telegram
token, webhook secret, web application password and session token, Kindle
shared secret, and Object Storage credentials.

Each application's variables are documented in its `.env.example` file.
The performance defaults can be tuned with
`WEEBCENTRAL_IMAGE_CONCURRENCY`, `PDF_SERIALIZATION_BATCH_SIZE`,
`CHAPTER_PROCESSING_CONCURRENCY`, `EPUB_BUILD_CONCURRENCY`, and
`KINDLE_UPLOAD_CONCURRENCY`. Increase them only after checking container memory
and upstream throttling; the checked-in defaults are deliberately bounded.
WeebCentral HTML and image requests honor `Retry-After` on HTTP 429 and otherwise
use bounded exponential retry delays for temporary upstream failures.

Each service is built from its own directory in this monorepo.

Pushes to `main` build only service images affected by the diff. After the full
verification job passes, CI promotes their immutable revisions to `candidate`.
The VM deploy agent applies a Compose image override one service at a time,
checks local HTTP readiness, rolls back to the previous image on failure, and
writes a sanitized terminal result to the serial console for CI.

The deploy agent can set `TELEGRAM_API_IP` to an official Telegram Bot API IPv4
address when the address returned by cloud DNS is unreachable from the VM. The
override is applied only to `manga-bot-worker`; the bot token still goes directly
to Telegram and never passes through a third-party proxy.

The bot starts a new EPUB volume after 150 MB of rendered page assets, leaving
room for its cover and package metadata below the uploader's 200 MB hard limit.

## Telegram

Production uses Telegram long polling by default because Telegram cannot reach
the Yandex Cloud public webhook route reliably. Set `TELEGRAM_UPDATE_MODE=webhook`
only in a network where Telegram can connect to `PUBLIC_BASE_URL`.

Set `TELEGRAM_OWNER_USER_ID` to the owner's numeric Telegram user ID. The bot
accepts messages and button callbacks only from that user in the user's private
chat with the bot. The legacy `TELEGRAM_ALLOWED_CHAT_ID` variable is accepted
during migration and is interpreted as the owner's user ID.

Example command:

```text
Send The Fable from chapter 201 to latest
Отправь One Piece (Color) с 23 до 100
Отправь One Piece (Color) все главы
```

Both numeric boundaries are inclusive, so the second example processes chapters
23 through 100. Manga titles may contain spaces and parentheses.
The `все главы` form automatically uses every available numbered chapter.

Available commands include `/status`, `/cancel`, `/retry`, `/kindle`,
`/merge on`, and `/merge off`. `Merge vertical pages` is enabled by default and
matches the web interface's PDF collector behavior, including right-to-left
spreads and an empty left half for an unpaired vertical page.
