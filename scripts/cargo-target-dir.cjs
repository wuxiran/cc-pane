// 解析 cargo 的真实 target 目录。
//
// 背景：`.cargo/config.toml` 把 `target-dir` 指到了仓库外（`../cc-book-target`），
// 因为产物留在仓库内会被 Vite watcher / git status / ripgrep 反复遍历。
// 任何脚本再写死 `"target"` 都会在这之后失效——v0.10.19 的全平台发布就是
// 因为 `copy-hook.cjs` 写死 `target/` 而连续失败。
//
// 解析优先级与 cargo 自身一致：
//   1. `cargo metadata` 的 target_directory（权威；处理 config 继承、~/.cargo/config.toml 等）
//   2. `CARGO_TARGET_DIR` 环境变量
//   3. `.cargo/config.toml` 的 `[build] target-dir`
//   4. 回落 `target`
//
// 之所以留 2-4 的兜底：`cargo metadata` 需要能跑通 cargo（离线/无 toolchain 的
// 精简环境可能失败），此时不应让整个构建脚本崩掉。

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

function fromCargoMetadata() {
  // 显式带 .exe 而非用 shell:true——后者在 Node 22+ 会触发 DEP0190 告警，
  // 且 spawn 不走 shell 时不会应用 PATHEXT，找不到裸 `cargo`。
  const bin = process.platform === "win32" ? "cargo.exe" : "cargo";
  const result = spawnSync(
    bin,
    ["metadata", "--format-version", "1", "--no-deps"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  );
  if (result.status !== 0 || !result.stdout) return undefined;
  try {
    const dir = JSON.parse(result.stdout).target_directory;
    return typeof dir === "string" && dir ? dir : undefined;
  } catch {
    return undefined;
  }
}

function fromCargoConfig() {
  const configPath = path.join(".cargo", "config.toml");
  if (!fs.existsSync(configPath)) return undefined;
  // 只需匹配 `target-dir = "..."`，不引入 TOML 解析依赖。
  const match = fs
    .readFileSync(configPath, "utf8")
    .match(/^\s*target-dir\s*=\s*"([^"]+)"/m);
  return match ? match[1] : undefined;
}

let cached;

/** 返回 cargo target 目录（可能是相对路径，调用方按需 path.resolve）。 */
function cargoTargetDir() {
  if (cached !== undefined) return cached;
  cached =
    fromCargoMetadata() ||
    process.env.CARGO_TARGET_DIR ||
    fromCargoConfig() ||
    "target";
  return cached;
}

module.exports = { cargoTargetDir };
