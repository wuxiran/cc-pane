import "@/i18n";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { systemStatsService } from "@/services/systemStatsService";
import SystemResourceSegment from "./SystemResourceSegment";

vi.mock("@/services/systemStatsService", () => ({
  systemStatsService: { get: vi.fn() },
}));

function setDocumentHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", {
    configurable: true,
    value: hidden,
  });
}

async function flushResolvedStats() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("SystemResourceSegment", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    setDocumentHidden(false);
  });

  afterEach(() => {
    vi.useRealTimers();
    setDocumentHidden(false);
  });

  it("渲染 CPU 与内存用量，并每 3 秒拉取一次", async () => {
    vi.mocked(systemStatsService.get).mockResolvedValue({
      cpuPercent: 12.4,
      memUsed: 18.2 * 1024 ** 3,
      memTotal: 64 * 1024 ** 3,
    });

    render(<SystemResourceSegment />);
    await flushResolvedStats();
    expect(screen.getByText("12%")).toBeInTheDocument();
    expect(screen.getByText("18.2/64G")).toBeInTheDocument();
    expect(systemStatsService.get).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(systemStatsService.get).toHaveBeenCalledTimes(2);
  });

  it("仅将越过阈值的数字切换为 warning 色", async () => {
    vi.mocked(systemStatsService.get).mockResolvedValue({
      cpuPercent: 85.1,
      memUsed: 91 * 1024 ** 3,
      memTotal: 100 * 1024 ** 3,
    });

    render(<SystemResourceSegment />);

    await flushResolvedStats();
    expect(screen.getByText("85%")).toHaveStyle({ color: "var(--app-status-warning)" });
    expect(screen.getByText("91/100G")).toHaveStyle({ color: "var(--app-status-warning)" });
  });

  it("页面隐藏时暂停，恢复可见后立即拉取并重启轮询", async () => {
    vi.mocked(systemStatsService.get).mockResolvedValue({
      cpuPercent: 10,
      memUsed: 4 * 1024 ** 3,
      memTotal: 16 * 1024 ** 3,
    });
    render(<SystemResourceSegment />);
    await flushResolvedStats();
    expect(systemStatsService.get).toHaveBeenCalledTimes(1);

    setDocumentHidden(true);
    document.dispatchEvent(new Event("visibilitychange"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });
    expect(systemStatsService.get).toHaveBeenCalledTimes(1);

    setDocumentHidden(false);
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
    });
    expect(systemStatsService.get).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(systemStatsService.get).toHaveBeenCalledTimes(3);
  });
});
