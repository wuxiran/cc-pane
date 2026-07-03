import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useProcessMonitorStore } from "./useProcessMonitorStore";
import {
  mockTauriInvoke,
  resetTauriInvoke,
} from "@/test/utils/mockTauriInvoke";
import type { ClaudeProcess, ProcessScanResult } from "@/types";

function makeProcess(pid: number, overrides: Partial<ClaudeProcess> = {}): ClaudeProcess {
  return {
    pid,
    parentPid: null,
    name: `proc-${pid}`,
    command: `cmd ${pid}`,
    cwd: null,
    memoryBytes: 1024,
    startTime: 0,
    processType: "claude_cli",
    ...overrides,
  };
}

function makeScanResult(pids: number[]): ProcessScanResult {
  const processes = pids.map((p) => makeProcess(p));
  return {
    processes,
    totalCount: processes.length,
    totalMemoryBytes: processes.reduce((a, p) => a + p.memoryBytes, 0),
    scannedAt: "2024-01-01T00:00:00.000Z",
  };
}

describe("useProcessMonitorStore", () => {
  beforeEach(() => {
    resetTauriInvoke();
    useProcessMonitorStore.setState({
      scanResult: null,
      scanning: false,
      killing: new Set(),
      selectedPids: new Set(),
    });
  });

  afterEach(() => {
    useProcessMonitorStore.getState().stopAutoRefresh();
  });

  describe("初始状态", () => {
    it("应有正确的默认值", () => {
      const s = useProcessMonitorStore.getState();
      expect(s.scanResult).toBeNull();
      expect(s.scanning).toBe(false);
      expect(s.killing.size).toBe(0);
      expect(s.selectedPids.size).toBe(0);
    });
  });

  describe("scan", () => {
    it("应加载扫描结果", async () => {
      const result = makeScanResult([1, 2, 3]);
      mockTauriInvoke({ scan_claude_processes: result });

      await useProcessMonitorStore.getState().scan();

      const s = useProcessMonitorStore.getState();
      expect(s.scanResult).toEqual(result);
      expect(s.scanning).toBe(false);
    });

    it("扫描期间应把 scanning 设为 true", async () => {
      mockTauriInvoke({
        scan_claude_processes: () =>
          new Promise((resolve) => setTimeout(() => resolve(makeScanResult([])), 10)),
      });

      const p = useProcessMonitorStore.getState().scan();
      expect(useProcessMonitorStore.getState().scanning).toBe(true);

      await p;
      expect(useProcessMonitorStore.getState().scanning).toBe(false);
    });

    it("正在扫描时再次调用应直接返回", async () => {
      useProcessMonitorStore.setState({ scanning: true });
      // 不设置任何 mock，若真的调用 invoke 会 reject
      await expect(useProcessMonitorStore.getState().scan()).resolves.toBeUndefined();
    });

    it("应剔除已不存在的已选中 PID", async () => {
      useProcessMonitorStore.setState({ selectedPids: new Set([1, 2, 99]) });
      mockTauriInvoke({ scan_claude_processes: makeScanResult([1, 2, 3]) });

      await useProcessMonitorStore.getState().scan();

      const selected = useProcessMonitorStore.getState().selectedPids;
      expect([...selected].sort()).toEqual([1, 2]);
    });

    it("扫描失败且无历史结果时应设置空结果", async () => {
      mockTauriInvoke({
        scan_claude_processes: () => {
          throw new Error("扫描失败");
        },
      });

      await useProcessMonitorStore.getState().scan();

      const s = useProcessMonitorStore.getState();
      expect(s.scanResult).not.toBeNull();
      expect(s.scanResult?.processes).toEqual([]);
      expect(s.scanResult?.totalCount).toBe(0);
      expect(s.scanning).toBe(false);
    });

    it("扫描失败但已有历史结果时应保留旧结果", async () => {
      const old = makeScanResult([1]);
      useProcessMonitorStore.setState({ scanResult: old });
      mockTauriInvoke({
        scan_claude_processes: () => {
          throw new Error("扫描失败");
        },
      });

      await useProcessMonitorStore.getState().scan();

      expect(useProcessMonitorStore.getState().scanResult).toEqual(old);
    });
  });

  describe("killProcess", () => {
    it("成功终止后应返回 true 并从选中移除、刷新列表", async () => {
      useProcessMonitorStore.setState({ selectedPids: new Set([1, 2]) });
      mockTauriInvoke({
        kill_claude_process: true,
        scan_claude_processes: makeScanResult([2]),
      });

      const ok = await useProcessMonitorStore.getState().killProcess(1);

      expect(ok).toBe(true);
      const s = useProcessMonitorStore.getState();
      expect([...s.selectedPids]).toEqual([2]);
      expect(s.killing.has(1)).toBe(false);
    });

    it("终止返回 false 时不应刷新列表", async () => {
      mockTauriInvoke({ kill_claude_process: false });

      const ok = await useProcessMonitorStore.getState().killProcess(5);

      expect(ok).toBe(false);
      expect(useProcessMonitorStore.getState().killing.has(5)).toBe(false);
    });

    it("终止抛错时应返回 false 并清理 killing 集合", async () => {
      mockTauriInvoke({
        kill_claude_process: () => {
          throw new Error("kill failed");
        },
      });

      const ok = await useProcessMonitorStore.getState().killProcess(7);

      expect(ok).toBe(false);
      expect(useProcessMonitorStore.getState().killing.has(7)).toBe(false);
    });
  });

  describe("killSelected", () => {
    it("无选中时应直接返回", async () => {
      await expect(
        useProcessMonitorStore.getState().killSelected(),
      ).resolves.toBeUndefined();
    });

    it("应批量终止选中的进程并清空选择、刷新", async () => {
      useProcessMonitorStore.setState({ selectedPids: new Set([1, 2]) });
      const killMock = vi.fn(() => [
        [1, true],
        [2, true],
      ]);
      mockTauriInvoke({
        kill_claude_processes: killMock,
        scan_claude_processes: makeScanResult([]),
      });

      await useProcessMonitorStore.getState().killSelected();

      expect(killMock).toHaveBeenCalled();
      expect(useProcessMonitorStore.getState().selectedPids.size).toBe(0);
    });

    it("批量终止抛错时应静默处理", async () => {
      useProcessMonitorStore.setState({ selectedPids: new Set([1]) });
      mockTauriInvoke({
        kill_claude_processes: () => {
          throw new Error("批量失败");
        },
      });

      await expect(
        useProcessMonitorStore.getState().killSelected(),
      ).resolves.toBeUndefined();
      // 出错时选择未清空
      expect(useProcessMonitorStore.getState().selectedPids.size).toBe(1);
    });
  });

  describe("killAll", () => {
    it("无扫描结果时应直接返回", async () => {
      await expect(
        useProcessMonitorStore.getState().killAll(),
      ).resolves.toBeUndefined();
    });

    it("进程列表为空时应直接返回", async () => {
      useProcessMonitorStore.setState({ scanResult: makeScanResult([]) });
      await expect(
        useProcessMonitorStore.getState().killAll(),
      ).resolves.toBeUndefined();
    });

    it("应终止所有进程并清空选择、刷新", async () => {
      useProcessMonitorStore.setState({
        scanResult: makeScanResult([1, 2]),
        selectedPids: new Set([1]),
      });
      const killMock = vi.fn(() => [
        [1, true],
        [2, true],
      ]);
      mockTauriInvoke({
        kill_claude_processes: killMock,
        scan_claude_processes: makeScanResult([]),
      });

      await useProcessMonitorStore.getState().killAll();

      expect(killMock).toHaveBeenCalled();
      expect(useProcessMonitorStore.getState().selectedPids.size).toBe(0);
    });
  });

  describe("选择操作", () => {
    it("toggleSelect 应切换 PID 的选中状态", () => {
      useProcessMonitorStore.getState().toggleSelect(3);
      expect(useProcessMonitorStore.getState().selectedPids.has(3)).toBe(true);

      useProcessMonitorStore.getState().toggleSelect(3);
      expect(useProcessMonitorStore.getState().selectedPids.has(3)).toBe(false);
    });

    it("selectAll 应选中所有进程", () => {
      useProcessMonitorStore.setState({ scanResult: makeScanResult([1, 2, 3]) });

      useProcessMonitorStore.getState().selectAll();

      expect([...useProcessMonitorStore.getState().selectedPids].sort()).toEqual([
        1, 2, 3,
      ]);
    });

    it("selectAll 在无扫描结果时为无操作", () => {
      useProcessMonitorStore.getState().selectAll();
      expect(useProcessMonitorStore.getState().selectedPids.size).toBe(0);
    });

    it("clearSelection 应清空选择", () => {
      useProcessMonitorStore.setState({ selectedPids: new Set([1, 2]) });
      useProcessMonitorStore.getState().clearSelection();
      expect(useProcessMonitorStore.getState().selectedPids.size).toBe(0);
    });
  });

  describe("自动刷新", () => {
    it("startAutoRefresh 应立即扫描并周期性刷新", async () => {
      vi.useFakeTimers();
      try {
        const scanMock = vi.fn(() => makeScanResult([1]));
        mockTauriInvoke({ scan_claude_processes: scanMock });

        useProcessMonitorStore.getState().startAutoRefresh();
        // 立即扫描一次
        await vi.advanceTimersByTimeAsync(0);
        expect(scanMock).toHaveBeenCalledTimes(1);

        // 30 秒后再次扫描
        await vi.advanceTimersByTimeAsync(30_000);
        expect(scanMock).toHaveBeenCalledTimes(2);
      } finally {
        useProcessMonitorStore.getState().stopAutoRefresh();
        vi.useRealTimers();
      }
    });

    it("重复调用 startAutoRefresh 不应重复创建定时器", async () => {
      vi.useFakeTimers();
      try {
        const scanMock = vi.fn(() => makeScanResult([]));
        mockTauriInvoke({ scan_claude_processes: scanMock });

        useProcessMonitorStore.getState().startAutoRefresh();
        useProcessMonitorStore.getState().startAutoRefresh();
        await vi.advanceTimersByTimeAsync(0);

        // 两次 start 但立即扫描只发生一次（第二次因已有 timer 直接返回）
        expect(scanMock).toHaveBeenCalledTimes(1);
      } finally {
        useProcessMonitorStore.getState().stopAutoRefresh();
        vi.useRealTimers();
      }
    });

    it("stopAutoRefresh 应停止周期刷新", async () => {
      vi.useFakeTimers();
      try {
        const scanMock = vi.fn(() => makeScanResult([]));
        mockTauriInvoke({ scan_claude_processes: scanMock });

        useProcessMonitorStore.getState().startAutoRefresh();
        await vi.advanceTimersByTimeAsync(0);
        useProcessMonitorStore.getState().stopAutoRefresh();

        await vi.advanceTimersByTimeAsync(60_000);
        expect(scanMock).toHaveBeenCalledTimes(1);
      } finally {
        useProcessMonitorStore.getState().stopAutoRefresh();
        vi.useRealTimers();
      }
    });
  });
});
