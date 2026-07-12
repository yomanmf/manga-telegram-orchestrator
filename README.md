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
  → one-shot PDF assembly subprocess
  → kindle-uploader
  → Amazon Send to Kindle
```

The web interface remains directly available through `manga-pdf-processor`
and uses the same Kindle uploader. Browser uploads to the Kindle queue are sent
in resumable 8 MiB chunks, so a network interruption resumes from the byte
offset already stored by the uploader instead of restarting a 200 MB PDF.

The bot writes chapter PDFs to its per-job temporary workspace. Final Kindle
volumes are assembled in a one-shot child process, checkpointed once per source
PDF, and written to disk as soon as each volume closes. This keeps completed
volume bytes out of the long-lived bot heap. The child process exits after
assembly so the operating system reclaims `pdf-lib` memory immediately, and
the complete job workspace is removed after success, cancellation, or failure.

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
- the `kindle-uploader` volume stores the Amazon browser profile and queue at
  `/data`;
- the `kindle-pdf-queue` Object Storage bucket temporarily stores PDFs between
  services through its S3-compatible API.

The Kindle queue advances only after Amazon confirms the submitted PDF as `In
library`. This prevents the next upload from replacing the previous pending
submission in the Send to Kindle page. Device synchronization remains
asynchronous after that confirmation.

Secrets are never committed. The Yandex Cloud runtime stores the Telegram
token, webhook secret, web application password and session token, Kindle
shared secret, and Object Storage credentials.

Each application's variables are documented in its `.env.example` file.

Each service is built from its own directory in this monorepo.

The bot caps each generated PDF volume at 150 MB, leaving room below the
provider's hard upload limit for reliable delivery to Kindle devices.

## Telegram

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
