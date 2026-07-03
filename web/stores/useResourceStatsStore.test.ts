import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ResourceStats } from "@/types";
import type { RuntimeEvent } from "@/services/runtime";

// Mock runtime 服务，控制 listenWebviewIfTauri 行为
const listenWebviewIfTauri = vi.fn();
vi.mock("@/services/runtime", () => ({
  listenWebviewIfTauri: (...args: unknown[]) => listenWebviewIfTauri(...args),
}));

import { useResourceStatsStore } from "./useResourceStatsStore";

function makeStats(overrides?: Partial<ResourceStats>): ResourceStats {
  return {
    totalCpuPercent: 12.5,
    totalMemoryBytes: 1024,
    processCount: 3,
    timestamp: 1000,
    ...overrides,
  };
}

describe("useResourceStatsStore", () => {
  beforeEach(() => {
    listenWebviewIfTauri.mockReset();
    useResourceStatsStore.setState({
      stats: null,
      _unlisten: null,
      _initialized: false,
    });
  });

  describe("初始状态", () => {
    it("应该有正确的初始值", () => {
      const state = useResourceStatsStore.getState();
      expect(state.stats).toBeNull();
      expect(state._unlisten).toBeNull();
      expect(state._initialized).toBe(false);
    });
  });

  describe("init", () => {
    it("应该注册监听器并保存 unlisten 函数", async () => {
      const unlisten = vi.fn();
      listenWebviewIfTauri.mockResolvedValue(unlisten);

      await useResourceStatsStore.getState().init();

      expect(listenWebviewIfTauri).toHaveBeenCalledTimes(1);
      expect(listenWebviewIfTauri).toHaveBeenCalledWith(
        "resource-stats",
        expect.any(Function),
      );
      const state = useResourceStatsStore.getState();
      expect(state._initialized).toBe(true);
      expect(state._unlisten).toBe(unlisten);
    });

    it("收到事件时应更新 stats", async () => {
      let handler: ((e: RuntimeEvent<ResourceStats>) => void) | undefined;
      listenWebviewIfTauri.mockImplementation((_name: string, h: never) => {
        handler = h;
        return Promise.resolve(vi.fn());
      });

      await useResourceStatsStore.getState().init();

      const stats = makeStats();
      handler?.({ payload: stats } as RuntimeEvent<ResourceStats>);

      expect(useResourceStatsStore.getState().stats).toEqual(stats);
    });

    it("重复 init 时不应重复注册监听器", async () => {
      listenWebviewIfTauri.mockResolvedValue(vi.fn());

      await useResourceStatsStore.getState().init();
      await useResourceStatsStore.getState().init();

      expect(listenWebviewIfTauri).toHaveBeenCalledTimes(1);
    });
  });

  describe("cleanup", () => {
    it("应该调用 unlisten 并重置状态", async () => {
      const unlisten = vi.fn();
      listenWebviewIfTauri.mockResolvedValue(unlisten);
      await useResourceStatsStore.getState().init();
      useResourceStatsStore.setState({ stats: makeStats() });

      useResourceStatsStore.getState().cleanup();

      expect(unlisten).toHaveBeenCalledTimes(1);
      const state = useResourceStatsStore.getState();
      expect(state.stats).toBeNull();
      expect(state._unlisten).toBeNull();
      expect(state._initialized).toBe(false);
    });

    it("没有 unlisten 时也应安全重置状态", () => {
      expect(() => useResourceStatsStore.getState().cleanup()).not.toThrow();
      const state = useResourceStatsStore.getState();
      expect(state.stats).toBeNull();
      expect(state._initialized).toBe(false);
    });

    it("cleanup 后可以重新 init", async () => {
      listenWebviewIfTauri.mockResolvedValue(vi.fn());
      await useResourceStatsStore.getState().init();
      useResourceStatsStore.getState().cleanup();

      await useResourceStatsStore.getState().init();

      expect(listenWebviewIfTauri).toHaveBeenCalledTimes(2);
      expect(useResourceStatsStore.getState()._initialized).toBe(true);
    });
  });
});
