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

describe("PresetSwatches card 变体（迷你窗口预览）", () => {
  it("六个主题都渲染出迷你窗口：根底色 + 边框面色，且整体保持 aria-hidden", () => {
    for (const preset of THEME_PRESETS) {
      const { container, unmount } = render(<PresetSwatches preset={preset} size="card" />);
      const root = container.firstElementChild;
      expect(root).not.toBeNull();
      expect(root).toHaveAttribute("aria-hidden", "true");
      expect(root).toHaveClass("h-16", "rounded-md", "overflow-hidden");
      expectInlineColor(root!, preset.swatches[0]);
      expectInlineColor(root!, preset.swatches[1]);
      unmount();
    }
  });

  it("窗口结构克制：子元素不超过 10 个，accent 只出现在窗口钮/激活项/主按钮三处", () => {
    for (const preset of THEME_PRESETS) {
      const { container, unmount } = render(<PresetSwatches preset={preset} size="card" />);
      const root = container.firstElementChild!;
      const children = [...root.querySelectorAll("span")];
      expect(children.length).toBeLessThanOrEqual(10);

      const accentEls = children.filter((el) => usesColor(el, preset.swatches[2]));
      expect(accentEls).toHaveLength(3);
      expect(accentEls.filter((el) => el.className.includes("rounded-full"))).toHaveLength(2);
      expect(accentEls.some((el) => el.className.includes("mt-auto"))).toBe(true);

      // 标题带 + 活动栏 + 3 根文字条都取面色 sw[1]；底色 sw[0] 只属于根容器。
      const surfaceEls = children.filter((el) => usesColor(el, preset.swatches[1]));
      expect(surfaceEls).toHaveLength(5);
      expect(children.filter((el) => usesColor(el, preset.swatches[0]))).toHaveLength(0);
      unmount();
    }
  });

  it("文字条用透明度分出层次，accent 主按钮沉底", () => {
    const preset = THEME_PRESETS[0];
    const { container } = render(<PresetSwatches preset={preset} size="card" />);
    const root = container.firstElementChild!;
    const bars = [...root.querySelectorAll("span")].filter((el) => el.className.includes("opacity-"));
    expect(bars).toHaveLength(2);
    expect(bars[0]).toHaveClass("opacity-60");
    expect(bars[1]).toHaveClass("opacity-40");
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
