import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useThemeStore } from "@/stores/useThemeStore";
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

beforeEach(() => {
  useThemeStore.setState({
    themeId: "deep-ink",
    preference: "deep-ink",
    shape: "soft",
    customOverrides: null,
  });
});

describe("MiniUiPreview 主题模式", () => {
  it.each(THEME_PRESETS.map((preset) => [preset.id, preset.group] as const))(
    "data-theme=%s 套在预览框上，暗色主题补 .dark，整体 aria-hidden",
    (themeId, group) => {
      const { container } = render(<MiniUiPreview theme={themeId} />);
      const root = container.firstElementChild!;
      expect(root).toHaveAttribute("data-theme", themeId);
      // 未显式传 shape 时跟随 useThemeStore 当前形态（测试基线 = soft）
      expect(root).toHaveAttribute("data-shape", "soft");
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

  it("主题卡预览跟随当前用户 shape（主题不同、shape 相同）", () => {
    useThemeStore.setState({ shape: "carbon" });

    const { container } = render(<MiniUiPreview theme="amber-gold" />);
    const root = container.firstElementChild!;
    expect(root).toHaveAttribute("data-theme", "amber-gold");
    expect(root).toHaveAttribute("data-shape", "carbon");
  });

  it("显式 shape 优先于 store 当前形态", () => {
    useThemeStore.setState({ shape: "carbon" });

    const { container } = render(<MiniUiPreview theme="deep-ink" shape="glass" />);
    const root = container.firstElementChild!;
    expect(root).toHaveAttribute("data-theme", "deep-ink");
    expect(root).toHaveAttribute("data-shape", "glass");
  });

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

describe("MiniUiPreview 微调联动", () => {
  it("overrides 依附当前预览主题时，覆盖 token inline 到作用域根", () => {
    useThemeStore.setState({
      themeId: "deep-ink",
      customOverrides: { baseThemeId: "deep-ink", accent: "amber", radius: 0.6 },
    });

    const { container } = render(<MiniUiPreview theme="deep-ink" />);
    const root = container.firstElementChild as HTMLElement;
    // accent 预设色值（色板映射豁免裸 hex）+ 圆角派生经 var()/calc
    expect(root.style.getPropertyValue("--app-accent")).toBe("#E9A916");
    expect(root.style.getPropertyValue("--primary")).toBe("#E9A916");
    expect(root.style.getPropertyValue("--radius")).toBe("0.6rem");
    expect(root.style.getPropertyValue("--shape-radius-lg")).toBe("var(--radius)");
  });

  it("overrides 依附其他主题时预览不受影响", () => {
    useThemeStore.setState({
      themeId: "deep-ink",
      customOverrides: { baseThemeId: "warm-gray", accent: "amber" },
    });

    const { container } = render(<MiniUiPreview theme="deep-ink" />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.style.getPropertyValue("--app-accent")).toBe("");
  });

  it("形态卡（无 theme prop）跟随当前主题的 overrides", () => {
    useThemeStore.setState({
      themeId: "sky-blue",
      customOverrides: { baseThemeId: "sky-blue", accent: "red" },
    });

    const { container } = render(<MiniUiPreview shape="sharp" />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.style.getPropertyValue("--app-accent")).toBe("#DC2626");
  });

  it("无 overrides 时作用域根不带任何覆盖 token", () => {
    const { container } = render(<MiniUiPreview theme="deep-ink" />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.style.getPropertyValue("--app-accent")).toBe("");
    expect(root.style.getPropertyValue("--radius")).toBe("");
  });
});
