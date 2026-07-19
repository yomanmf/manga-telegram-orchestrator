import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WORKER_PATH = fileURLToPath(new URL("./pdf-worker.mjs", import.meta.url));

export async function buildKindleVolumesInSubprocess(options) {
  if (options.sourcePdfs.some((source) => source.bytes)) {
    throw new Error("PDF subprocess requires source files, not in-memory buffers");
  }

  const controlDir = path.dirname(options.destinationDir);
  await fs.mkdir(controlDir, { recursive: true });
  const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const configPath = path.join(controlDir, `.pdf-assembly-${nonce}.json`);
  const resultPath = path.join(controlDir, `.pdf-assembly-${nonce}.result.json`);
  await fs.writeFile(configPath, JSON.stringify(options), "utf8");

  try {
    await runWorker(configPath, resultPath);
    const volumes = JSON.parse(await fs.readFile(resultPath, "utf8"));
    if (!Array.isArray(volumes) || volumes.some((volume) => !volume.filePath || !volume.fileName)) {
      throw new Error("Kindle book assembly subprocess returned an invalid result");
    }
    return volumes;
  } finally {
    await Promise.all([
      fs.rm(configPath, { force: true }),
      fs.rm(resultPath, { force: true })
    ]);
  }
}

function runWorker(configPath, resultPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER_PATH, configPath, resultPath], {
      stdio: ["ignore", "ignore", "pipe"]
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-16_000);
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(
        `Kindle book assembly subprocess failed (${signal || code})${stderr.trim() ? `: ${stderr.trim()}` : ""}`
      ));
    });
  });
}
