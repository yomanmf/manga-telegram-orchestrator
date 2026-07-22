FROM oven/bun:1.2.18

WORKDIR /app

COPY package.json package-lock.json ./
RUN bun install --production
RUN bun -e 'import sharp from "sharp"; await sharp({ create: { width: 1, height: 1, channels: 4, background: "#fff" } }).png().toBuffer()'

COPY index.ts pdf-merge-contract.mjs pdf-batch-writer.mjs pdf-utils.mjs processing-performance.mjs kindle-job-contract.mjs kindle-upload-contract.mjs kindle-filename.mjs weebcentral-cover.mjs weebcentral-image-fetch.mjs ./

ENV NODE_ENV=production

CMD ["bun", "run", "start"]
