import { describe, it, expect, beforeEach, vi } from "vitest";
import { useMiniModeStore } from "./useMiniModeStore";

const { runtimeMock } = vi.hoisted(() => ({
  runtimeMock: {
    getCurrentWindowIfTauri: vi.fn(),
    invokeIfTauri: vi.fn(),
    isTauriRuntime: vi.fn(),
    logErrorSafe: vi.fn(async () => {}),
  },
}));

vi.mock("@/services/runtime", () => runtimeMock);

/** 构造一个模拟的 Tauri window，scaleFactor=1，innerSize 可配 */
function makeWindow(width = 1600, height = 900, factor = 1) {
  return {
    scaleFactor: vi.fn(async () => factor),
    innerSize: vi.fn(async () => ({ width, height })),
  };
}

describe("useMiniModeStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtimeMock.isTauriRuntime.mockReturnValue(true);
    runtimeMock.invokeIfTauri.mockResolvedValue(undefined);
    runtimeMock.logErrorSafe.mockResolvedValue(undefined);
    useMiniModeStore.setState({
      isMiniMode: false,
      isTransitioning: false,
      savedWidth: 1200,
      savedHeight: 800,
    });
  });

  describe("初始状态", () => {
    it("应有默认尺寸且未进入迷你模式", () => {
      const state = useMiniModeStore.getState();
      expect(state.isMiniMode).toBe(false);
      expect(state.isTransitioning).toBe(false);
      expect(state.savedWidth).toBe(1200);
      expect(state.savedHeight).toBe(800);
    });
  });

  describe("enterMiniMode", () => {
    it("应保存逻辑尺寸、切换到迷你模式并调用后端命令", async () => {
      runtimeMock.getCurrentWindowIfTauri.mockReturnValue(
        makeWindow(1600, 900, 2),
      );

      await useMiniModeStore.getState().enterMiniMode();

      const state = useMiniModeStore.getState();
      expect(state.isMiniMode).toBe(true);
      expect(state.isTransitioning).toBe(false);
      // 物理尺寸 / 缩放因子 = 逻辑尺寸
      expect(state.savedWidth).toBe(800);
      expect(state.savedHeight).toBe(450);
      expect(runtimeMock.invokeIfTauri).toHaveBeenCalledWith("enter_mini_mode");
    });

    it("已处于迷你模式时应直接返回", async () => {
      useMiniModeStore.setState({ isMiniMode: true });

      await useMiniModeStore.getState().enterMiniMode();

      expect(runtimeMock.getCurrentWindowIfTauri).not.toHaveBeenCalled();
      expect(runtimeMock.invokeIfTauri).not.toHaveBeenCalled();
    });

    it("正在切换时应直接返回", async () => {
      useMiniModeStore.setState({ isTransitioning: true });

      await useMiniModeStore.getState().enterMiniMode();

      expect(runtimeMock.getCurrentWindowIfTauri).not.toHaveBeenCalled();
    });

    it("非 Tauri 环境（无 window）时应不切换但复位 transitioning", async () => {
      runtimeMock.getCurrentWindowIfTauri.mockReturnValue(null);

      await useMiniModeStore.getState().enterMiniMode();

      const state = useMiniModeStore.getState();
      expect(state.isMiniMode).toBe(false);
      expect(state.isTransitioning).toBe(false);
      expect(runtimeMock.invokeIfTauri).not.toHaveBeenCalled();
    });

    it("后端命令失败时应回滚 isMiniMode 并复位 transitioning", async () => {
      runtimeMock.getCurrentWindowIfTauri.mockReturnValue(makeWindow());
      runtimeMock.invokeIfTauri.mockRejectedValue(new Error("ipc fail"));

      await useMiniModeStore.getState().enterMiniMode();

      const state = useMiniModeStore.getState();
      expect(state.isMiniMode).toBe(false);
      expect(state.isTransitioning).toBe(false);
      expect(runtimeMock.logErrorSafe).toHaveBeenCalled();
    });
  });

  describe("exitMiniMode", () => {
    it("应带保存的尺寸调用后端命令并退出迷你模式", async () => {
      useMiniModeStore.setState({
        isMiniMode: true,
        savedWidth: 1000,
        savedHeight: 700,
      });

      await useMiniModeStore.getState().exitMiniMode();

      const state = useMiniModeStore.getState();
      expect(state.isMiniMode).toBe(false);
      expect(state.isTransitioning).toBe(false);
      expect(runtimeMock.invokeIfTauri).toHaveBeenCalledWith("exit_mini_mode", {
        width: 1000,
        height: 700,
      });
    });

    it("未处于迷你模式时应直接返回", async () => {
      await useMiniModeStore.getState().exitMiniMode();

      expect(runtimeMock.invokeIfTauri).not.toHaveBeenCalled();
    });

    it("正在切换时应直接返回", async () => {
      useMiniModeStore.setState({ isMiniMode: true, isTransitioning: true });

      await useMiniModeStore.getState().exitMiniMode();

      expect(runtimeMock.invokeIfTauri).not.toHaveBeenCalled();
    });

    it("非 Tauri 环境应直接退出迷你模式且不调用后端", async () => {
      useMiniModeStore.setState({ isMiniMode: true });
      runtimeMock.isTauriRuntime.mockReturnValue(false);

      await useMiniModeStore.getState().exitMiniMode();

      const state = useMiniModeStore.getState();
      expect(state.isMiniMode).toBe(false);
      expect(state.isTransitioning).toBe(false);
      expect(runtimeMock.invokeIfTauri).not.toHaveBeenCalled();
    });

    it("后端命令失败时应静默处理并复位 transitioning", async () => {
      useMiniModeStore.setState({ isMiniMode: true });
      runtimeMock.invokeIfTauri.mockRejectedValue(new Error("ipc fail"));

      await useMiniModeStore.getState().exitMiniMode();

      const state = useMiniModeStore.getState();
      expect(state.isTransitioning).toBe(false);
      expect(runtimeMock.logErrorSafe).toHaveBeenCalled();
      // 命令抛错发生在 set isMiniMode:false 之前，因此仍为 true
      expect(state.isMiniMode).toBe(true);
    });
  });

  describe("toggleMiniMode", () => {
    it("未处于迷你模式时应进入迷你模式", () => {
      runtimeMock.getCurrentWindowIfTauri.mockReturnValue(makeWindow());

      useMiniModeStore.getState().toggleMiniMode();

      // enterMiniMode 为异步，但会同步设置 isTransitioning
      expect(runtimeMock.getCurrentWindowIfTauri).toHaveBeenCalled();
    });

    it("处于迷你模式时应退出迷你模式", () => {
      useMiniModeStore.setState({ isMiniMode: true });

      useMiniModeStore.getState().toggleMiniMode();

      // exitMiniMode 会异步调用后端命令
      expect(runtimeMock.isTauriRuntime).toHaveBeenCalled();
    });
  });
});
