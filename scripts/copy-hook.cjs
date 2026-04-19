const fs = require("fs");
const path = require("path");

function readFlagValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function resolveProfile() {
  if (process.argv.includes("--debug")) return "debug";
  if (process.argv.includes("--release")) return "release";
  return process.env.TAURI_ENV_DEBUG === "true" ? "debug" : "release";
}

const targetTriple = readFlagValue("--target") || process.env.TAURI_ENV_TARGET_TRIPLE || "";
const profile = resolveProfile();
const isWindowsTarget = targetTriple ? targetTriple.includes("windows") : process.platform === "win32";

// 1. 复制 hook 二进制到 src-tauri/binaries/（target 感知）
const d = path.join("src-tauri", "binaries");
fs.mkdirSync(d, { recursive: true });

// 清理旧文件，避免通配符误匹配
for (const f of fs.readdirSync(d).filter(f => f.startsWith("cc-panes-hook") || f.startsWith("cc-panes-cli-hook"))) {
  fs.unlinkSync(path.join(d, f));
}

const ext = isWindowsTarget ? ".exe" : "";
const binaryName = `cc-panes-cli-hook${ext}`;
const buildDir = targetTriple
  ? path.join("target", targetTriple, profile)
  : path.join("target", profile);
const sourceBinary = path.join(buildDir, binaryName);

if (!fs.existsSync(sourceBinary)) {
  throw new Error(`Hook binary not found: ${sourceBinary}`);
}

fs.copyFileSync(
  sourceBinary,
  path.join(d, binaryName)
);

console.log(`[copy-hook] copied ${sourceBinary} -> ${path.join(d, binaryName)}`);

// macOS/Linux: 确保可执行权限
if (!isWindowsTarget) {
  fs.chmodSync(path.join(d, binaryName), 0o755);
}

// 2. 复制 .claude/ skills 和 agents 到 src-tauri/resources/claude-bundle/
const srcClaude = ".claude";
const destBase = path.join("src-tauri", "resources", "claude-bundle");

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
