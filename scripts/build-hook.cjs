const { spawnSync } = require("child_process");

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

const args = ["build", "-p", "cc-panes-cli-hook"];
if (profile === "release") {
  args.push("--release");
}
if (targetTriple) {
  args.push("--target", targetTriple);
}

console.log(`[build-hook] cargo ${args.join(" ")}`);

const result = spawnSync("cargo", args, {
  stdio: "inherit",
  shell: process.platform === "win32",
  env: process.env,
});

if (result.error) {
  console.error(`[build-hook] failed: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
