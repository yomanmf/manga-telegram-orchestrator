# syntax=docker/dockerfile:1.7
FROM node:20-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ poppler-utils \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev
RUN node -e 'import("sharp").then(async ({ default: sharp }) => sharp({ create: { width: 1, height: 1, channels: 3, background: "#fff" } }).jpeg().toBuffer())'

COPY src ./src
COPY test ./test

ENV NODE_ENV=production
ENV DATA_DIR=/data

CMD ["node", "src/index.mjs"]
