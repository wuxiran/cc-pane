import { describe, it, expect, beforeEach, vi } from "vitest";
import { useUsageStatsStore } from "./useUsageStatsStore";
import type { UsageQueryResult } from "@/types/usageStats";

const { serviceMock } = vi.hoisted(() => ({
  serviceMock: {
    queryUsage: vi.fn(),
    refreshUsage: vi.fn(),
  },
}));

vi.mock("@/services/usageStatsService", () => ({
  usageStatsService: serviceMock,
}));

function makeResult(overrides?: Partial<UsageQueryResult>): UsageQueryResult {
  return {
    series: [],
    totals: {
      charCount: 0,
      tokenInput: 0,
      tokenOutput: 0,
      tokenCacheRead: 0,
      tokenCacheCreation: 0,
    },
    byCli: {},
    workspaces: [],
    ...overrides,
  };
}

describe("useUsageStatsStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUsageStatsStore.setState({
      rangeDays: 30,
      workspaceFilter: null,
      data: null,
      loading: false,
      refreshing: false,
      error: null,
    });
  });

  describe("初始状态", () => {
    it("应有正确的默认值", () => {
      const state = useUsageStatsStore.getState();
      expect(state.rangeDays).toBe(30);
      expect(state.workspaceFilter).toBeNull();
      expect(state.data).toBeNull();
      expect(state.loading).toBe(false);
      expect(state.refreshing).toBe(false);
      expect(state.error).toBeNull();
    });
  });

  describe("load", () => {
    it("应使用当前筛选参数查询并保存结果", async () => {
      const result = makeResult({ workspaces: ["ws1"] });
      serviceMock.queryUsage.mockResolvedValue(result);
      useUsageStatsStore.setState({ rangeDays: 7, workspaceFilter: "ws1" });

      await useUsageStatsStore.getState().load();

      expect(serviceMock.queryUsage).toHaveBeenCalledWith(7, "ws1");
      const state = useUsageStatsStore.getState();
      expect(state.data).toEqual(result);
      expect(state.loading).toBe(false);
      expect(state.error).toBeNull();
    });

    it("加载期间应设置 loading 为 true", async () => {
      let resolveFn: (v: UsageQueryResult) => void = () => {};
      serviceMock.queryUsage.mockReturnValue(
        new Promise<UsageQueryResult>((resolve) => {
          resolveFn = resolve;
        }),
      );

      const promise = useUsageStatsStore.getState().load();
      expect(useUsageStatsStore.getState().loading).toBe(true);

      resolveFn(makeResult());
      await promise;
      expect(useUsageStatsStore.getState().loading).toBe(false);
    });

    it("查询失败时应设置 error、复位 loading 并重新抛出", async () => {
      serviceMock.queryUsage.mockRejectedValue(new Error("查询失败"));

      await expect(useUsageStatsStore.getState().load()).rejects.toThrow(
        "查询失败",
      );

      const state = useUsageStatsStore.getState();
      expect(state.error).toBeTruthy();
      expect(state.loading).toBe(false);
    });
  });

  describe("setRangeDays", () => {
    it("应更新 rangeDays 并触发 load", async () => {
      const result = makeResult();
      serviceMock.queryUsage.mockResolvedValue(result);

      await useUsageStatsStore.getState().setRangeDays(90);

      expect(useUsageStatsStore.getState().rangeDays).toBe(90);
      expect(serviceMock.queryUsage).toHaveBeenCalledWith(90, null);
    });
  });

  describe("setWorkspaceFilter", () => {
    it("应更新 workspaceFilter 并触发 load", async () => {
      serviceMock.queryUsage.mockResolvedValue(makeResult());

      await useUsageStatsStore.getState().setWorkspaceFilter("ws-x");

      expect(useUsageStatsStore.getState().workspaceFilter).toBe("ws-x");
      expect(serviceMock.queryUsage).toHaveBeenCalledWith(30, "ws-x");
    });

    it("传入 null 时应清空筛选", async () => {
      serviceMock.queryUsage.mockResolvedValue(makeResult());
      useUsageStatsStore.setState({ workspaceFilter: "ws-x" });

      await useUsageStatsStore.getState().setWorkspaceFilter(null);

      expect(useUsageStatsStore.getState().workspaceFilter).toBeNull();
    });
  });

  describe("refresh", () => {
    it("应先刷新后端再重新加载", async () => {
      serviceMock.refreshUsage.mockResolvedValue(undefined);
      serviceMock.queryUsage.mockResolvedValue(makeResult());

      await useUsageStatsStore.getState().refresh();

      expect(serviceMock.refreshUsage).toHaveBeenCalledTimes(1);
      expect(serviceMock.queryUsage).toHaveBeenCalledTimes(1);
      expect(useUsageStatsStore.getState().refreshing).toBe(false);
    });

    it("刷新期间应设置 refreshing 为 true", async () => {
      let resolveFn: () => void = () => {};
      serviceMock.refreshUsage.mockReturnValue(
        new Promise<void>((resolve) => {
          resolveFn = resolve;
        }),
      );
      serviceMock.queryUsage.mockResolvedValue(makeResult());

      const promise = useUsageStatsStore.getState().refresh();
      expect(useUsageStatsStore.getState().refreshing).toBe(true);

      resolveFn();
      await promise;
      expect(useUsageStatsStore.getState().refreshing).toBe(false);
    });

    it("刷新失败时应设置 error、复位 refreshing 并重新抛出", async () => {
      serviceMock.refreshUsage.mockRejectedValue(new Error("刷新失败"));

      await expect(useUsageStatsStore.getState().refresh()).rejects.toThrow(
        "刷新失败",
      );

      const state = useUsageStatsStore.getState();
      expect(state.error).toBeTruthy();
      expect(state.refreshing).toBe(false);
    });
  });
});
