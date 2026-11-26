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

describe("PresetSwatches card 变体", () => {
  // card 变体直接委托 MiniUiPreview，骨架/裸 hex/暗色 .dark 等细节由 MiniUiPreview.test 覆盖
  it.each(THEME_PRESETS.map((preset) => [preset.id, preset] as const))(
    "%s 渲染为套该主题 data-theme 的 mini UI 预览",
    (_id, preset) => {
      const { container } = render(<PresetSwatches preset={preset} size="card" />);
      const root = container.firstElementChild;
      expect(root).toHaveAttribute("data-theme", preset.id);
      expect(root).toHaveAttribute("aria-hidden", "true");
      expect(container.querySelector("[data-accent-band]")).not.toBeNull();
    },
  );
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
  it("保留图标与 live token 背景", () => {
    const { container } = render(<SystemThemePreview />);
    const root = container.firstElementChild;
    expect(root).toHaveAttribute("aria-hidden", "true");
    expect(root!.getAttribute("style")).toContain("var(--app-content)");
    expect(root!.querySelector("svg")).not.toBeNull();
    expect(container.querySelectorAll("svg")).toHaveLength(1);
  });

  it("选中时叠加 accent 对勾角标", () => {
    const { container } = render(<SystemThemePreview selected />);
    expect(container.querySelectorAll("svg")).toHaveLength(2);
  });
});
