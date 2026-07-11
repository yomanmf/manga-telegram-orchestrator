# syntax=docker/dockerfile:1.7
FROM mcr.microsoft.com/playwright:v1.61.1-noble

USER root

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    fluxbox \
    novnc \
    tini \
    x11vnc \
    xvfb \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV DISPLAY=:99

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.mjs submission.mjs chromium-profile.mjs upload-progress.mjs start.sh ./
RUN chmod +x /app/start.sh

CMD ["/usr/bin/tini", "--", "/app/start.sh"]
