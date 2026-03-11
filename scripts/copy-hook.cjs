const fs = require("fs");
const path = require("path");

// 1. 复制 hook.exe 到 src-tauri/binaries/
const d = path.join("src-tauri", "binaries");
fs.mkdirSync(d, { recursive: true });
fs.copyFileSync(
  path.join("target", "release", "cc-panes-hook.exe"),
  path.join(d, "cc-panes-hook.exe")
);

// 2. 复制 .claude/ skills 和 agents 到 src-tauri/bundled-claude-config/
const srcClaude = ".claude";
const destBase = path.join("src-tauri", "bundled-claude-config");

// 复制 commands/ccbook/
const commandsSrc = path.join(srcClaude, "commands", "ccbook");
const commandsDest = path.join(destBase, ".claude", "commands", "ccbook");
fs.mkdirSync(commandsDest, { recursive: true });
for (const f of fs.readdirSync(commandsSrc).filter(f => f.endsWith(".md"))) {
  fs.copyFileSync(path.join(commandsSrc, f), path.join(commandsDest, f));
}
console.log(`Copied commands/ccbook/ (${fs.readdirSync(commandsDest).length} files)`);

// 复制 agents/
const agentsSrc = path.join(srcClaude, "agents");
const agentsDest = path.join(destBase, ".claude", "agents");
fs.mkdirSync(agentsDest, { recursive: true });
for (const f of fs.readdirSync(agentsSrc).filter(f => f.endsWith(".md"))) {
  fs.copyFileSync(path.join(agentsSrc, f), path.join(agentsDest, f));
}
console.log(`Copied agents/ (${fs.readdirSync(agentsDest).length} files)`);

// 复制项目 CLAUDE.md
fs.copyFileSync("CLAUDE.md", path.join(destBase, "CLAUDE.md"));
console.log("Copied CLAUDE.md");
