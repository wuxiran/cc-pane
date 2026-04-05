import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const safeTargets = [
  "dist",
  "target",
  "coverage",
  "node_modules",
  "src-tauri/gen",
  "src-tauri/binaries",
  ".playwright-mcp",
  "tsconfig.node.tsbuildinfo",
  "tsconfig.tsbuildinfo",
];

for (const relativeTarget of safeTargets) {
  rmSync(path.join(repoRoot, relativeTarget), { force: true, recursive: true });
  console.log(`removed ${relativeTarget}`);
}
