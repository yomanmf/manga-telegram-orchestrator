import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const packageJson = JSON.parse(
  await readFile(new URL("./package.json", import.meta.url), "utf8")
);
const source = await readFile(new URL("./index.ts", import.meta.url), "utf8");

test("declares every external runtime import as a production dependency", () => {
  const imports = new Set();
  const patterns = [
    /\bfrom\s+["']([^"']+)["']/g,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g
  ];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (!specifier.startsWith(".") && !specifier.startsWith("node:")) {
        imports.add(specifier.startsWith("@")
          ? specifier.split("/").slice(0, 2).join("/")
          : specifier.split("/")[0]);
      }
    }
  }

  const declared = packageJson.dependencies || {};
  for (const dependency of imports) {
    assert.ok(
      declared[dependency],
      `${dependency} is imported by index.ts but missing from dependencies`
    );
  }
});

test("sharp loads and performs native image processing", async () => {
  const { default: sharp } = await import("sharp");
  const bytes = await sharp({
    create: {
      width: 1,
      height: 1,
      channels: 4,
      background: "#fff"
    }
  }).png().toBuffer();

  assert.ok(bytes.length > 0);
});
