/**
 * UI 密度 token 守护测试
 * ======================
 * 参照 colorGuard.test.ts 的块提取方式，守护 index.css 里的密度 token 契约：
 *   1. :root 必须定义四个 --density-* token（comfortable 默认值，与现状像素一致）；
 *   2. :root[data-density="compact"] 块必须存在且覆盖同一组 token；
 *   3. compact 取值必须符合收紧方向（行高下降、间距/内边距下降）；
 *   4. 密度与颜色正交：.dark 与各 [data-theme] 块不得重复定义 --density-* token
 *      （colorGuard 的六块同步规则只管 --app-* 颜色 token，密度 token 若渗进主题块
 *      会造成同一主题下密度被静默锁定）。
 *
 * 与 colorGuard 一样经 node:fs 读原文件（index.css 走 Tailwind 管线，?raw 导入拿到空串）。
 * 前端 tsconfig 刻意不引入 @types/node，这里用 vi.importActual + 调用方给类型，
 * 避免静态 import node:fs 的类型解析（也不需要 @ts-expect-error 或全局 .d.ts）。
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

let indexCss = "";

beforeAll(async () => {
  const fs = await vi.importActual<{
    readFileSync(path: string, encoding: "utf8"): string;
  }>("node:fs");
  indexCss = fs.readFileSync("web/assets/index.css", "utf8");
});

const DENSITY_TOKENS = [
  "--density-row-h",
  "--density-gap",
  "--density-pad-x",
  "--density-pad-y",
] as const;

/** 与 colorGuard.themeBlock 同口径：提取 selector 首个块的 {} 内容。 */
function themeBlock(source: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\n)\\s*${escapedSelector}\\s*\\{`).exec(source);
  if (!match) {
    throw new Error(`index.css 缺少 ${selector} 作用域`);
  }
  const open = source.indexOf("{", match.index);
  let depth = 1;
  for (let index = open + 1; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(open + 1, index);
  }
  throw new Error(`index.css 中 ${selector} 作用域未闭合`);
}

function tokenValue(block: string, token: string): string | null {
  const match = new RegExp(`${token.replace(/-/g, "\\-")}\\s*:\\s*([^;]+);`).exec(block);
  return match ? match[1].trim() : null;
}

function pxValue(block: string, token: string): number {
  const raw = tokenValue(block, token);
  if (raw === null) throw new Error(`块内缺少 ${token}`);
  const match = /^(-?\d+(?:\.\d+)?)px$/.exec(raw);
  if (!match) throw new Error(`${token} 应为 px 值，实际为 ${JSON.stringify(raw)}`);
  return Number(match[1]);
}

describe("density tokens", () => {
  it("成功加载 index.css", () => {
    expect(typeof indexCss).toBe("string");
    expect(indexCss.length).toBeGreaterThan(0);
  });

  it(":root 定义全部四个密度 token（comfortable 默认值）", () => {
    const root = themeBlock(indexCss, ":root");
    for (const token of DENSITY_TOKENS) {
      expect(tokenValue(root, token), `:root 缺少 ${token}`).not.toBeNull();
    }
    // comfortable 默认值锁定为现状像素：行高 28（StatusBar 原 h-[28px]）、
    // 间距/水平内边距 8（gap-2/px-2）、垂直内边距 6（py-1.5）。
    expect(pxValue(root, "--density-row-h")).toBe(28);
    expect(pxValue(root, "--density-gap")).toBe(8);
    expect(pxValue(root, "--density-pad-x")).toBe(8);
    expect(pxValue(root, "--density-pad-y")).toBe(6);
  });

  it(":root[data-density=\"compact\"] 覆盖同一组 token 且全面收紧", () => {
    const root = themeBlock(indexCss, ":root");
    const compact = themeBlock(indexCss, ':root[data-density="compact"]');
    for (const token of DENSITY_TOKENS) {
      const comfortable = pxValue(root, token);
      const tight = pxValue(compact, token);
      expect(tight, `${token} compact 值应小于 comfortable 值`).toBeLessThan(comfortable);
    }
    // 行高收紧 4px（28→24），间距与水平内边距收紧 25%（8→6），垂直内边距 6→4。
    expect(pxValue(compact, "--density-row-h")).toBe(24);
    expect(pxValue(compact, "--density-gap")).toBe(6);
    expect(pxValue(compact, "--density-pad-x")).toBe(6);
    expect(pxValue(compact, "--density-pad-y")).toBe(4);
  });

  it("密度 token 不渗入 .dark 与 [data-theme] 主题块（与颜色正交）", () => {
    const scopes = [
      ".dark",
      ...[...indexCss.matchAll(/:root\[data-theme="([a-z0-9-]+)"\]\s*\{/gi)]
        .map((match) => `:root[data-theme="${match[1]}"]`),
    ];
    expect(scopes.length).toBeGreaterThan(1);

    for (const scope of scopes) {
      const block = themeBlock(indexCss, scope);
      for (const token of DENSITY_TOKENS) {
        expect(
          tokenValue(block, token),
          `${scope} 不应定义 ${token}（密度由 :root 与 [data-density] 负责）`,
        ).toBeNull();
      }
    }
  });
});
