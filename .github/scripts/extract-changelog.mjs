#!/usr/bin/env node
// 从 CHANGELOG.zh-CN.md 切出指定版本的段落，正文写到 stdout（不含 "## <版本>" 标题行本身）。
//
//   node .github/scripts/extract-changelog.mjs 0.12.6 [changelog 路径]
//
// 两处用它：release.yml 的 validate-version 拿它当发版前校验（丢弃输出，只看退出码），
// publish-updater-json 拿它的输出注入 Release 说明与 latest.json 的 notes。
//
// 找不到版本、或段落是空的，一律非零退出。中英两份 changelog 是人工同步的，最容易
// 踩的就是只更新了英文版——宁可让 job 红在构建之前，也不要静默发一份空说明出去。

import fs from "node:fs";

const [, , version, pathArg] = process.argv;
const changelogPath = pathArg ?? "CHANGELOG.zh-CN.md";

if (!version) {
  console.error("usage: extract-changelog.mjs <version> [changelog-path]");
  process.exit(2);
}

let text;
try {
  text = fs.readFileSync(changelogPath, "utf8");
} catch (err) {
  console.error(`::error::无法读取 ${changelogPath}: ${err.message}`);
  process.exit(1);
}

// 版本号里有 `.`，还可能有 `-`（0.12.0-beta.1），不转义的话 `.` 会当成任意字符，
// 让 0.12.6 误命中 "0x12y6" 这类标题。
const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// 标题形如 `## 0.12.6 - 2026-08-22`，也接受不带日期的 `## 0.12.6`。
// `^##\s` 不会误吞 `### 新增`——那儿第三个字符是 `#` 而非空白。
const headingRe = new RegExp(`^##\\s+v?${escaped}(\\s|$)`);

const lines = text.split("\n");
const start = lines.findIndex((line) => headingRe.test(line));
if (start === -1) {
  console.error(
    `::error::${changelogPath} 里没有 ${version} 的条目。发版前请补上中文条目（英文版在 CHANGELOG.md）。`,
  );
  process.exit(1);
}

let end = lines.length;
for (let i = start + 1; i < lines.length; i += 1) {
  if (/^##\s/.test(lines[i])) {
    end = i;
    break;
  }
}

const body = lines.slice(start + 1, end).join("\n").trim();
if (!body) {
  console.error(`::error::${changelogPath} 里 ${version} 的条目是空的。`);
  process.exit(1);
}

process.stdout.write(`${body}\n`);
