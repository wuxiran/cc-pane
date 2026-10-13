import "@/i18n";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { heavyCommandService } from "@/services/heavyCommandService";
import type { HeavyCommandAggregate, HeavyCommandRecord } from "@/types/heavyCommand";
import {
  HeavyCommandsTab,
  formatCpuSeconds,
  formatDurationMs,
  projectLabel,
} from "./HeavyCommandsTab";

vi.mock("@/services/heavyCommandService", () => ({
  heavyCommandService: {
    list: vi.fn(),
    aggregate: vi.fn(),
    clear: vi.fn(),
    samplerStats: vi.fn(),
  },
}));

const baseRow: HeavyCommandRecord = {
  id: 1,
  sessionId: "s1",
  projectPath: "D:/work/cc-book",
  workspace: "ws",
  cliTool: "claude",
  runtimeKind: "local",
  cmdNormalized: "cargo build",
  cmdRedacted: "cargo build --release",
  source: "both",
  startedAt: 1,
  endedAt: 2,
  durationMs: 1,
  exitCode: 0,
  peakCpuPct: 300,
  peakMemBytes: 1024,
  cpuSeconds: 10,
  target: "local",
  offloadedReason: null,
  createdAt: 1,
};

const rows: HeavyCommandRecord[] = [
  baseRow,
  { ...baseRow, id: 2, projectPath: "E:/other/app", cmdNormalized: "npm run build" },
];

const aggregates: HeavyCommandAggregate[] = [
  {
    cmdNormalized: "cargo build",
    runs: 6,
    totalCpuSeconds: 420.5,
    p50DurationMs: 30_000,
    p95DurationMs: 95_000,
    peakMemBytes: 3 * 1024 ** 3,
    lastStartedAt: 1,
  },
  {
    cmdNormalized: "npm run build",
    runs: 2,
    totalCpuSeconds: 12,
    p50DurationMs: null,
    p95DurationMs: null,
    peakMemBytes: null,
    lastStartedAt: 1,
  },
];

function renderTab(active = true) {
  return render(
    <TooltipProvider>
      <HeavyCommandsTab active={active} />
    </TooltipProvider>,
  );
}

describe("HeavyCommandsTab", () => {
  beforeEach(() => {
    vi.mocked(heavyCommandService.list).mockResolvedValue(rows);
    vi.mocked(heavyCommandService.aggregate).mockResolvedValue(aggregates);
    vi.mocked(heavyCommandService.clear).mockResolvedValue(2);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders aggregates with runs, cpu seconds, percentiles and peak memory", async () => {
    renderTab();
    await waitFor(() => expect(screen.getByText("cargo build")).toBeInTheDocument());
    const row = screen.getByText("cargo build").closest("tr")!;
    expect(row).toHaveTextContent("6");
    expect(row).toHaveTextContent("421");
    expect(row).toHaveTextContent("30 s");
    expect(row).toHaveTextContent("1m 35s");
    expect(row).toHaveTextContent("3.00 GB");
    // 未封账 / 无峰值用占位符，不显示 0
    const npm = screen.getByText("npm run build").closest("tr")!;
    expect(npm).toHaveTextContent("–");
    // 窗口固定 7 天
    const since = vi.mocked(heavyCommandService.aggregate).mock.calls[0][0]!;
    expect(Date.now() - since).toBeGreaterThan(6.9 * 24 * 3600 * 1000);
    expect(vi.mocked(heavyCommandService.aggregate).mock.calls[0][1]).toBeNull();
  });

  it("does not fetch while inactive", () => {
    renderTab(false);
    expect(heavyCommandService.list).not.toHaveBeenCalled();
    expect(heavyCommandService.aggregate).not.toHaveBeenCalled();
  });

  it("project filter is built from recent rows and re-aggregates with the project path", async () => {
    renderTab();
    await waitFor(() => expect(screen.getByText("cargo build")).toBeInTheDocument());
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    const labels = [...select.options].map((option) => option.textContent);
    expect(labels).toContain("app");
    expect(labels).toContain("cc-book");
    fireEvent.change(select, { target: { value: "D:/work/cc-book" } });
    await waitFor(() =>
      expect(heavyCommandService.aggregate).toHaveBeenLastCalledWith(
        expect.any(Number),
        "D:/work/cc-book",
      ),
    );
  });

  it("clear is two-step and refreshes afterwards", async () => {
    renderTab();
    await waitFor(() => expect(screen.getByText("cargo build")).toBeInTheDocument());
    expect(heavyCommandService.clear).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /clear ledger|清空台账/i }));
    fireEvent.click(screen.getByRole("button", { name: /confirm clear|确认清空/i }));
    await waitFor(() => expect(heavyCommandService.clear).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(heavyCommandService.aggregate).toHaveBeenCalledTimes(2));
  });

  it("shows the empty state when nothing was recorded", async () => {
    vi.mocked(heavyCommandService.list).mockResolvedValue([]);
    vi.mocked(heavyCommandService.aggregate).mockResolvedValue([]);
    renderTab();
    await waitFor(() => expect(screen.getByTestId("heavy-commands-tab")).toBeInTheDocument());
    await waitFor(() => expect(screen.queryByRole("table")).toBeNull());
  });
});

describe("formatting helpers", () => {
  it("formatDurationMs", () => {
    expect(formatDurationMs(null)).toBe("–");
    expect(formatDurationMs(250)).toBe("250 ms");
    expect(formatDurationMs(2_500)).toBe("2.5 s");
    expect(formatDurationMs(45_000)).toBe("45 s");
    expect(formatDurationMs(125_000)).toBe("2m 5s");
    expect(formatDurationMs(2 * 3_600_000 + 60_000)).toBe("2h 1m");
  });

  it("formatCpuSeconds", () => {
    expect(formatCpuSeconds(0)).toBe("0");
    expect(formatCpuSeconds(12.345)).toBe("12.3");
    expect(formatCpuSeconds(420.5)).toBe("421");
    expect(formatCpuSeconds(7200)).toBe("2.0h");
  });

  it("projectLabel takes the last path segment on both separators", () => {
    expect(projectLabel("D:/work/cc-book")).toBe("cc-book");
    expect(projectLabel("D:\\work\\cc-book\\")).toBe("cc-book");
    expect(projectLabel("")).toBe("");
  });
});
