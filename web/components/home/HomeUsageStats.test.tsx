import "@/i18n";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useUsageStatsStore, useWorkspacesStore } from "@/stores";
import type { UsageDayPoint, UsageQueryResult } from "@/types/usageStats";
import HomeUsageStats from "./HomeUsageStats";

// jsdom 无布局尺寸，ResponsiveContainer 挂载后异步 setState 触发 act 警告；
// 图表内部渲染不属于本组件的编排逻辑，桩化为占位节点。
vi.mock("recharts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("recharts")>();
  return {
    ...actual,
    ResponsiveContainer: () => <div data-testid="chart-container" />,
  };
});

function dayPoint(overrides: Partial<UsageDayPoint> = {}): UsageDayPoint {
  return {
    date: "2026-06-01",
    claudeChars: 100,
    codexChars: 50,
    unknownChars: 0,
    claudeTokensIn: 10,
    claudeTokensOut: 5,
    claudeCacheRead: 3,
    claudeCacheCreation: 2,
    codexTokensIn: 8,
    codexTokensOut: 4,
    codexCacheRead: 2,
    codexCacheCreation: 0,
    ...overrides,
  };
}

const DATA: UsageQueryResult = {
  series: [dayPoint(), dayPoint({ date: "2026-06-02" })],
  totals: {
    charCount: 500,
    tokenInput: 110,
    tokenOutput: 30,
    tokenCacheRead: 55,
    tokenCacheCreation: 10,
  },
  byCli: {
    // Claude: 命中率 = 30 / (60 + 30 + 10) = 30.0%
    claude: {
      charCount: 300,
      tokenInput: 60,
      tokenOutput: 20,
      tokenCacheRead: 30,
      tokenCacheCreation: 10,
    },
    // Codex: 命中率 = 25 / 50 = 50.0%
    codex: {
      charCount: 200,
      tokenInput: 50,
      tokenOutput: 10,
      tokenCacheRead: 25,
      tokenCacheCreation: 0,
    },
  },
  workspaces: ["_global", "alpha"],
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
    // Radix DropdownMenu 在 jsdom 需要的 API 桩
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    Element.prototype.scrollIntoView = vi.fn();
    Element.prototype.hasPointerCapture = vi.fn(() => false);
    Element.prototype.setPointerCapture = vi.fn();
    Element.prototype.releasePointerCapture = vi.fn();
  });

  beforeEach(() => {
    setStore();
    useWorkspacesStore.setState({
      workspaces: [{ name: "beta", projects: [] }],
      load: vi.fn().mockResolvedValue(undefined),
    } as never);
  });

  it("挂载后调用 load，并渲染三张指标卡与命中率", async () => {
    render(<HomeUsageStats />);

    await waitFor(() => {
      expect(useUsageStatsStore.getState().load).toHaveBeenCalled();
    });
    expect(screen.getByText("输入字符")).toBeVisible();
    expect(screen.getByText("500")).toBeVisible();
    // Claude tokens: 60+20+30+10 = 120（input 不含 cache_*，四项相加）
    // Codex tokens: 50+10 = 60（input 已含 cache_read 子集，不再叠加）
    expect(screen.getByText("120")).toBeVisible();
    expect(screen.getByText("60")).toBeVisible();
    expect(screen.getByText("30.0%")).toBeVisible();
    expect(screen.getByText("50.0%")).toBeVisible();
    // 30 天范围显示趋势图标题
    expect(screen.getByText("Token 趋势")).toBeVisible();
    expect(screen.getByText("字符输入趋势")).toBeVisible();
  });

  it("error 状态显示错误文案", () => {
    useUsageStatsStore.setState({ error: "读取失败", data: null } as never);
    render(<HomeUsageStats />);

    expect(screen.getByText("读取失败")).toBeVisible();
  });

  it("loading 且无数据时显示加载占位", () => {
    useUsageStatsStore.setState({ loading: true, data: null } as never);
    render(<HomeUsageStats />);

    expect(screen.getByText("正在加载用量统计...")).toBeVisible();
  });

  it("series 为空时显示暂无用量数据", () => {
    useUsageStatsStore.setState({
      data: { ...DATA, series: [] },
    } as never);
    render(<HomeUsageStats />);

    expect(screen.getByText("暂无用量数据")).toBeVisible();
  });

  it("今天范围不出趋势图，提示切换更长范围", () => {
    useUsageStatsStore.setState({ rangeDays: 1 } as never);
    render(<HomeUsageStats />);

    expect(
      screen.getByText("切换到 7天 / 30天 / 90天 可查看趋势曲线"),
    ).toBeVisible();
    expect(screen.queryByText("Token 趋势")).not.toBeInTheDocument();
  });

  it("点击范围按钮按映射天数调用 setRangeDays", () => {
    render(<HomeUsageStats />);

    fireEvent.click(screen.getByText("7天"));
    expect(useUsageStatsStore.getState().setRangeDays).toHaveBeenCalledWith(7);

    fireEvent.click(screen.getByText("24小时"));
    expect(useUsageStatsStore.getState().setRangeDays).toHaveBeenCalledWith(2);
  });

  it("点击刷新按钮调用 refresh，refreshing 时禁用", () => {
    render(<HomeUsageStats />);

    fireEvent.click(screen.getByTitle("刷新用量统计"));
    expect(useUsageStatsStore.getState().refresh).toHaveBeenCalledTimes(1);

    act(() => {
      useUsageStatsStore.setState({ refreshing: true } as never);
    });
    render(<HomeUsageStats />);
    const buttons = screen.getAllByTitle("刷新用量统计");
    expect(buttons[buttons.length - 1]).toBeDisabled();
  });

  it("工作空间下拉合并 store 与统计数据来源，_global 显示为未匹配会话", async () => {
    const user = userEvent.setup();
    render(<HomeUsageStats />);

    await user.click(screen.getByText("全部工作空间"));

    const menu = await screen.findByRole("menu");
    const items = Array.from(menu.querySelectorAll("[role=menuitem]")).map(
      (el) => el.textContent,
    );
    // 第一项为 全部工作空间，其后 _global 排最前
    expect(items[0]).toBe("全部工作空间");
    expect(items[1]).toBe("未匹配会话");
    expect(items).toContain("alpha");
    expect(items).toContain("beta");

    await user.click(screen.getByRole("menuitem", { name: "alpha" }));
    await waitFor(() => {
      expect(
        useUsageStatsStore.getState().setWorkspaceFilter,
      ).toHaveBeenCalledWith("alpha");
    });
  });

  it("workspaceFilter 为 _global 时触发按钮显示未匹配会话", () => {
    useUsageStatsStore.setState({ workspaceFilter: "_global" } as never);
    render(<HomeUsageStats />);

    expect(screen.getByText("未匹配会话")).toBeVisible();
  });
});
