import "@/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ThemeSettings } from "@/types/settings";
import { useThemeStore } from "@/stores/useThemeStore";
import ThemeSection from "./ThemeSection";

describe("ThemeSection", () => {
  beforeEach(() => {
    useThemeStore.setState({
      isDark: true,
      themeId: "deep-ink",
      preference: "deep-ink",
    });
  });

  // 受控组件：点击只写 draft，视觉主题跟随传回来的 value.mode 单源生效
  // （设置面板 500ms 自动落盘；「重置本节」改 draft 时画面同样跟着回退）。
  it("shows the named presets and applies the theme carried by the draft", () => {
    const onChange = vi.fn();
    const value: ThemeSettings = { mode: "deep-ink" };
    const { rerender } = render(<ThemeSection value={value} onChange={onChange} />);

    expect(screen.getByRole("button", { name: /午夜蓝/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /晴空蓝/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /霓虹紫/ }));
    expect(onChange).toHaveBeenCalledWith({ mode: "cyber-purple" });

    rerender(<ThemeSection value={{ mode: "cyber-purple" }} onChange={onChange} />);
    expect(useThemeStore.getState().themeId).toBe("cyber-purple");
    expect(document.documentElement.dataset.theme).toBe("cyber-purple");
  });

  it("supports following the system theme", () => {
    const onChange = vi.fn();
    const { rerender } = render(<ThemeSection value={{ mode: "deep-ink" }} onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: /跟随系统/ }));
    expect(onChange).toHaveBeenCalledWith({ mode: "system" });

    rerender(<ThemeSection value={{ mode: "system" }} onChange={onChange} />);
    expect(useThemeStore.getState().preference).toBe("system");
  });

  // 外部改 draft（例如「重置本节」）也必须立刻反映到画面，不能只改选中态。
  it("follows draft changes that did not come from a click", () => {
    const onChange = vi.fn();
    const { rerender } = render(<ThemeSection value={{ mode: "cyber-purple" }} onChange={onChange} />);
    expect(document.documentElement.dataset.theme).toBe("cyber-purple");

    rerender(<ThemeSection value={{ mode: "deep-ink" }} onChange={onChange} />);
    expect(useThemeStore.getState().themeId).toBe("deep-ink");
    expect(onChange).not.toHaveBeenCalled();
  });
});
