import "@/i18n";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useUsageStatsStore, useWorkspacesStore } from "@/stores";
import type { UsageQueryResult } from "@/types/usageStats";
import HomeUsageStats from "./HomeUsageStats";

vi.mock("recharts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("recharts")>();
  return { ...actual, ResponsiveContainer: () => <div data-testid="chart-container" /> };
});

const DATA: UsageQueryResult = {
  series: [{
    date: "2026-06-01",
    byCli: {
      claude: { charCount: 0, tokenInput: 60, tokenOutput: 20, tokenCacheRead: 30, tokenCacheCreation: 10 },
      gemini: { charCount: 0, tokenInput: 50, tokenOutput: 10, tokenCacheRead: 25, tokenCacheCreation: 0 },
    },
    claudeChars: 0,
    codexChars: 0,
    unknownChars: 0,
    claudeTokensIn: 60,
    claudeTokensOut: 20,
    claudeCacheRead: 30,
    claudeCacheCreation: 10,
    codexTokensIn: 0,
    codexTokensOut: 0,
    codexCacheRead: 0,
    codexCacheCreation: 0,
  }],
  totals: { charCount: 0, tokenInput: 110, tokenOutput: 30, tokenCacheRead: 55, tokenCacheCreation: 10 },
  byCli: {
    claude: { charCount: 0, tokenInput: 60, tokenOutput: 20, tokenCacheRead: 30, tokenCacheCreation: 10 },
    gemini: { charCount: 0, tokenInput: 50, tokenOutput: 10, tokenCacheRead: 25, tokenCacheCreation: 0 },
  },
  workspaces: ["_global"],
};

function setStore() {
  useUsageStatsStore.setState({
    rangeDays: 30,
    workspaceFilter: null,
    data: DATA,
    loading: false,
    refreshing: false,
    error: null,
    load: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockResolvedValue(undefined),
    setRangeDays: vi.fn().mockResolvedValue(undefined),
    setWorkspaceFilter: vi.fn().mockResolvedValue(undefined),
  } as never);
}

describe("HomeUsageStats", () => {
  beforeAll(() => {
    globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
    Element.prototype.scrollIntoView = vi.fn();
  });

  beforeEach(() => {
    setStore();
    useWorkspacesStore.setState({ workspaces: [], load: vi.fn().mockResolvedValue(undefined) } as never);
  });

  it("shows normalized aggregate metrics and every detected CLI", async () => {
    render(<HomeUsageStats />);
    await waitFor(() => expect(useUsageStatsStore.getState().load).toHaveBeenCalled());

    expect(screen.getByText("110")).toBeVisible();
    expect(screen.getByText("30")).toBeVisible();
    expect(screen.getByText("31.4%")).toBeVisible();
    expect(screen.getByText("Claude")).toBeVisible();
    expect(screen.getByText("Gemini")).toBeVisible();
    expect(screen.getByTestId("chart-container")).toBeVisible();
  });

  it("shows loading and error states", () => {
    useUsageStatsStore.setState({ data: null, loading: true } as never);
    const { rerender } = render(<HomeUsageStats />);
    expect(screen.getByRole("region", { name: "使用统计" })).toBeVisible();

    act(() => {
      useUsageStatsStore.setState({ loading: false, error: "read failed" } as never);
    });
    rerender(<HomeUsageStats />);
    expect(screen.getByText("read failed")).toBeVisible();
  });

  it("refreshes and maps range controls to days", () => {
    render(<HomeUsageStats />);
    fireEvent.click(screen.getByTitle("刷新用量统计"));
    expect(useUsageStatsStore.getState().refresh).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("7天"));
    expect(useUsageStatsStore.getState().setRangeDays).toHaveBeenCalledWith(7);
  });
});
