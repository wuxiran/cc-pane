/**
 * CJK 启发式比 JSX AST 守卫更轻量，足以冻结当前中文裸文案；英文文案由 i18n 键对等
 * 间接兜底。更精确、成本更高的 AST 版本留待 P2。
 */
import { describe, expect, it } from "vitest";

import baseline from "./noRawText.baseline.json";

const RAW_MODULES = import.meta.glob("../components/**/*.tsx", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

function relativePath(key: string): string {
  return key.replace(/^\.\.\/components\//, "");
}

function isScannedFile(path: string): boolean {
  return !/\.test\./.test(path) && !path.startsWith("ui/") && !path.startsWith("mobile/");
}

function stripComments(content: string): string {
  return content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function countCjkLines(content: string): number {
  return stripComments(content)
    .split(/\r?\n/)
    .filter((line) => /[一-鿿]/.test(line)).length;
}

describe("raw UI text ratchet", () => {
  const entries = Object.entries(RAW_MODULES)
    .map(([key, content]) => [relativePath(key), content] as const)
    .filter(([path]) => isScannedFile(path));

  it("存量中文命中只减不增", () => {
    const violations: string[] = [];
    const stale: string[] = [];

    for (const [path, content] of entries) {
      const actual = countCjkLines(content);
      const limit = baseline[path as keyof typeof baseline] ?? 0;
      if (actual > limit) {
        violations.push(`${path}: 中文命中 ${actual} 行，基线 ${limit} 行`);
      }
    }

    for (const [path, limit] of Object.entries(baseline)) {
      const actual = entries.find(([candidate]) => candidate === path);
      if (!actual || countCjkLines(actual[1]) === 0 || limit === 0) stale.push(path);
    }

    expect(violations, `新增中文裸文案嫌疑：\n${violations.join("\n")}`).toEqual([]);
    expect(stale, `基线中已归零或失效的条目（请删除）：\n${stale.join("\n")}`).toEqual([]);
  });
});
