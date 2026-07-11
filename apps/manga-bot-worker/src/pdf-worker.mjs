import fs from "node:fs/promises";

import { buildKindleVolumes } from "./pdf.mjs";

const [, , configPath, resultPath] = process.argv;
if (!configPath || !resultPath) {
  throw new Error("Usage: node pdf-worker.mjs <config.json> <result.json>");
}

const config = JSON.parse(await fs.readFile(configPath, "utf8"));
const volumes = await buildKindleVolumes(config);
await fs.writeFile(resultPath, JSON.stringify(volumes), "utf8");
