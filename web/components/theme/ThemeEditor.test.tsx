import "@/i18n";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useThemeStore } from "@/stores/useThemeStore";
import { THEME_OVERRIDES_STORAGE_KEY } from "@/theme/themeOverrides";
import { ThemeEditor } from "./ThemeEditor";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function customSection(): HTMLElement {
  const section = document.querySelector("[data-settings-section='theme-custom']");
  expect(section).not.toBeNull();
  return section as HTMLElement;
}

describe("ThemeEditor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    useThemeStore.setState({
      isDark: true,
      themeId: "deep-ink",
      preference: "deep-ink",
      shape: "soft",
      customOverrides: null,
    });
    document.documentElement.removeAttribute("style");
  });

  it("渲染微调区块：标题、色板（跟随主题 + 10 预设）、双滑杆、预览与两个操作", () => {
    render(<ThemeEditor />);

    expect(screen.getByRole("heading", { name: "自定义微调" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "恢复默认" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "导出主题 JSON" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "跟随主题" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "琥珀" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "岩灰" })).toBeInTheDocument();

    const section = customSection();
    const sliders = section.querySelectorAll("input[type='range']");
    expect(sliders).toHaveLength(2);
    // 预览套当前主题 + 当前形态
    const preview = section.querySelector(".mini-ui-scope")!;
    expect(preview).toHaveAttribute("data-theme", "deep-ink");
    expect(preview).toHaveAttribute("data-shape", "soft");
  });

  it("选择 accent 预设立即生效并持久化，恢复默认一键清空", () => {
    render(<ThemeEditor />);

    fireEvent.click(screen.getByRole("button", { name: "琥珀" }));

    expect(useThemeStore.getState().customOverrides).toEqual({
      baseThemeId: "deep-ink",
      accent: "amber",
    });
    expect(document.documentElement.style.getPropertyValue("--app-accent")).toBe("#E9A916");
    expect(screen.getByRole("button", { name: "琥珀" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "恢复默认" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "恢复默认" }));

    expect(useThemeStore.getState().customOverrides).toBeNull();
    expect(document.documentElement.style.getPropertyValue("--app-accent")).toBe("");
    expect(localStorage.getItem(THEME_OVERRIDES_STORAGE_KEY)).toBeNull();
    expect(toast.success).toHaveBeenCalledWith(
      "已恢复主题默认",
      expect.objectContaining({ duration: expect.any(Number) }),
    );
  });

  it("「跟随主题」只清除 accent，保留其他微调", () => {
    useThemeStore.setState({
      customOverrides: { baseThemeId: "deep-ink", accent: "amber", radius: 0.6 },
    });
    render(<ThemeEditor />);

    fireEvent.click(screen.getByRole("button", { name: "跟随主题" }));

    expect(useThemeStore.getState().customOverrides).toEqual({
      baseThemeId: "deep-ink",
      radius: 0.6,
    });
  });

  it("圆角滑杆写入 --radius 及派生 shape-radius；面板明度归零时清除字段", () => {
    render(<ThemeEditor />);
    const section = customSection();
    const [radiusSlider, panelSlider] = section.querySelectorAll("input[type='range']");

    fireEvent.change(radiusSlider, { target: { value: "0.8" } });
    expect(useThemeStore.getState().customOverrides?.radius).toBe(0.8);
    expect(document.documentElement.style.getPropertyValue("--radius")).toBe("0.8rem");

    fireEvent.change(panelSlider, { target: { value: "-4" } });
    expect(useThemeStore.getState().customOverrides?.panelLightnessDelta).toBe(-4);
    expect(document.documentElement.style.getPropertyValue("--app-panel-bg")).toBe(
      "color-mix(in srgb, #2E3137 96%, black)",
    );

    fireEvent.change(panelSlider, { target: { value: "0" } });
    expect(useThemeStore.getState().customOverrides?.panelLightnessDelta).toBeUndefined();
    expect(document.documentElement.style.getPropertyValue("--app-panel-bg")).toBe("");
  });

  it("导出把有效主题 JSON 写入剪贴板（含主题名/token 表/时间戳/微调）", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    useThemeStore.setState({
      shape: "carbon",
      customOverrides: { baseThemeId: "deep-ink", accent: "teal", radius: 0.4 },
    });
    render(<ThemeEditor />);

    fireEvent.click(screen.getByRole("button", { name: "导出主题 JSON" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const payload = JSON.parse(writeText.mock.calls[0][0]);
    expect(payload.app).toBe("cc-panes");
    expect(payload.kind).toBe("cc-panes-theme");
    expect(payload.version).toBe(1);
    expect(typeof payload.exportedAt).toBe("string");
    expect(Number.isNaN(Date.parse(payload.exportedAt))).toBe(false);
    expect(payload.theme).toEqual({ id: "deep-ink", name: "午夜蓝", group: "dark" });
    expect(payload.shape).toBe("carbon");
    expect(payload.overrides).toEqual({ baseThemeId: "deep-ink", accent: "teal", radius: 0.4 });
    expect(payload.tokens).toHaveProperty("--app-accent");
    expect(payload.tokens).toHaveProperty("--shape-radius-lg");
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(
      "主题 JSON 已复制到剪贴板",
      expect.objectContaining({ duration: expect.any(Number) }),
    ));
  });

  it("剪贴板失败时提示错误", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<ThemeEditor />);

    fireEvent.click(screen.getByRole("button", { name: "导出主题 JSON" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(
      "复制失败，请检查剪贴板权限",
      expect.objectContaining({ duration: expect.any(Number) }),
    ));
  });

  it("微调依附其他主题时控件按默认展示，重挂后从当前主题重新起调", () => {
    useThemeStore.setState({
      themeId: "classic-white",
      isDark: false,
      customOverrides: { baseThemeId: "deep-ink", accent: "amber" },
    });
    render(<ThemeEditor />);

    // 旧主题的微调不在当前主题生效：恢复默认按钮保持禁用
    expect(screen.getByRole("button", { name: "恢复默认" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "跟随主题" })).toHaveAttribute("aria-pressed", "true");
  });
});
