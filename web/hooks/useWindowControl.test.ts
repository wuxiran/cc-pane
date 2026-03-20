import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  mockTauriInvoke,
  resetTauriInvoke,
} from "@/test/utils/mockTauriInvoke";
import { useWindowControl } from "./useWindowControl";

// Mock @tauri-apps/api/window（setup.ts 未 mock 此模块）
const mockStartDragging = vi.fn();
const mockIsMaximized = vi.fn().mockResolvedValue(false);
const mockOnResized = vi.fn().mockResolvedValue(vi.fn());

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: vi.fn(() => ({
    startDragging: mockStartDragging,
    isMaximized: mockIsMaximized,
    onResized: mockOnResized,
  })),
}));

describe("useWindowControl", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetTauriInvoke();
    mockIsMaximized.mockResolvedValue(false);
    mockOnResized.mockResolvedValue(vi.fn());
  });

  describe("初始状态", () => {
    it("isPinned 应该为 false", async () => {
      const { result } = renderHook(() => useWindowControl());

      await waitFor(() => {
        expect(result.current.isPinned).toBe(false);
      });
    });

    it("isMaximized 应该为 false", async () => {
      const { result } = renderHook(() => useWindowControl());

      await waitFor(() => {
        expect(result.current.isMaximized).toBe(false);
      });
    });

    it("初始化时应该检查窗口最大化状态", async () => {
      mockIsMaximized.mockResolvedValue(true);

      const { result } = renderHook(() => useWindowControl());

      await waitFor(() => {
        expect(result.current.isMaximized).toBe(true);
      });
      expect(mockIsMaximized).toHaveBeenCalled();
    });
  });

  describe("togglePin", () => {
    it("应该调用 toggle_always_on_top 并更新 isPinned", async () => {
      mockTauriInvoke({ toggle_always_on_top: true });

      const { result } = renderHook(() => useWindowControl());

      await act(async () => {
        await result.current.togglePin();
      });

      expect(invoke).toHaveBeenCalledWith("toggle_always_on_top");
      expect(result.current.isPinned).toBe(true);
    });

    it("invoke 失败时不应该崩溃", async () => {
      const mockInvoke = invoke as ReturnType<typeof vi.fn>;
      mockInvoke.mockRejectedValue(new Error("toggle failed"));

      const { result } = renderHook(() => useWindowControl());

      await act(async () => {
        await result.current.togglePin();
      });

      // isPinned 应该保持不变
      expect(result.current.isPinned).toBe(false);
    });
  });

  describe("closeWindow", () => {
    it("应该调用 close_window 命令", async () => {
      mockTauriInvoke({ close_window: undefined });

      const { result } = renderHook(() => useWindowControl());

      await act(async () => {
        await result.current.closeWindow();
      });

      expect(invoke).toHaveBeenCalledWith("close_window");
    });

    it("invoke 失败时不应该崩溃", async () => {
      const mockInvoke = invoke as ReturnType<typeof vi.fn>;
      mockInvoke.mockRejectedValue(new Error("close failed"));

      const { result } = renderHook(() => useWindowControl());

      await act(async () => {
        await result.current.closeWindow();
      });

      // 不抛出错误即通过
    });
  });

  describe("minimizeWindow", () => {
    it("应该调用 minimize_window 命令", async () => {
      mockTauriInvoke({ minimize_window: undefined });

      const { result } = renderHook(() => useWindowControl());

      await act(async () => {
        await result.current.minimizeWindow();
      });

      expect(invoke).toHaveBeenCalledWith("minimize_window");
    });

    it("invoke 失败时不应该崩溃", async () => {
      const mockInvoke = invoke as ReturnType<typeof vi.fn>;
      mockInvoke.mockRejectedValue(new Error("minimize failed"));

      const { result } = renderHook(() => useWindowControl());

      await act(async () => {
        await result.current.minimizeWindow();
      });

      // 不抛出错误即通过
    });
  });

  describe("maximizeWindow", () => {
    it("应该调用 maximize_window 命令", async () => {
      mockTauriInvoke({ maximize_window: undefined });

      const { result } = renderHook(() => useWindowControl());

      await act(async () => {
        await result.current.maximizeWindow();
      });

      expect(invoke).toHaveBeenCalledWith("maximize_window");
    });

    it("invoke 失败时不应该崩溃", async () => {
      const mockInvoke = invoke as ReturnType<typeof vi.fn>;
      mockInvoke.mockRejectedValue(new Error("maximize failed"));

      const { result } = renderHook(() => useWindowControl());

      await act(async () => {
        await result.current.maximizeWindow();
      });

      // 不抛出错误即通过
    });
  });

  describe("startDrag", () => {
    it("应该调用 getCurrentWindow().startDragging()", () => {
      const { result } = renderHook(() => useWindowControl());

      act(() => {
        result.current.startDrag();
      });

      expect(getCurrentWindow).toHaveBeenCalled();
      expect(mockStartDragging).toHaveBeenCalled();
    });
  });

  describe("onResized 事件监听", () => {
    it("应该注册 onResized 监听器", async () => {
      renderHook(() => useWindowControl());

      await waitFor(() => {
        expect(mockOnResized).toHaveBeenCalled();
      });
    });

    it("unmount 时应该取消 onResized 监听", async () => {
      const mockUnlisten = vi.fn();
      mockOnResized.mockResolvedValue(mockUnlisten);

      const { unmount } = renderHook(() => useWindowControl());

      // 等待 onResized promise 解析
      await waitFor(() => {
        expect(mockOnResized).toHaveBeenCalled();
      });

      unmount();

      // cleanup 中 unlisten.then(fn => fn()) 是异步的，需要等待微任务完成
      await waitFor(() => {
        expect(mockUnlisten).toHaveBeenCalled();
      });
    });
  });
});
