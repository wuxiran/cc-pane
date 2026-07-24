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
  // 当前存量在后续主题清欠 Part 1 中逐项迁移或确认保留；先精确冻结，不允许新增。
  "DiffView.tsx": [
    "#22c55e",
    "#ef4444",
    "rgba(34, 197, 94, 0.1)",
    "rgba(239, 68, 68, 0.1)",
    "rgba(34, 197, 94, 0.3)",
    "rgba(239, 68, 68, 0.3)",
  ],
  "OnboardingGuide.tsx": ["#22c55e", "#ef4444"],
  "PopupTerminalWindow.tsx": ["#ef4444", "#1a1a1a", "#888"],
  "SessionCleanerPanel.tsx": [
    "hsl(142 76% 36% / 0.1)",
    "hsl(0 84% 60% / 0.1)",
    "hsl(142 76% 36%)",
    "hsl(0 84% 60%)",
  ],
  "StatusIndicator.tsx": [
    "#8e8e93",
    "#30d158",
    "#0a84ff",
    "#ffd60a",
    "#ff453a",
    "#48484a",
    "#6e6e73",
  ],
  "editor/ImagePreview.tsx": ["#e0e0e0", "#ffffff"],
  "editor/JsonEditor.tsx": ["#22863a", "#005cc5", "#d73a49", "#6f42c1", "#e36209", "#586069"],
  // 文件类型图标品牌色与语言类别编码，不随应用主题变化。
  "filetree/FileTreeNode.tsx": [
    "text-[#CE412B]",
    "#F7DF1E",
    "#323330",
    "#3178C6",
    "#fff",
    "#3572A5",
    "#FFD43B",
    "#41B883",
    "#34495E",
    "#264DE4",
    "#2965F1",
    "#EBEBEB",
    "#FFF",
    "#00ADD8",
    "#CE412B",
    "#E44D26",
    "#F16529",
  ],
  "launcher/LauncherDialog.tsx": ["#e5484d"],
  "layout/MainWallpaperLayer.tsx": ["#000"],
  "localhistory/LocalHistoryPanel.tsx": ["#6366f1"],
  "localhistory/VersionListSidebar.tsx": ["#6366f1"],
  "localhistory/useLocalHistoryData.ts": [
    "#f59e0b",
    "#8b5cf6",
    "#3b82f6",
    "#10b981",
    "#ef4444",
    "#6b7280",
  ],
  "orchestration/OrchestrationOverlay.tsx": ["rgba(0, 0, 0, 0.42)"],
  "panes/TabBar.tsx": ["#16a34a"],
  "panes/TabContentRenderer.tsx": [
    "#1a1a1a",
    "rgba(255,255,255,0.4)",
    "rgba(255,255,255,0.5)",
    "rgba(255,255,255,0.7)",
    "rgba(255,255,255,0.1)",
    "rgba(255,255,255,0.15)",
    "rgba(255,255,255,0.2)",
  ],
  "panes/TerminalTabContent.tsx": [
    "rgba(255,255,255,0.05)",
    "rgba(255,255,255,0.08)",
    "rgba(0,0,0,0.22)",
    "rgba(255,255,255,0.42)",
    "rgba(255,255,255,0.84)",
    "rgba(255,255,255,0.45)",
  ],
  "panes/VoiceInputButton.tsx": [
    "rgba(239,68,68,0.18)",
    "rgba(127,29,29,0.32)",
    "rgba(14,165,233,0.16)",
    "rgba(12,74,110,0.28)",
    "rgba(37,99,235,0.16)",
    "rgba(15,23,42,0.36)",
    "rgba(15,23,42,0.28)",
  ],
  // ANSI 16 色与终端核心色当前由 xterm 专用调色板管理。
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
    "rgba(0, 0, 0, 0)",
  ],
  // Provider 品牌与产品身份色，不随主题状态变化。
  "providers/ProviderAvatar.tsx": [
    "#E8590C",
    "#FF9900",
    "#4285F4",
    "#6366F1",
    "#6B7280",
    "#10A37F",
    "#F97316",
    "#2563EB",
    "#8B5CF6",
    "#111827",
    "#71767B",
    "#fff",
  ],
  "providers/ProviderCard.tsx": ["#6B7280"],
  "resources/ImportConfirmDialog.tsx": ["#E8590C", "#8B5CF6", "#0EA5E9", "rgba(0,0,0,0.5)"],
  "settings/ProxySection.tsx": ["#92700c", "#fef9c3", "#fde047"],
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
});
