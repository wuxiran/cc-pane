import "@/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useUpdateStore } from "@/stores";
import { triggerUpdate } from "@/services/updaterService";
import HomeHeader from "./HomeHeader";

vi.mock("@/services/updaterService", () => ({
  checkForAppUpdates: vi.fn(),
  checkUpdateSilent: vi.fn(),
  triggerUpdate: vi.fn(),
}));

describe("HomeHeader", () => {
  beforeEach(() => {
    useUpdateStore.getState().clearUpdate();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("显示版本号与 logo", () => {
    render(<HomeHeader version="1.2.3" />);

    expect(screen.getByText("v1.2.3")).toBeVisible();
    expect(screen.getByAltText("CC-Panes")).toBeInTheDocument();
  });

  it.each([
    [9, "早上好"],
    [14, "下午好"],
    [20, "晚上好"],
  ])("按小时 %i 显示问候语 %s", (hour, greeting) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 3, hour, 0, 0));

    render(<HomeHeader version="1.0.0" />);

    expect(screen.getByText(greeting)).toBeVisible();
  });

  it("问候语标题走 display 字号 token", () => {
    render(<HomeHeader version="1.0.0" />);

    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading).toHaveClass("tracking-tight");
    expect(heading.className).toContain("text-[length:var(--text-display)]");
  });

  it("无可用更新时显示已是最新", () => {
    render(<HomeHeader version="1.0.0" />);

    expect(screen.getByText("已是最新")).toBeVisible();
    expect(screen.queryByText(/有新版本/)).not.toBeInTheDocument();
  });

  it("有可用更新时显示更新按钮，点击触发 triggerUpdate", () => {
    useUpdateStore.getState().setUpdate("2.0.0", null);
    render(<HomeHeader version="1.0.0" />);

    const button = screen.getByText(/有新版本/).closest("button")!;
    expect(button.textContent).toContain("2.0.0");
    expect(screen.queryByText("已是最新")).not.toBeInTheDocument();

    fireEvent.click(button);
    expect(triggerUpdate).toHaveBeenCalledTimes(1);
  });
});
