import fs from "node:fs/promises";

import { buildKindleImageVolumes } from "./image-books.mjs";

const [, , configPath, resultPath] = process.argv;
if (!configPath || !resultPath) {
  throw new Error("Usage: node image-worker.mjs <config.json> <result.json>");
}

const config = JSON.parse(await fs.readFile(configPath, "utf8"));
const volumes = await buildKindleImageVolumes(config);
await fs.writeFile(resultPath, JSON.stringify(volumes), "utf8");
