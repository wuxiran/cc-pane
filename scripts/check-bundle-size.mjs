/**
 * Bundle 预算检查（`npm run check:bundle`，需先 `npm run build`）。
 *
 * 首屏成本定义：dist/index.html 里 `<script type="module">` 入口 + 所有
 * `modulepreload` chunk —— 它们是启动时同步下载、求值的 JS。动态 import 的
 * chunk（monaco / mermaid / codemirror / recharts 所在）不算首屏。
 *
 * 预算基线（2026-09 实测）：
 *   改造前首屏 JS gzip ≈ 1914 kB（main 849 + monaco 946 + xterm 83 + radix 35），
 *   其中 monaco-editor chunk 被 main.tsx 静态引用、随首屏强制下载。
 *   monaco 懒加载后首屏 JS gzip ≈ 941 kB（main 792 + xterm 123 + radix 26）。
 *   xterm 懒加载后首屏 JS gzip ≈ 831 kB（main 805 + radix 26），累计降 ~57%：
 *   @xterm/* 只经 panes/terminal/terminalXtermModules.ts 动态 import，
 *   xterm chunk 不再出现在 index.html modulepreload。
 * 预算取值：
 *   首屏总量 ≤ 1100 kB gzip（实测 831 + ~32% 余量，防自然增长，远低于旧基线）；
 *   入口 chunk ≤ 880 kB gzip（实测 805 + ~9% 余量，单独钉住防止 main 重新膨胀）；
 *   重依赖 chunk（monaco/mermaid/codemirror/recharts/xterm）不得出现在首屏静态图。
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { gzipSync } from "node:zlib";

const INITIAL_JS_GZIP_BUDGET_KB = 1100;
const ENTRY_CHUNK_GZIP_BUDGET_KB = 880;
const HEAVY_CHUNK_PATTERN = /monaco-editor|mermaid|codemirror|recharts|JsonEditor|HomeUsageStats|xterm/i;

const distDir = new URL("../dist/", import.meta.url);
const assetsDir = new URL("../dist/assets/", import.meta.url);
const indexPath = new URL("../dist/index.html", import.meta.url);

if (!existsSync(indexPath)) {
  console.error("[check-bundle] dist/index.html 不存在，请先运行 npm run build");
  process.exit(1);
}

const html = readFileSync(indexPath, "utf8");
const assetFiles = new Set(readdirSync(assetsDir));

function resolveAsset(href) {
  const file = href.replace(/^\//, "").replace(/^assets\//, "");
  if (!assetFiles.has(file)) throw new Error(`index.html 引用了不存在的产物: ${href}`);
  return file;
}

function gzipKb(file) {
  const content = readFileSync(new URL(file, assetsDir));
  return gzipSync(content).length / 1024;
}

const entryMatch = html.match(/<script[^>]*type="module"[^>]*src="(\/assets\/[^"]+\.js)"/);
if (!entryMatch) throw new Error("index.html 里找不到入口 <script type=\"module\">");
const preloadHrefs = [...html.matchAll(/<link[^>]*rel="modulepreload"[^>]*href="(\/assets\/[^"]+\.js)"/g)]
  .map((match) => match[1]);

const entryFile = resolveAsset(entryMatch[1]);
const preloadFiles = preloadHrefs.map(resolveAsset);
// 去重：vite 偶尔会把入口本身也写成 modulepreload。
const initialFiles = [...new Set([entryFile, ...preloadFiles])];

const failures = [];

// 1. 重依赖 chunk 不得进入首屏静态图（modulepreload 或入口脚本本身）。
const heavyInInitial = initialFiles.filter((file) => HEAVY_CHUNK_PATTERN.test(file));
if (heavyInInitial.length > 0) {
  failures.push(`重依赖 chunk 进入首屏静态图: ${heavyInInitial.join(", ")}`);
}

// 2. 入口 chunk 源码里不得静态 import 重依赖 chunk（动态 import 允许）。
// Rollup 产物里静态导入形如 `import"./x.js"` / `}from"./x.js"`；
// 动态导入是 `import("./x.js")`，下面的 `[^()";]*` 段会把带括号的形式排除掉。
const entrySource = readFileSync(new URL(entryFile, assetsDir), "utf8");
const staticImportRe = new RegExp(
  `(?:import|export)[^()";]*from"\\./[^"]*(?:${HEAVY_CHUNK_PATTERN.source})[^"]*"|import"\\./[^"]*(?:${HEAVY_CHUNK_PATTERN.source})[^"]*"`,
  "i",
);
if (staticImportRe.test(entrySource)) {
  failures.push(`入口 chunk ${entryFile} 静态引用了重依赖 chunk（应改为动态 import）`);
}

// 3. 体积预算。
const entryKb = gzipKb(entryFile);
const totalKb = initialFiles.reduce((sum, file) => sum + gzipKb(file), 0);

console.log("[check-bundle] 首屏静态 JS（index.html script + modulepreload）:");
for (const file of initialFiles) {
  console.log(`  ${file}  gzip ${gzipKb(file).toFixed(1)} kB`);
}
console.log(`[check-bundle] 入口 chunk: ${entryKb.toFixed(1)} kB gzip (预算 ≤ ${ENTRY_CHUNK_GZIP_BUDGET_KB} kB)`);
console.log(`[check-bundle] 首屏合计: ${totalKb.toFixed(1)} kB gzip (预算 ≤ ${INITIAL_JS_GZIP_BUDGET_KB} kB)`);

if (entryKb > ENTRY_CHUNK_GZIP_BUDGET_KB) {
  failures.push(`入口 chunk 超预算: ${entryKb.toFixed(1)} > ${ENTRY_CHUNK_GZIP_BUDGET_KB} kB gzip`);
}
if (totalKb > INITIAL_JS_GZIP_BUDGET_KB) {
  failures.push(`首屏 JS 总量超预算: ${totalKb.toFixed(1)} > ${INITIAL_JS_GZIP_BUDGET_KB} kB gzip`);
}

// 4. 重依赖 chunk 必须真实存在且独立分包（防止「解决方式」是把懒加载删掉）。
const distFiles = [...assetFiles];
for (const expected of [/monaco-editor-[\w-]+\.js$/, /mermaid\.core-[\w-]+\.js$/, /xterm-[\w-]+\.js$/]) {
  if (!distFiles.some((file) => expected.test(file))) {
    failures.push(`dist 里缺少独立的重依赖 chunk: ${expected}`);
  }
}

if (failures.length > 0) {
  console.error("\n[check-bundle] 失败:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log("[check-bundle] 通过");
