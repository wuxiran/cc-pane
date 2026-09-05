import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { THEME_PRESETS, themeGroup } from "@/theme/themePresets";
import { THEME_SHAPE_CODES } from "@/theme/themeShapes";
import { MiniUiPreview } from "./MiniUiPreview";

const HEX_RE = /#[0-9a-f]{3,8}\b/i;

/** 递归断言子树内没有任何裸 hex（颜色必须全部走 var()）。 */
function expectNoBareHex(root: Element) {
  const all = [root, ...root.querySelectorAll("*")];
  for (const el of all) {
    for (const attr of el.getAttributeNames()) {
      const value = el.getAttribute(attr) ?? "";
      expect(HEX_RE.test(value), `元素 ${el.tagName} 属性 ${attr} 出现裸 hex：${value}`).toBe(false);
    }
    const style = el.getAttribute("style");
    if (style && /color|background|border/.test(style)) {
      expect(style).toContain("var(");
    }
  }
}

describe("MiniUiPreview 主题模式", () => {
  it.each(THEME_PRESETS.map((preset) => [preset.id, preset.group] as const))(
    "data-theme=%s 套在预览框上，暗色主题补 .dark，整体 aria-hidden",
    (themeId, group) => {
      const { container } = render(<MiniUiPreview theme={themeId} />);
      const root = container.firstElementChild!;
      expect(root).toHaveAttribute("data-theme", themeId);
      expect(root).not.toHaveAttribute("data-shape");
      expect(root).toHaveAttribute("aria-hidden", "true");
      expect(root).toHaveClass("mini-ui-scope", "aspect-video");
      if (group === "dark") {
        expect(root).toHaveClass("dark");
      } else {
        expect(root).not.toHaveClass("dark");
      }
      expect(themeGroup(themeId)).toBe(group);
    },
  );

  it("卡顶有 4px 主色带，颜色走 var(--primary)", () => {
    const { container } = render(<MiniUiPreview theme="deep-ink" />);
    const band = container.querySelector("[data-accent-band]")!;
    expect(band).not.toBeNull();
    expect(band).toHaveClass("h-1");
    expect(band.getAttribute("style")).toContain("var(--primary)");
  });

  it("mini UI 骨架：侧栏选中行 + 双 Tab + 三行终端 + 主色按钮，全部 token 着色", () => {
    const { container } = render(<MiniUiPreview theme="tokyo-night" />);
    const html = container.innerHTML;

    // 侧栏：普通行 + active 选中行
    expect(html).toContain("var(--app-sidebar)");
    expect(html).toContain("var(--app-active-bg)");
    // Tab 栏：高亮活动 Tab + 非活动 Tab
    expect(html).toContain("var(--app-tabbar)");
    expect(html).toContain("var(--app-tab-highlight)");
    // 终端：等宽字体、终端底色/前景、成功行、accent 提示符
    const terminal = container.querySelector(".font-mono")!;
    expect(terminal.getAttribute("style")).toContain("var(--app-terminal-bg)");
    expect(terminal.textContent).toContain("pnpm tauri:dev");
    expect(html).toContain("var(--app-terminal-fg)");
    expect(html).toContain("var(--app-status-success)");
    expect(html).toContain("var(--app-accent)");
    // 主色按钮小块
    expect(html).toContain("var(--primary-foreground)");
    // 终端模拟行恰好三行
    expect(terminal.querySelectorAll(":scope > span.block")).toHaveLength(3);
  });

  it("预览内无裸 hex", () => {
    for (const preset of THEME_PRESETS) {
      const { container, unmount } = render(<MiniUiPreview theme={preset.id} />);
      expectNoBareHex(container.firstElementChild!);
      unmount();
    }
  });
});

describe("MiniUiPreview 形态模式", () => {
  it.each(THEME_SHAPE_CODES)("data-shape=%s 套在预览框上，不带 data-theme/.dark", (shape) => {
    const { container } = render(<MiniUiPreview shape={shape} />);
    const root = container.firstElementChild!;
    expect(root).toHaveAttribute("data-shape", shape);
    expect(root).not.toHaveAttribute("data-theme");
    expect(root).not.toHaveClass("dark");
    expect(root).toHaveAttribute("aria-hidden", "true");
  });

  it("形态预览复用同一 mini UI 骨架（侧栏 + Tab + 终端 + 主色带）", () => {
    const { container } = render(<MiniUiPreview shape="glass" />);
    expect(container.querySelector("[data-accent-band]")).not.toBeNull();
    expect(container.querySelector(".font-mono")).not.toBeNull();
    expect(container.innerHTML).toContain("var(--app-sidebar)");
    expect(container.innerHTML).toContain("var(--app-tabbar)");
  });

  it("表面材质挂在 .mini-ui-surface 上，供 glass/carbon 作用域覆写", () => {
    const { container } = render(<MiniUiPreview shape="carbon" />);
    const surfaces = container.querySelectorAll(".mini-ui-surface");
    expect(surfaces.length).toBeGreaterThanOrEqual(1);
  });

  it("形态预览无裸 hex", () => {
    for (const shape of THEME_SHAPE_CODES) {
      const { container, unmount } = render(<MiniUiPreview shape={shape} />);
      expectNoBareHex(container.firstElementChild!);
      unmount();
    }
  });
});
