import "@/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThemeSettings } from "@/types/settings";
import { useThemeStore } from "@/stores/useThemeStore";
import { THEME_PRESETS } from "@/theme/themePresets";
import { THEME_SHAPES } from "@/theme/themeShapes";
import ThemeSection from "./ThemeSection";

vi.mock("sonner", () => ({
  toast: { success: vi.fn() },
}));

describe("ThemeSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useThemeStore.setState({
      isDark: true,
      themeId: "deep-ink",
      preference: "deep-ink",
      shape: "soft",
      customOverrides: null,
    });
    document.documentElement.dataset.shape = "soft";
    document.documentElement.removeAttribute("style");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows the named presets and applies the selected theme", () => {
    const onChange = vi.fn();
    const value: ThemeSettings = { mode: "deep-ink", shape: "soft" };
    render(<ThemeSection value={value} onChange={onChange} />);

    expect(screen.getByRole("button", { name: /午夜蓝/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /晴空蓝/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /霓虹紫/ }));

    expect(onChange).toHaveBeenCalledWith({ mode: "cyber-purple", shape: "soft" });
    expect(useThemeStore.getState().themeId).toBe("cyber-purple");
    expect(document.documentElement.dataset.theme).toBe("cyber-purple");
  });

  it("supports following the system theme", () => {
    const onChange = vi.fn();
    render(<ThemeSection value={{ mode: "deep-ink", shape: "soft" }} onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: /跟随系统/ }));

    expect(onChange).toHaveBeenCalledWith({ mode: "system", shape: "soft" });
    expect(useThemeStore.getState().preference).toBe("system");
  });

  it("shows separate color and shape sections without the combined heading", () => {
    render(
      <ThemeSection
        value={{ mode: "deep-ink", shape: "soft" }}
        onChange={vi.fn()}
      />,
    );

    expect(screen.queryByRole("heading", { name: "配色与形态" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "配色主题" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "界面形态" })).toBeInTheDocument();
    for (const name of [
      "柔和 Soft",
      "层板 Slab",
      "直角 Sharp",
      "玻璃 Glass",
      "面板 Panel",
      "碳纹 Carbon",
    ]) {
      expect(screen.getByRole("button", { name: new RegExp(name) })).toBeInTheDocument();
    }
    expect(screen.getByText("默认")).toBeInTheDocument();
    expect(screen.getAllByText("适合壁纸")).toHaveLength(2);
  });

  it("applies shape immediately without changing the color theme", () => {
    const onChange = vi.fn();
    useThemeStore.setState({ themeId: "cyber-purple", preference: "cyber-purple" });
    render(
      <ThemeSection
        value={{ mode: "cyber-purple", shape: "soft" }}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /直角 Sharp/ }));

    expect(onChange).toHaveBeenCalledWith({ mode: "cyber-purple", shape: "sharp" });
    expect(useThemeStore.getState().shape).toBe("sharp");
    expect(useThemeStore.getState().themeId).toBe("cyber-purple");
    expect(document.documentElement.dataset.shape).toBe("sharp");
  });

  it("exposes selected state and restores the default shape", () => {
    const onChange = vi.fn();
    render(
      <ThemeSection
        value={{ mode: "deep-ink", shape: "glass" }}
        onChange={onChange}
      />,
    );

    expect(screen.getByRole("button", { name: /玻璃 Glass/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "恢复默认形态" }));

    expect(onChange).toHaveBeenCalledWith({ mode: "deep-ink", shape: "soft" });
    expect(document.documentElement.dataset.shape).toBe("soft");
    expect(toast.success).toHaveBeenCalledWith("已恢复为柔和 Soft", expect.objectContaining({ duration: expect.any(Number) }));
  });

  it("applies an external draft reset to both color and shape", () => {
    const { rerender } = render(
      <ThemeSection
        value={{ mode: "cyber-purple", shape: "carbon" }}
        onChange={vi.fn()}
      />,
    );

    rerender(
      <ThemeSection
        value={{ mode: "deep-ink", shape: "soft" }}
        onChange={vi.fn()}
      />,
    );

    expect(useThemeStore.getState().themeId).toBe("deep-ink");
    expect(useThemeStore.getState().shape).toBe("soft");
    expect(document.documentElement.dataset.shape).toBe("soft");
  });

  it("背景模糊不可用时说明已保留半透明层次", () => {
    vi.stubGlobal("CSS", { supports: vi.fn(() => false) });

    render(
      <ThemeSection
        value={{ mode: "deep-ink", shape: "glass" }}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByText("当前环境不支持背景模糊，已保留半透明层次。")).toBeInTheDocument();
  });

  it("主题卡 mini UI 反映当前 shape：每张卡主题不同、shape 相同", () => {
    useThemeStore.setState({ shape: "carbon" });
    render(
      <ThemeSection value={{ mode: "deep-ink", shape: "carbon" }} onChange={vi.fn()} />,
    );

    const colorSection = document.querySelector("[data-settings-section='theme-color']")!;
    const previews = colorSection.querySelectorAll("[data-theme]");
    expect(previews).toHaveLength(THEME_PRESETS.length);
    for (const preview of previews) {
      expect(preview).toHaveAttribute("data-shape", "carbon");
    }
  });

  it("主题视图渲染自定义微调区块，形态视图不渲染", () => {
    const { unmount } = render(
      <ThemeSection view="theme" value={{ mode: "deep-ink", shape: "soft" }} onChange={vi.fn()} />,
    );
    expect(document.querySelector("[data-settings-section='theme-custom']")).not.toBeNull();
    expect(screen.getByRole("heading", { name: "自定义微调" })).toBeInTheDocument();
    unmount();

    render(
      <ThemeSection view="shape" value={{ mode: "deep-ink", shape: "soft" }} onChange={vi.fn()} />,
    );
    expect(document.querySelector("[data-settings-section='theme-custom']")).toBeNull();
  });

  it("主题卡渲染 mini UI 预览：data-theme 套框、卡顶主色带、aria-pressed 选中态不变", () => {
    render(
      <ThemeSection value={{ mode: "tokyo-night", shape: "soft" }} onChange={vi.fn()} />,
    );

    const colorSection = document.querySelector("[data-settings-section='theme-color']")!;
    for (const preset of THEME_PRESETS) {
      const preview = colorSection.querySelector(`[data-theme="${preset.id}"]`);
      expect(preview, `${preset.id} 卡片缺少 data-theme 预览框`).not.toBeNull();
      expect(preview).toHaveAttribute("aria-hidden", "true");
      expect(preview!.querySelector("[data-accent-band]")).not.toBeNull();
      const card = preview!.closest("button")!;
      expect(card).toHaveAttribute("aria-pressed", preset.id === "tokyo-night" ? "true" : "false");
    }
  });

  it("主题卡预览内无裸 hex，颜色全部走 var()", () => {
    render(
      <ThemeSection value={{ mode: "deep-ink", shape: "soft" }} onChange={vi.fn()} />,
    );

    const previews = document.querySelectorAll("[data-settings-section='theme-color'] [data-theme]");
    expect(previews).toHaveLength(THEME_PRESETS.length);
    for (const preview of previews) {
      for (const el of [preview, ...preview.querySelectorAll("*")]) {
        for (const attr of el.getAttributeNames()) {
          expect(el.getAttribute(attr)).not.toMatch(/#[0-9a-f]{3,8}\b/i);
        }
      }
    }
  });

  it("形态卡渲染 mini UI 预览：data-shape 套框且选中卡 aria-pressed=true", () => {
    render(
      <ThemeSection value={{ mode: "deep-ink", shape: "carbon" }} onChange={vi.fn()} />,
    );

    const shapeSection = document.querySelector("[data-settings-section='theme-shape']")!;
    const previews = shapeSection.querySelectorAll("[data-shape]");
    expect(previews).toHaveLength(THEME_SHAPES.length);
    for (const shape of THEME_SHAPES) {
      const preview = shapeSection.querySelector(`[data-shape="${shape.code}"]`);
      expect(preview, `${shape.code} 卡片缺少 data-shape 预览框`).not.toBeNull();
      expect(preview).toHaveAttribute("aria-hidden", "true");
      expect(preview).not.toHaveAttribute("data-theme");
      expect(preview!.querySelector("[data-accent-band]")).not.toBeNull();
      const card = preview!.closest("button")!;
      expect(card).toHaveAttribute("aria-pressed", shape.code === "carbon" ? "true" : "false");
    }
  });
});
