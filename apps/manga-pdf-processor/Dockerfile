FROM oven/bun:1.2.18

WORKDIR /app

COPY package.json package-lock.json ./
RUN bun install --production

COPY index.ts pdf-merge-contract.mjs pdf-utils.mjs ./

ENV NODE_ENV=production

CMD ["bun", "run", "start"]
