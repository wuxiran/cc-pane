import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { THEME_PRESETS } from "@/theme/themePresets";
import { PresetSwatches, SystemThemePreview } from "./ThemeSwatches";

// jsdom 会把内联色值归一化成 rgb()，这里同时兼容 hex 原值与 rgb 形式再断言。
function usesColor(el: Element, hex: string): boolean {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  const style = (el.getAttribute("style") ?? "").toLowerCase();
  return style.includes(hex.toLowerCase()) || style.includes(`rgb(${r}, ${g}, ${b})`);
}

function expectInlineColor(el: Element, hex: string) {
  expect(usesColor(el, hex), `element style 应包含 ${hex}，实际：${el.getAttribute("style")}`).toBe(true);
}

describe("PresetSwatches card 变体（MiniUiPreview 迷你界面）", () => {
  it("十个主题都渲染 mini UI 预览：data-theme 套框、aria-hidden、aspect-video 比例", () => {
    for (const preset of THEME_PRESETS) {
      const { container, unmount } = render(<PresetSwatches preset={preset} size="card" />);
      const root = container.firstElementChild;
      expect(root).not.toBeNull();
      expect(root).toHaveAttribute("aria-hidden", "true");
      expect(root).toHaveAttribute("data-theme", preset.id);
      expect(root).toHaveClass("mini-ui-scope", "aspect-video", "overflow-hidden");
      unmount();
    }
  });

  it("暗色主题预览框补 .dark，浅色主题不带", () => {
    for (const preset of THEME_PRESETS) {
      const { container, unmount } = render(<PresetSwatches preset={preset} size="card" />);
      const root = container.firstElementChild!;
      if (preset.group === "dark") {
        expect(root).toHaveClass("dark");
      } else {
        expect(root).not.toHaveClass("dark");
      }
      unmount();
    }
  });

  it("卡顶 4px 主色带存在且走 var(--primary)，预览内无裸 hex", () => {
    for (const preset of THEME_PRESETS) {
      const { container, unmount } = render(<PresetSwatches preset={preset} size="card" />);
      const band = container.querySelector("[data-accent-band]");
      expect(band).not.toBeNull();
      expect(band).toHaveClass("h-1");
      expect(band!.getAttribute("style")).toContain("var(--primary)");

      for (const el of [container.firstElementChild!, ...container.querySelectorAll("*")]) {
        for (const attr of el.getAttributeNames()) {
          expect(el.getAttribute(attr)).not.toMatch(/#[0-9a-f]{3,8}\b/i);
        }
      }
      unmount();
    }
  });

  it("mini UI 骨架齐全：侧栏 + 选中行 + 双 Tab + 终端三行 + 主色按钮", () => {
    const { container } = render(<PresetSwatches preset={THEME_PRESETS[0]} size="card" />);
    const html = container.innerHTML;
    expect(html).toContain("var(--app-sidebar)");
    expect(html).toContain("var(--app-active-bg)");
    expect(html).toContain("var(--app-tabbar)");
    expect(html).toContain("var(--app-tab-highlight)");
    expect(html).toContain("var(--app-terminal-bg)");
    expect(html).toContain("var(--app-terminal-fg)");
    expect(html).toContain("var(--primary-foreground)");
    expect(container.querySelector(".font-mono")).not.toBeNull();
  });
});

describe("PresetSwatches menu 变体（StatusBar 下拉项，回归保护）", () => {
  it("保持两个叠加圆点：底色点 + 强调色点，hairline 描边不变", () => {
    const preset = THEME_PRESETS[0];
    const { container } = render(<PresetSwatches preset={preset} />);
    const root = container.firstElementChild;
    expect(root).toHaveAttribute("aria-hidden", "true");

    const dots = root!.querySelectorAll("span");
    expect(dots).toHaveLength(2);
    expect(dots[0]).toHaveClass("size-3", "rounded-full", "border-black/10");
    expect(dots[1]).toHaveClass("-ml-0.5", "rounded-full");
    expectInlineColor(dots[0], preset.swatches[0]);
    expectInlineColor(dots[1], preset.swatches[2]);
  });
});

describe("SystemThemePreview（跟随系统卡）", () => {
  it("与卡片预览同高（h-16），保留左右分半、图标与 live token 背景", () => {
    const { container } = render(<SystemThemePreview />);
    const root = container.firstElementChild;
    expect(root).toHaveAttribute("aria-hidden", "true");
    expect(root).toHaveClass("h-16", "rounded-md");
    expect(root!.getAttribute("style")).toContain("var(--app-content)");
    expect(root!.querySelector("svg")).not.toBeNull();
    expect(container.querySelectorAll("svg")).toHaveLength(1);
  });

  it("选中时叠加 accent 对勾角标", () => {
    const { container } = render(<SystemThemePreview selected />);
    expect(container.querySelectorAll("svg")).toHaveLength(2);
    const badge = container.querySelector("span.rounded-full.bg-\\[var\\(--app-accent\\)\\]");
    expect(badge).not.toBeNull();
  });
});
