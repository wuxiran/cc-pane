import "@/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThemeSettings } from "@/types/settings";
import { useThemeStore } from "@/stores/useThemeStore";
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
    });
    document.documentElement.dataset.shape = "soft";
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

  it("shows separate color and shape sections with all six previews", () => {
    render(
      <ThemeSection
        value={{ mode: "deep-ink", shape: "soft" }}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { name: "配色与形态" })).toBeInTheDocument();
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
    expect(toast.success).toHaveBeenCalledWith("已恢复为柔和 Soft");
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
});
