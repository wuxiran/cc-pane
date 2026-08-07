// 每个 build 矩阵 job 在 tauri-action 之后运行：扫描本 job 的 bundle 产物里
// 带 .sig 伴生文件的 updater 工件，拷到 updater-upload/（最终资产名），并把
// {platformKey, suffix, asset, signature} 写进 updater-metadata/<key>.json。
// latest.json 由 publish-updater-json job 串行聚合——绝不允许各 job 并行写
// （v0.12.1 实测五 job 并行 read-modify-write 互相覆盖，线上清单只剩 2 平台）。
//
// env: PLATFORM_KEY, VERSION, CARGO_TARGET_DIR, RUST_TARGET(可空)
import fs from "node:fs";
import path from "node:path";

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`missing env ${name}`);
    process.exit(1);
  }
  return value;
}

const platformKey = required("PLATFORM_KEY");
const version = required("VERSION");
const targetDir = required("CARGO_TARGET_DIR");
const rustTarget = process.env.RUST_TARGET || "";

const bundleRoots = [path.join(targetDir, "release", "bundle")];
if (rustTarget) {
  bundleRoots.push(path.join(targetDir, rustTarget, "release", "bundle"));
}

const sigFiles = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else if (entry.isFile() && entry.name.endsWith(".sig")) sigFiles.push(p);
  }
}
for (const root of bundleRoots) {
  if (fs.existsSync(root)) walk(root);
}

// 后缀 = tauri-action 平台 key 的 bundle 变体（windows-x86_64-nsis 这种），
// 与线上历史 latest.json 的 key 形态对齐。
function suffixOf(name) {
  if (name.endsWith(".AppImage")) return "appimage";
  if (name.endsWith(".deb")) return "deb";
  if (name.endsWith(".rpm")) return "rpm";
  if (name.endsWith("-setup.exe") || name.endsWith(".nsis.zip")) return "nsis";
  if (name.endsWith(".msi") || name.endsWith(".msi.zip")) return "msi";
  if (name.endsWith(".app.tar.gz")) return "app";
  return null;
}

const uploadDir = "updater-upload";
const metadataDir = "updater-metadata";
fs.mkdirSync(uploadDir, { recursive: true });
fs.mkdirSync(metadataDir, { recursive: true });

const entries = [];
for (const sig of sigFiles) {
  const artifact = sig.slice(0, -".sig".length);
  if (!fs.existsSync(artifact)) continue;
  const name = path.basename(artifact);
  const suffix = suffixOf(name);
  if (!suffix) {
    console.warn(`skip unrecognized updater artifact: ${name}`);
    continue;
  }
  // macOS 的 .app.tar.gz 不带架构名，arm64/x86_64 两个 job 会同名互撞
  // （v0.9.40 backfill 时已踩过）——按架构重命名后再上传。
  let assetName = name;
  if (suffix === "app") {
    const arch = platformKey === "darwin-aarch64" ? "aarch64" : "x64";
    assetName = `cc-panes_${version}_${arch}.app.tar.gz`;
  }
  fs.copyFileSync(artifact, path.join(uploadDir, assetName));
  fs.copyFileSync(sig, path.join(uploadDir, `${assetName}.sig`));
  entries.push({
    platformKey,
    suffix,
    asset: assetName,
    signature: fs.readFileSync(sig, "utf8").trim(),
  });
}

if (entries.length === 0) {
  console.error(`no updater artifacts (*.sig siblings) found under: ${bundleRoots.join(", ")}`);
  process.exit(1);
}

fs.writeFileSync(
  path.join(metadataDir, `${platformKey}.json`),
  `${JSON.stringify(entries, null, 2)}\n`,
);
console.log(
  `collected ${entries.length} updater artifact(s): ` +
    entries.map((e) => `${e.platformKey}-${e.suffix} -> ${e.asset}`).join(", "),
);
