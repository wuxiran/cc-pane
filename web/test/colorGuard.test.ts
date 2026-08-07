/**
 * 补齐 designTokens.test.ts 未覆盖的任意值色和直接色值。ui/ 是 shadcn 基件、mobile/
 * 是独立移动端原型、dev/ 是渲染诊断工具，三者不受应用主题 token 约束。
 */
import { describe, expect, it } from "vitest";

// @ts-expect-error 测试运行在 Node；前端 tsconfig 刻意不引入 @types/node。
import { readFileSync } from "node:fs";

const ARBITRARY_COLOR_RE = /[a-z:]+-\[(?:#|rgba?\(|hsla?\(|oklch\()[^\]]+\]/gi;
const DIRECT_COLOR_RE =
  /(?<!&)#[0-9a-fA-F]{3,8}\b|(?:rgba?|hsla?|oklch)\((?!var\()[^\n)]*\)/g;
const EXEMPT_DIRS = new Set(["dev", "mobile", "ui"]);

const ALLOWLIST: Record<string, string[]> = {
  // 编辑器语法高亮属于内容类别编码，不随应用 chrome 主题色变化。
  "editor/JsonEditor.tsx": ["#22863a", "#005cc5", "#d73a49", "#6f42c1", "#e36209", "#586069"],
  // 壁纸 dim 层必须使用中性黑混合，避免随主题产生彩色遮罩。
  "layout/MainWallpaperLayer.tsx": ["#000"],
  "settings/WallpaperPreview.tsx": ["#000"],
  // Local History 标签来源色区分 git/会话/用户/构建/恢复，属于类别编码。
  "localhistory/useLocalHistoryData.ts": [
    "#f59e0b",
    "#8b5cf6",
    "#3b82f6",
    "#10b981",
    "#ef4444",
    "#6b7280",
  ],
  // ANSI 16 色与透明背景算法由 xterm 专用调色板管理，不属于应用 chrome。
  "panes/terminalTheme.ts": [
    "#17191E",
    "#f5f5f7",
    "#0a84ff",
    "rgba(10, 132, 255, 0.3)",
    "#ff453a",
    "#30d158",
    "#ffd60a",
    "#bf5af2",
    "#64d2ff",
    "#6e6e73",
    "#ff6961",
    "#4ae08a",
    "#ffe620",
    "#409cff",
    "#da8aff",
    "#70d7ff",
    "#ffffff",
    "#000000",
    "#919191",
    "rgba(178, 212, 255, 0.8)",
    "#c33720",
    "#32be28",
    "#afaf23",
    "#5230e1",
    "#d73cd2",
    "#32bac8",
    "#cccccc",
    "#828282",
    "#ff3c1e",
    "#2fe721",
    "#ebec15",
    "#5e34ff",
    "#fe3cff",
    "#28f0f0",
    "#ebebeb",
    "rgba(${r}, ${g}, ${b}, ${alpha})",
    "rgba(${match[1]}, ${match[2]}, ${match[3]}, 0)",
    "rgba(0, 0, 0, 0)",
  ],
  // 品牌身份色已迁到 --app-identity-provider-*；只剩头像字色（底色恒为深色品牌色）。
  "providers/ProviderAvatar.tsx": ["#fff"],
  "providers/ProviderCard.tsx": ["#6B7280"],
  // 导入类型使用 Provider/Skill/MCP 类别色；背板黑色仅用于模态 dim。
  "resources/ImportConfirmDialog.tsx": ["#E8590C", "#8B5CF6", "#0EA5E9", "rgba(0,0,0,0.5)"],
};

const RAW_MODULES = import.meta.glob("../components/**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;
const indexCss = readFileSync("web/assets/index.css", "utf8");

function relativePath(key: string): string {
  return key.replace(/^\.\.\/components\//, "");
}

function isScannedFile(path: string): boolean {
  if (/\.test\./.test(path)) return false;
  const top = path.split("/")[0];
  return !EXEMPT_DIRS.has(top);
}

function stripComments(content: string): string {
  return content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function findColorFragments(content: string): string[] {
  const source = stripComments(content);
  return [...(source.match(ARBITRARY_COLOR_RE) ?? []), ...(source.match(DIRECT_COLOR_RE) ?? [])];
}

function themeBlock(source: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\n)\\s*${escapedSelector}\\s*\\{`).exec(source);
  if (!match) {
    throw new Error(
      `index.css 缺少 ${selector} 主题作用域（长度 ${source.length}，开头 ${JSON.stringify(source.slice(0, 80))}）`,
    );
  }
  const open = source.indexOf("{", match.index);
  let depth = 1;
  for (let index = open + 1; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(open + 1, index);
  }
  throw new Error(`index.css 中 ${selector} 主题作用域未闭合`);
}

function appTokens(block: string): Set<string> {
  return new Set([...block.matchAll(/(--app-[a-z0-9-]+)\s*:/gi)].map((match) => match[1]));
}

function difference(left: Set<string>, right: Set<string>): string[] {
  return [...left].filter((token) => !right.has(token)).sort();
}

describe("direct color guard", () => {
  const entries = Object.entries(RAW_MODULES)
    .map(([key, content]) => [relativePath(key), content] as const)
    .filter(([path]) => isScannedFile(path));

  it("除精确 allowlist 外无任意值色或直接色值", () => {
    const violations: string[] = [];
    const seen: Record<string, Set<string>> = {};
    for (const path of Object.keys(ALLOWLIST)) seen[path] = new Set();

    for (const [path, content] of entries) {
      const allowed = new Set(ALLOWLIST[path] ?? []);
      for (const fragment of findColorFragments(content)) {
        if (allowed.has(fragment)) {
          seen[path]?.add(fragment);
        } else {
          violations.push(`${path}: ${fragment}`);
        }
      }
    }

    const stale: string[] = [];
    for (const [path, fragments] of Object.entries(ALLOWLIST)) {
      for (const fragment of fragments) {
        if (!seen[path]?.has(fragment)) stale.push(`${path}: ${fragment}`);
      }
    }

    expect(violations, `未登记的直接色值：\n${violations.join("\n")}`).toEqual([]);
    expect(stale, `allowlist 中已失效的条目（请删除）：\n${stale.join("\n")}`).toEqual([]);
  });

  it(":root 与 .dark 的 --app-* token 清单全等", () => {
    const light = appTokens(themeBlock(indexCss, ":root"));
    const dark = appTokens(themeBlock(indexCss, ".dark"));
    const missingInDark = difference(light, dark);
    const missingInLight = difference(dark, light);

    expect(
      [...missingInDark, ...missingInLight],
      [
        `dark 缺少：${missingInDark.join(", ") || "无"}`,
        `light 缺少：${missingInLight.join(", ") || "无"}`,
      ].join("\n"),
    ).toEqual([]);
  });

  // 主题预设块只覆盖 :root/.dark 的一个子集，其余 token 靠继承取值（暗色主题同时挂
  // .dark class，继承到的是暗色值）。护栏管两件事：①不许出现 :root 里没有的野 token
  // （拼错的 key 只会静默不生效）；②四个主题块必须覆盖同一套 token，否则某个主题少定义
  // 一个键就会静默漂移成别的主题的颜色，肉眼要逐主题切才看得出来。
  it("每个 [data-theme] 主题块的 --app-* 集合一致且是 :root 的子集", () => {
    const rootTokens = appTokens(themeBlock(indexCss, ":root"));
    const themeNames = [...indexCss.matchAll(/:root\[data-theme="([a-z0-9-]+)"\]\s*\{/gi)]
      .map((match) => match[1]);
    expect(themeNames.length, "index.css 里应至少有一个 [data-theme] 主题块").toBeGreaterThan(0);

    const perTheme = themeNames.map((name) => ({
      name,
      tokens: appTokens(themeBlock(indexCss, `:root[data-theme="${name}"]`)),
    }));

    const unknown = perTheme.flatMap(({ name, tokens }) =>
      difference(tokens, rootTokens).map((token) => `${name}: ${token}`),
    );
    expect(unknown, `主题块里存在 :root 未定义的 token：\n${unknown.join("\n")}`).toEqual([]);

    const [first, ...rest] = perTheme;
    const drift = rest.flatMap(({ name, tokens }) => [
      ...difference(first.tokens, tokens).map((token) => `${name} 缺少 ${token}`),
      ...difference(tokens, first.tokens).map((token) => `${name} 多出 ${token}`),
    ]);
    expect(drift, `主题块之间 token 覆盖面不一致：\n${drift.join("\n")}`).toEqual([]);
  });

  it("原生表单控件应随主题使用对应的 color-scheme", () => {
    expect(themeBlock(indexCss, ":root")).toMatch(/color-scheme:\s*light\s*;/);
    expect(themeBlock(indexCss, ".dark")).toMatch(/color-scheme:\s*dark\s*;/);
  });
});
