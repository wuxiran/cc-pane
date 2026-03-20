import { describe, it, expect, beforeEach, vi } from "vitest";
import { useFullscreenStore } from "./useFullscreenStore";
import {
  mockTauriInvoke,
  resetTauriInvoke,
} from "@/test/utils/mockTauriInvoke";

describe("useFullscreenStore", () => {
  beforeEach(() => {
    resetTauriInvoke();
    useFullscreenStore.setState({
      isFullscreen: false,
      fullscreenTabId: null,
      fullscreenPaneId: null,
    });
  });

  describe("初始状态", () => {
    it("应该有正确的初始值", () => {
      const state = useFullscreenStore.getState();
      expect(state.isFullscreen).toBe(false);
      expect(state.fullscreenTabId).toBeNull();
      expect(state.fullscreenPaneId).toBeNull();
    });
  });

  describe("enterFullscreen", () => {
    it("成功时应设置全屏状态", async () => {
      mockTauriInvoke({ enter_fullscreen: undefined });

      await useFullscreenStore.getState().enterFullscreen("pane-1", "tab-1");

      const state = useFullscreenStore.getState();
      expect(state.isFullscreen).toBe(true);
      expect(state.fullscreenPaneId).toBe("pane-1");
      expect(state.fullscreenTabId).toBe("tab-1");
    });

    it("invoke 失败时不应崩溃且状态不变", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      mockTauriInvoke({
        enter_fullscreen: () => {
          throw new Error("fail");
        },
      });

      await useFullscreenStore.getState().enterFullscreen("pane-1", "tab-1");

      const state = useFullscreenStore.getState();
      expect(state.isFullscreen).toBe(false);
      expect(state.fullscreenPaneId).toBeNull();
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  describe("exitFullscreen", () => {
    it("成功时应清除全屏状态", async () => {
      useFullscreenStore.setState({
        isFullscreen: true,
        fullscreenPaneId: "pane-1",
        fullscreenTabId: "tab-1",
      });
      mockTauriInvoke({ exit_fullscreen: undefined });

      await useFullscreenStore.getState().exitFullscreen();

      const state = useFullscreenStore.getState();
      expect(state.isFullscreen).toBe(false);
      expect(state.fullscreenPaneId).toBeNull();
      expect(state.fullscreenTabId).toBeNull();
    });

    it("invoke 失败时不应崩溃", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      useFullscreenStore.setState({ isFullscreen: true });
      mockTauriInvoke({
        exit_fullscreen: () => {
          throw new Error("fail");
        },
      });

      await useFullscreenStore.getState().exitFullscreen();

      // 状态保持不变（invoke 失败，set 未执行）
      expect(useFullscreenStore.getState().isFullscreen).toBe(true);
      consoleSpy.mockRestore();
    });
  });

  describe("toggleFullscreen", () => {
    it("已全屏时应退出全屏", async () => {
      useFullscreenStore.setState({
        isFullscreen: true,
        fullscreenPaneId: "pane-1",
        fullscreenTabId: "tab-1",
      });
      mockTauriInvoke({ exit_fullscreen: undefined });

      await useFullscreenStore.getState().toggleFullscreen();

      expect(useFullscreenStore.getState().isFullscreen).toBe(false);
    });

    it("未全屏时且有参数应进入全屏", async () => {
      mockTauriInvoke({ enter_fullscreen: undefined });

      await useFullscreenStore.getState().toggleFullscreen("pane-1", "tab-1");

      const state = useFullscreenStore.getState();
      expect(state.isFullscreen).toBe(true);
      expect(state.fullscreenPaneId).toBe("pane-1");
      expect(state.fullscreenTabId).toBe("tab-1");
    });

    it("未全屏时且无参数应不做任何操作", async () => {
      await useFullscreenStore.getState().toggleFullscreen();

      expect(useFullscreenStore.getState().isFullscreen).toBe(false);
    });
  });

  describe("checkFullscreenState", () => {
    it("系统非全屏但 store 是全屏时应重置状态", async () => {
      useFullscreenStore.setState({
        isFullscreen: true,
        fullscreenPaneId: "pane-1",
        fullscreenTabId: "tab-1",
      });
      mockTauriInvoke({ is_fullscreen: false });

      await useFullscreenStore.getState().checkFullscreenState();

      const state = useFullscreenStore.getState();
      expect(state.isFullscreen).toBe(false);
      expect(state.fullscreenPaneId).toBeNull();
      expect(state.fullscreenTabId).toBeNull();
    });

    it("系统全屏且 store 全屏时不应更改状态", async () => {
      useFullscreenStore.setState({
        isFullscreen: true,
        fullscreenPaneId: "pane-1",
        fullscreenTabId: "tab-1",
      });
      mockTauriInvoke({ is_fullscreen: true });

      await useFullscreenStore.getState().checkFullscreenState();

      const state = useFullscreenStore.getState();
      expect(state.isFullscreen).toBe(true);
      expect(state.fullscreenPaneId).toBe("pane-1");
    });

    it("系统非全屏且 store 非全屏时不应更改状态", async () => {
      mockTauriInvoke({ is_fullscreen: false });

      await useFullscreenStore.getState().checkFullscreenState();

      expect(useFullscreenStore.getState().isFullscreen).toBe(false);
    });

    it("invoke 失败时不应抛异常", async () => {
      mockTauriInvoke({
        is_fullscreen: () => {
          throw new Error("not registered");
        },
      });

      // 不应抛出
      await useFullscreenStore.getState().checkFullscreenState();
      expect(useFullscreenStore.getState().isFullscreen).toBe(false);
    });
  });
});
