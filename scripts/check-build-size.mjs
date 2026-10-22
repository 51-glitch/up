#!/usr/bin/env node

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assetsDir = join(ROOT, "docs/.vitepress/dist/assets");
const chunksDir = join(assetsDir, "chunks");

const budgets = [
  {
    label: "local search index",
    directory: chunksDir,
    pattern: /^@localSearchIndex.*\.js$/,
    expected: 2,
    raw: 610_000,
    gzip: 185_000,
  },
  {
    label: "framework",
    directory: chunksDir,
    pattern: /^framework.*\.js$/,
    expected: 1,
    raw: 125_000,
    gzip: 50_000,
  },
  {
    label: "search UI",
    directory: chunksDir,
    pattern: /^VPLocalSearchBox.*\.js$/,
    expected: 1,
    raw: 75_000,
    gzip: 28_000,
  },
  {
    label: "theme",
    directory: chunksDir,
    pattern: /^theme.*\.js$/,
    expected: 1,
    raw: 70_000,
    gzip: 22_000,
  },
];

const format = (bytes) => `${(bytes / 1024).toFixed(1)} KiB`;
let failed = false;
const records = [];
const failures = [];
const { values } = parseArgs({ options: { "json-out": { type: "string" } } });
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

function rasterAssets(directory, output = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) rasterAssets(path, output);
    else if (/\.(?:avif|jpe?g|png|webp)$/i.test(entry.name)) output.push(path);
  }
  return output;
}

for (const budget of budgets) {
  const files = readdirSync(budget.directory).filter((name) => budget.pattern.test(name));
  if (files.length !== budget.expected) {
    console.error(`${budget.label}: expected ${budget.expected} chunk(s), found ${files.length}`);
    failures.push({ code: "chunk-count", label: budget.label, expected: budget.expected, actual: files.length });
    failed = true;
    continue;
  }

  for (const name of files) {
    const content = readFileSync(join(budget.directory, name));
    const raw = content.byteLength;
    const gzip = gzipSync(content, { level: 9 }).byteLength;
    console.log(`${budget.label}: ${name} ${format(raw)} raw / ${format(gzip)} gzip`);
    records.push({ label: budget.label, file: name, sha256: sha256(content), raw, gzip,
      maxRaw: budget.raw, maxGzip: budget.gzip });
    if (raw > budget.raw || gzip > budget.gzip) {
      console.error(
        `${budget.label}: budget exceeded (max ${format(budget.raw)} raw / ${format(budget.gzip)} gzip)`,
      );
      failures.push({ code: "chunk-budget", label: budget.label, file: name, raw, gzip });
      failed = true;
    }
  }
}

const rasterBudget = 230_000;
const rasters = rasterAssets(join(ROOT, "docs/assets"))
  .map((path) => ({ path, size: statSync(path).size }))
  .sort((a, b) => b.size - a.size);
const largestRaster = rasters[0];
console.log(`largest source raster: ${largestRaster.path.replace(`${ROOT}/`, "")} ${format(largestRaster.size)}`);
for (const { path, size } of rasters.filter(({ size }) => size > rasterBudget)) {
  console.error(
    `source raster budget exceeded: ${path.replace(`${ROOT}/`, "")} ${format(size)} (max ${format(rasterBudget)})`,
  );
  failures.push({ code: "raster-budget", path: path.replace(`${ROOT}/`, ""), size });
  failed = true;
}

if (values["json-out"]) {
  const git = args => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
  const report = {
    reportVersion: 1,
    scope: "Built chunk and source raster size budgets; does not measure load or interaction latency.",
    passed: !failed,
    failures,
    identity: {
      revision: git(["rev-parse", "HEAD"]),
      dirty: git(["status", "--porcelain"]).length > 0,
      nodeVersion: process.version,
      lockfileSha256: sha256(readFileSync(join(ROOT, "package-lock.json"))),
      checkerSha256: sha256(readFileSync(fileURLToPath(import.meta.url))),
    },
    chunks: records,
    rasters: rasters.map(({ path, size }) => ({
      path: path.replace(`${ROOT}/`, ""), size, maxBytes: rasterBudget,
      sha256: sha256(readFileSync(path)),
    })),
  };
  writeFileSync(resolve(ROOT, values["json-out"]), `${JSON.stringify(report, null, 2)}\n`);
}
if (failed) process.exit(1);
console.log("build size budgets passed");
