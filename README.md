# Manga to Kindle Monorepo

Весь рабочий проект в одном репозитории: Telegram-управление, существующий
веб-интерфейс обработки манги и браузерная автоматизация Send to Kindle.

## Структура

```text
apps/
├── manga-bot-worker/       Telegram webhook, очередь, PDF collector
├── manga-pdf-processor/    веб-интерфейс, WeebCentral, обработка страниц
└── kindle-uploader/        S3-очередь, Playwright, Chromium и noVNC
.railway/                   проектная Railway-конфигурация
.github/workflows/ci.yml    проверки всех сервисов
```

| Сервис Railway | Root directory | Runtime |
| --- | --- | --- |
| `manga-bot-worker` | `/apps/manga-bot-worker` | Node.js 20, Express, SQLite |
| `manga-pdf-processor` | `/apps/manga-pdf-processor` | Bun, Hono, pdf-lib |
| `kindle-uploader` | `/apps/kindle-uploader` | Node.js, Playwright, Chromium |

## Поток данных

```text
Telegram
  → manga-bot-worker
  → manga-pdf-processor
  → WeebCentral
  → PDF collector
  → kindle-uploader
  → Amazon Send to Kindle
```

Веб-интерфейс остаётся доступен напрямую через `manga-pdf-processor` и
использует тот же Kindle uploader.

## Локальные проверки

```bash
npm ci
npm ci --prefix apps/manga-bot-worker
npm ci --prefix apps/manga-pdf-processor
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --prefix apps/kindle-uploader
npm run verify
```

Корневая команда проверяет синтаксис всех трёх сервисов, тесты Telegram → PDF
→ Kindle orchestration и контрактные тесты веб-процессора.

## Railway

Проект использует три services, S3-compatible bucket и два persistent volumes:

- volume `manga-bot-worker` в `/data` хранит SQLite;
- volume `kindle-uploader` в `/data` хранит Amazon browser profile и очередь;
- bucket `kindle-pdf-queue` временно хранит PDF между сервисами.

Секреты не коммитятся. В Railway остаются Telegram token, webhook secret,
пароль/session token веб-приложения, Kindle shared secret и S3 credentials.

Переменные каждого приложения перечислены в его `.env.example`.

Текущее состояние инфраструктуры описано декларативно в
`.railway/railway.ts`. Проверить изменения перед применением:

```bash
npx railway config plan
```

Конфигурация переводит все три Railway-сервиса на этот GitHub monorepo и
собирает каждый сервис из собственного root directory. Секретные значения
импортированы как `preserve()` и в Git не попадают.

## Telegram

Пример команды:

```text
Отправь The Fable с 201 до последней
```

Доступны `/status`, `/cancel`, `/retry`, `/kindle`, `/merge on` и `/merge off`.
`Merge vertical pages` включён по умолчанию и повторяет PDF collector
веб-интерфейса, включая RTL-развороты и пустую левую половину для одиночной
vertical-страницы.
