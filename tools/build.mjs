/**
 * 把平台无关的 core.js 内联进各平台入口，生成可直接粘贴到控制台的单文件 dist。
 * 用法：node tools/build.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = path.join(root, "src");
const dist = path.join(root, "dist");

const coreRaw = fs.readFileSync(path.join(src, "core.js"), "utf8");
const coreInlined = coreRaw
  .replace("export function createHandler", "function createHandler")
  .replace(/export \{ createHandler \};?\s*/g, "");

const targets = [
  ["aliyun-esa/entry.js", "aliyun-esa.js"],
  ["cloudflare-worker/entry.js", "cloudflare-worker.js"],
  ["edgeone-edge-function/entry.js", "edgeone-edge-function.js"],
  ["cloudflare-pages/functions/[[catchall]].js", "cloudflare-pages-function.js"],
  ["edgeone-pages/edge-functions/[[default]].js", "edgeone-pages-function.js"],
];

fs.mkdirSync(dist, { recursive: true });

for (const [entryRel, outName] of targets) {
  const entry = fs.readFileSync(path.join(src, entryRel), "utf8");
  const entryBody = entry
    .split("\n")
    .filter((line) => !/^\s*import\s+\{ createHandler \}/.test(line))
    .join("\n");
  const banner = `/**\n * 由 tools/build.mjs 自动生成，请勿手改；源码见 src/ 目录。\n * 目标平台：${outName.replace(".js", "")}\n */\n`;
  const out = banner + coreInlined + "\n" + entryBody.trimStart() + "\n";
  fs.writeFileSync(path.join(dist, outName), out, "utf8");
  console.log("built", outName, out.length, "bytes");
}
