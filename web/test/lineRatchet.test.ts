import { describe, expect, it } from "vitest";

import baseline from "./lineRatchet.baseline.json";

const MAX_NEW_FILE_LINES = 500;

const RAW_MODULES = import.meta.glob("../**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

function relativePath(key: string): string {
  return key.replace(/^\.\.\//, "");
}

function isScannedFile(path: string): boolean {
  return (
    !/\.test\./.test(path) &&
    !path.startsWith("test/") &&
    !path.startsWith("components/ui/")
  );
}

function countLines(content: string): number {
  if (content.length === 0) return 0;
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.length;
}

describe("source file line-count ratchet", () => {
  const entries = Object.entries(RAW_MODULES)
    .map(([key, content]) => [relativePath(key), content] as const)
    .filter(([path]) => isScannedFile(path));

  it("扫描到前端源码", () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  it("存量大文件只减不增，新文件不超过 500 行", () => {
    const violations: string[] = [];

    for (const [path, content] of entries) {
      const actual = countLines(content);
      const limit = baseline[path as keyof typeof baseline] ?? MAX_NEW_FILE_LINES;
      if (actual > limit) {
        violations.push(
          `${path}: 现值 ${actual} 行，基线 ${limit} 行。` +
            "请拆分该文件或（仅重构豁免时）经评审更新基线；文件缩短后请同步下调基线。",
        );
      }
    }

    expect(violations, violations.join("\n")).toEqual([]);
  });
});
