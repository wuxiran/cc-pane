import "@/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ThemeSettings } from "@/types/settings";
import {
  UI_DENSITY_STORAGE_KEY,
  useDensityStore,
} from "@/stores/useDensityStore";
import { useThemeStore } from "@/stores/useThemeStore";
import ThemeSection from "./ThemeSection";

vi.mock("sonner", () => ({
  toast: { success: vi.fn() },
}));

const baseValue: ThemeSettings = { mode: "deep-ink", shape: "soft" };

describe("ThemeSection 界面密度", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    useThemeStore.setState({
      isDark: true,
      themeId: "deep-ink",
      preference: "deep-ink",
      shape: "soft",
    });
    useDensityStore.setState({ density: "comfortable" });
    document.documentElement.dataset.density = "comfortable";
  });

  it("形态视图渲染密度区与两个档位", () => {
    render(<ThemeSection view="shape" value={baseValue} onChange={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "界面密度" })).toBeInTheDocument();
    const group = screen.getByRole("radiogroup", { name: "界面密度" });
    expect(group).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /舒适 Comfortable/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /紧凑 Compact/ })).not.toBeChecked();
  });

  it("配色视图不渲染密度区", () => {
    render(<ThemeSection view="theme" value={baseValue} onChange={vi.fn()} />);

    expect(screen.queryByRole("heading", { name: "界面密度" })).not.toBeInTheDocument();
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
  });

  it("选择紧凑档立即生效并持久化", () => {
    render(<ThemeSection view="shape" value={baseValue} onChange={vi.fn()} />);

    fireEvent.click(screen.getByRole("radio", { name: /紧凑 Compact/ }));

    expect(useDensityStore.getState().density).toBe("compact");
    expect(document.documentElement.dataset.density).toBe("compact");
    expect(localStorage.getItem(UI_DENSITY_STORAGE_KEY)).toBe("compact");
    expect(screen.getByRole("radio", { name: /紧凑 Compact/ })).toBeChecked();
  });

  it("密度切换不触碰配色与形态草稿", () => {
    const onChange = vi.fn();
    render(<ThemeSection view="shape" value={baseValue} onChange={onChange} />);

    fireEvent.click(screen.getByRole("radio", { name: /紧凑 Compact/ }));

    // 密度走 useDensityStore 自持久化通道，不进主题草稿（onChange 不应被触发）
    expect(onChange).not.toHaveBeenCalled();
    expect(useThemeStore.getState().themeId).toBe("deep-ink");
    expect(useThemeStore.getState().shape).toBe("soft");
  });
});
