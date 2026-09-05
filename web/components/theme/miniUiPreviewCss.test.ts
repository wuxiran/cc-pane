// @ts-expect-error Tests run in Node; the frontend tsconfig intentionally omits @types/node.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { THEME_PRESETS } from "@/theme/themePresets";
import { THEME_SHAPE_CODES } from "@/theme/themeShapes";

// 契约：miniUiPreview.css 的 .mini-ui-scope 作用域必须镜像 index.css 的
// :root / .dark / :root[data-theme] / :root[data-shape] 有效 token 值，
// 防止主题色板调整后预览与真实界面悄悄漂移。

const appCss = readFileSync("web/assets/index.css", "utf8");
const previewCss = readFileSync("web/components/theme/miniUiPreview.css", "utf8");

function blockOf(css: string, selector: string): string {
  const start = css.indexOf(selector);
  if (start < 0) return "";
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close);
}

function parseTokens(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /(--[\w-]+)\s*:\s*([^;]+);/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(block))) out[match[1]] = match[2].trim();
  return out;
}

const rootTokens = parseTokens(blockOf(appCss, ":root {"));
const darkTokens = parseTokens(blockOf(appCss, ".dark {"));

const THEME_TOKENS = [
  "--app-bg-deep",
  "--app-sidebar",
  "--app-tabbar",
  "--app-content",
  "--app-panel-bg",
  "--app-border",
  "--app-active-bg",
  "--app-accent",
  "--app-text-primary",
  "--app-text-secondary",
  "--app-text-tertiary",
  "--app-tab-highlight",
  "--app-terminal-bg",
  "--app-terminal-fg",
  "--app-status-success",
  "--primary",
  "--primary-foreground",
] as const;

const SHAPE_TOKENS = [
  "--shape-radius-sm",
  "--shape-radius-md",
  "--shape-radius-lg",
  "--shape-border-width",
  "--shape-shadow",
  "--shape-backdrop-blur",
] as const;

function expectedThemeTokens(themeId: string, group: string): Record<string, string> {
  const base = group === "dark" ? { ...rootTokens, ...darkTokens } : { ...rootTokens };
  const named = parseTokens(blockOf(appCss, `:root[data-theme="${themeId}"]`));
  return { ...base, ...named };
}

describe("miniUiPreview.css 主题作用域契约", () => {
  it.each(THEME_PRESETS.map((preset) => [preset.id, preset.group] as const))(
    ".mini-ui-scope[data-theme=%s] 与 index.css 有效值逐项一致",
    (themeId, group) => {
      const scope = parseTokens(blockOf(previewCss, `.mini-ui-scope[data-theme="${themeId}"]`));
      const expected = expectedThemeTokens(themeId, group);
      for (const token of THEME_TOKENS) {
        expect(expected[token], `index.css 缺少 ${token} 的有效值`).toBeDefined();
        expect(scope[token], `${themeId} 的 ${token} 与 index.css 不一致`).toBe(expected[token]);
      }
    },
  );

  it("每个主题作用域恰好声明契约 token，不缺不多", () => {
    for (const preset of THEME_PRESETS) {
      const scope = parseTokens(blockOf(previewCss, `.mini-ui-scope[data-theme="${preset.id}"]`));
      expect(Object.keys(scope).sort()).toEqual([...THEME_TOKENS].sort());
    }
  });
});

describe("miniUiPreview.css 形态作用域契约", () => {
  it.each(THEME_SHAPE_CODES)(".mini-ui-scope[data-shape=%s] 镜像 :root 形态块", (shape) => {
    const scope = parseTokens(blockOf(previewCss, `.mini-ui-scope[data-shape="${shape}"]`));
    const expected = parseTokens(blockOf(appCss, `:root[data-shape="${shape}"]`));
    for (const token of SHAPE_TOKENS) {
      expect(expected[token], `index.css 形态块缺少 ${token}`).toBeDefined();
      expect(scope[token], `${shape} 的 ${token} 与 index.css 不一致`).toBe(expected[token]);
    }
  });

  it("基础 .mini-ui-scope 缺省形态 = soft", () => {
    const scope = parseTokens(blockOf(previewCss, ".mini-ui-scope {"));
    const soft = parseTokens(blockOf(appCss, ':root[data-shape="soft"]'));
    for (const token of SHAPE_TOKENS) {
      expect(scope[token]).toBe(soft[token]);
    }
  });
});

describe("miniUiPreview.css 作用域卫生", () => {
  it("不碰根元素 / 全局元素，只作用于 .mini-ui-* 子树", () => {
    const stripped = previewCss.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(stripped).not.toContain(":root");
    const selectors = stripped.match(/^[ \t]*[^{}\s@;][^{\n]*\{/gm) ?? [];
    expect(selectors.length).toBeGreaterThan(0);
    for (const selector of selectors) {
      expect(selector.trim()).toMatch(/^\.mini-ui-/);
    }
  });

  it("玻璃/碳纹表面材质与主题形态块同源（color-mix + 当前主题 token）", () => {
    expect(previewCss).toContain('.mini-ui-scope[data-shape="glass"] .mini-ui-surface');
    expect(previewCss).toContain('.mini-ui-scope[data-shape="carbon"] .mini-ui-surface');
    expect(previewCss).toContain("color-mix(in srgb, var(--app-panel-bg)");
    expect(previewCss).toContain("repeating-linear-gradient");
  });
});
