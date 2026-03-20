import { describe, it, expect, beforeEach, vi } from "vitest";
import { useMiniModeStore } from "./useMiniModeStore";
import {
  mockTauriInvoke,
  resetTauriInvoke,
} from "@/test/utils/mockTauriInvoke";

// 覆盖 setup.ts 中的 mock，添加 scaleFactor 和 innerSize
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    scaleFactor: vi.fn().mockResolvedValue(1.5),
    innerSize: vi.fn().mockResolvedValue({ width: 1800, height: 1200 }),
    startDragging: vi.fn(),
    isMaximized: vi.fn().mockResolvedValue(false),
    onResized: vi.fn().mockResolvedValue(vi.fn()),
  }),
}));

describe("useMiniModeStore", () => {
  beforeEach(() => {
    resetTauriInvoke();
    useMiniModeStore.setState({
      isMiniMode: false,
      savedWidth: 1200,
      savedHeight: 800,
    });
  });

  describe("初始状态", () => {
    it("应该有正确的初始值", () => {
      const state = useMiniModeStore.getState();
      expect(state.isMiniMode).toBe(false);
      expect(state.savedWidth).toBe(1200);
      expect(state.savedHeight).toBe(800);
    });
  });

  describe("enterMiniMode", () => {
    it("成功时应保存窗口尺寸并设置迷你模式", async () => {
      mockTauriInvoke({ enter_mini_mode: undefined });

      await useMiniModeStore.getState().enterMiniMode();

      const state = useMiniModeStore.getState();
      expect(state.isMiniMode).toBe(true);
      // 物理尺寸 / scaleFactor = 逻辑尺寸
      expect(state.savedWidth).toBe(1800 / 1.5);
      expect(state.savedHeight).toBe(1200 / 1.5);
    });

    it("invoke 失败时不应崩溃", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      mockTauriInvoke({
        enter_mini_mode: () => {
          throw new Error("fail");
        },
      });

      await useMiniModeStore.getState().enterMiniMode();

      // 尺寸可能已保存（在 invoke 之前），但 isMiniMode 不应为 true
      // 实际上因为 catch 在整个 try 块外层，所以尺寸已更新但 isMiniMode 未设置
      expect(useMiniModeStore.getState().isMiniMode).toBe(false);
      consoleSpy.mockRestore();
    });
  });

  describe("exitMiniMode", () => {
    it("成功时应恢复窗口尺寸并退出迷你模式", async () => {
      useMiniModeStore.setState({
        isMiniMode: true,
        savedWidth: 1000,
        savedHeight: 700,
      });
      mockTauriInvoke({ exit_mini_mode: undefined });

      await useMiniModeStore.getState().exitMiniMode();

      expect(useMiniModeStore.getState().isMiniMode).toBe(false);
    });

    it("invoke 失败时不应崩溃", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      useMiniModeStore.setState({ isMiniMode: true });
      mockTauriInvoke({
        exit_mini_mode: () => {
          throw new Error("fail");
        },
      });

      await useMiniModeStore.getState().exitMiniMode();

      expect(useMiniModeStore.getState().isMiniMode).toBe(true);
      consoleSpy.mockRestore();
    });
  });

  describe("toggleMiniMode", () => {
    it("非迷你模式时应进入迷你模式", async () => {
      mockTauriInvoke({ enter_mini_mode: undefined });

      useMiniModeStore.getState().toggleMiniMode();

      // toggleMiniMode 是同步调用 enterMiniMode（返回 void），等待异步
      await vi.waitFor(() => {
        expect(useMiniModeStore.getState().isMiniMode).toBe(true);
      });
    });

    it("迷你模式时应退出迷你模式", async () => {
      useMiniModeStore.setState({ isMiniMode: true });
      mockTauriInvoke({ exit_mini_mode: undefined });

      useMiniModeStore.getState().toggleMiniMode();

      await vi.waitFor(() => {
        expect(useMiniModeStore.getState().isMiniMode).toBe(false);
      });
    });
  });
});
