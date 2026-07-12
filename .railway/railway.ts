import { bucket, defineRailway, github, preserve, project, service, volume } from "railway/iac";

export default defineRailway(() => {
  const mangaBotWorkerVolume = volume("manga-bot-worker-volume", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "us-east4-eqdc4a", sizeMB: 5000 });
  const kindleUploaderVolume = volume("kindle-uploader-volume", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "us-east4-eqdc4a", sizeMB: 5000 });
  const kindlePdfQueue = bucket("kindle-pdf-queue", { region: "ams" });
  const mangaBotWorker = service("manga-bot-worker", {
    source: github("yomanmf/manga-telegram-orchestrator", {
      branch: "main",
      rootDirectory: "/apps/manga-bot-worker",
    }),
    build: {
      builder: "DOCKERFILE",
      dockerfilePath: "Dockerfile",
      watchPatterns: ["/apps/manga-bot-worker/**"],
    },
    healthcheck: "/health",
    healthcheckTimeout: 300,
    replicas: 1,
    volumeMounts: {
      "/data": mangaBotWorkerVolume,
    },
    env: {
      DATA_DIR: preserve(),
      KINDLE_SHARED_SECRET: preserve(),
      KINDLE_WORKER_URL: preserve(),
      MANGA_APP_SESSION_TOKEN: preserve(),
      MANGA_APP_URL: preserve(),
      MAX_PDF_BYTES: preserve(),
      PUBLIC_BASE_URL: preserve(),
      TELEGRAM_ALLOWED_CHAT_ID: preserve(),
      TELEGRAM_BOT_TOKEN: preserve(),
      TELEGRAM_WEBHOOK_SECRET: preserve(),
    },
  });
  const mangaPdfProcessor = service("manga-pdf-processor", {
    source: github("yomanmf/manga-telegram-orchestrator", {
      branch: "main",
      rootDirectory: "/apps/manga-pdf-processor",
    }),
    build: {
      builder: "DOCKERFILE",
      dockerfilePath: "Dockerfile",
      watchPatterns: ["/apps/manga-pdf-processor/**"],
    },
    healthcheck: "/health",
    healthcheckTimeout: 300,
    replicas: 1,
    env: {
      APP_PASSWORD: preserve(),
      APP_SESSION_TOKEN: preserve(),
      FUNCTION_RELEASE: preserve(),
      FUNCTION_SOURCE_01: preserve(),
      FUNCTION_SOURCE_02: preserve(),
      FUNCTION_SOURCE_03: preserve(),
      FUNCTION_SOURCE_04: preserve(),
      FUNCTION_SOURCE_05: preserve(),
      FUNCTION_SOURCE_06: preserve(),
      FUNCTION_SOURCE_CHUNKS: preserve(),
      FUNCTION_SOURCE_SHA256: preserve(),
      KINDLE_SHARED_SECRET: preserve(),
      KINDLE_WORKER_URL: preserve(),
      PDF_UTILS_SOURCE: preserve(),
    },
  });
  const kindleUploader = service("kindle-uploader", {
    source: github("yomanmf/manga-telegram-orchestrator", {
      branch: "main",
      rootDirectory: "/apps/kindle-uploader",
    }),
    build: {
      builder: "DOCKERFILE",
      dockerfilePath: "Dockerfile",
      watchPatterns: ["/apps/kindle-uploader/**"],
    },
    healthcheck: "/health",
    healthcheckTimeout: 300,
    deploy: {
      restartPolicyType: "ALWAYS",
    },
    replicas: 1,
    volumeMounts: {
      "/data": kindleUploaderVolume,
    },
    env: {
      APP_ORIGIN: preserve(),
      AWS_ACCESS_KEY_ID: preserve(),
      AWS_DEFAULT_REGION: preserve(),
      AWS_ENDPOINT_URL: preserve(),
      AWS_S3_BUCKET_NAME: preserve(),
      AWS_S3_URL_STYLE: preserve(),
      AWS_SECRET_ACCESS_KEY: preserve(),
      DATA_DIR: preserve(),
      KINDLE_SHARED_SECRET: preserve(),
      PORT: preserve(),
      PUBLIC_BASE_URL: preserve(),
    },
  });

  return project("PDF downloader and converter", {
    resources: [mangaBotWorker, mangaPdfProcessor, kindleUploader, mangaBotWorkerVolume, kindleUploaderVolume, kindlePdfQueue],
  });
});
