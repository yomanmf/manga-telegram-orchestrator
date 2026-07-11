# Manga Telegram Orchestrator

Single-user Telegram control plane for the existing Manga PDF Processor and
Kindle uploader services.

The web interface remains untouched. This service calls its authenticated
WeebCentral routes, turns selected chapter PDFs into Kindle-sized volumes, and
hands the completed files to the existing browser-based Kindle uploader.

## Telegram commands

- `Отправь Fable с 201 до последней`
- `/status`
- `/cancel`
- `/retry`
- `/kindle` — show a short-lived Amazon re-authentication link when needed

## Required Railway variables

See `.env.example`. `MANGA_APP_SESSION_TOKEN` must match the existing
`APP_SESSION_TOKEN`; it is sent only as the authenticated session cookie to the
existing service. `KINDLE_SHARED_SECRET` is the existing uploader secret.

## Safety model

- Only `TELEGRAM_ALLOWED_CHAT_ID` can issue commands.
- Telegram webhooks require `TELEGRAM_WEBHOOK_SECRET`.
- All job state is durable SQLite state under `DATA_DIR`.
- The orchestrator uses one job at a time and treats Amazon re-authentication
  as a recoverable `waiting_auth` state.
- PDFs never pass through Telegram; they are uploaded directly to the existing
  Kindle uploader.

