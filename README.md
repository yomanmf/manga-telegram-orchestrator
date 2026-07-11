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
.railway/                   Railway project configuration
.github/workflows/ci.yml    checks for all services
```

| Railway service | Root directory | Runtime |
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
  → PDF collector
  → kindle-uploader
  → Amazon Send to Kindle
```

The web interface remains directly available through `manga-pdf-processor`
and uses the same Kindle uploader.

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

## Railway

The project uses three services, an S3-compatible bucket, and two persistent
volumes:

- the `manga-bot-worker` volume stores SQLite data at `/data`;
- the `kindle-uploader` volume stores the Amazon browser profile and queue at
  `/data`;
- the `kindle-pdf-queue` bucket temporarily stores PDFs between services.

Secrets are never committed. Railway stores the Telegram token, webhook
secret, web application password and session token, Kindle shared secret, and
S3 credentials.

Each application's variables are documented in its `.env.example` file.

The current infrastructure state is declared in `.railway/railway.ts`.
Preview changes before applying them:

```bash
npx railway config plan
```

The configuration connects all three Railway services to this GitHub monorepo
and builds each service from its own root directory. Secret values are imported
as `preserve()` and never enter Git.

## Telegram

Example command:

```text
Send The Fable from chapter 201 to latest
Отправь One Piece (Color) с 23 до 100
```

Both numeric boundaries are inclusive, so the second example processes chapters
23 through 100. Manga titles may contain spaces and parentheses.

Available commands include `/status`, `/cancel`, `/retry`, `/kindle`,
`/merge on`, and `/merge off`. `Merge vertical pages` is enabled by default and
matches the web interface's PDF collector behavior, including right-to-left
spreads and an empty left half for an unpaired vertical page.
