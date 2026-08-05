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

  it("shows the named presets and applies the selected theme", () => {
    const onChange = vi.fn();
    const value: ThemeSettings = { mode: "deep-ink" };
    render(<ThemeSection value={value} onChange={onChange} />);

    expect(screen.getByRole("button", { name: /午夜蓝/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /晴空蓝/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /霓虹紫/ }));

    expect(onChange).toHaveBeenCalledWith({ mode: "cyber-purple" });
    expect(useThemeStore.getState().themeId).toBe("cyber-purple");
    expect(document.documentElement.dataset.theme).toBe("cyber-purple");
  });

  it("supports following the system theme", () => {
    const onChange = vi.fn();
    render(<ThemeSection value={{ mode: "deep-ink" }} onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: /跟随系统/ }));

    expect(onChange).toHaveBeenCalledWith({ mode: "system" });
    expect(useThemeStore.getState().preference).toBe("system");
  });
});
