import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useTerminalStatusStore } from "./useTerminalStatusStore";
import type { TerminalStatusInfo } from "@/types";

describe("useTerminalStatusStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    // 重置 store 到初始状态
    useTerminalStatusStore.setState({
      statusMap: new Map(),
      _unlisten: null,
      _idleCheckInterval: null,
      _initialized: false,
    });
  });

  afterEach(() => {
    // 清理定时器
    useTerminalStatusStore.getState().cleanup();
    vi.useRealTimers();
  });

  describe("getStatus", () => {
    it("sessionId 为 null 时应返回 null", () => {
      const result = useTerminalStatusStore.getState().getStatus(null);
      expect(result).toBeNull();
    });

    it("sessionId 不存在时应返回 null", () => {
      const result = useTerminalStatusStore.getState().getStatus("non-exist");
      expect(result).toBeNull();
    });

    it("sessionId 存在时应返回对应状态", () => {
      const info: TerminalStatusInfo = {
        sessionId: "session-1",
        status: "active",
        lastOutputAt: Date.now(),
      };
      const map = new Map<string, TerminalStatusInfo>();
      map.set("session-1", info);
      useTerminalStatusStore.setState({ statusMap: map });

      const result = useTerminalStatusStore.getState().getStatus("session-1");
      expect(result).toBe("active");
    });
  });

  describe("removeSession", () => {
    it("应从 statusMap 中删除指定 session", () => {
      const map = new Map<string, TerminalStatusInfo>();
      map.set("session-1", {
        sessionId: "session-1",
        status: "active",
        lastOutputAt: Date.now(),
      });
      map.set("session-2", {
        sessionId: "session-2",
        status: "idle",
        lastOutputAt: Date.now(),
      });
      useTerminalStatusStore.setState({ statusMap: map });

      useTerminalStatusStore.getState().removeSession("session-1");

      const newMap = useTerminalStatusStore.getState().statusMap;
      expect(newMap.has("session-1")).toBe(false);
      expect(newMap.has("session-2")).toBe(true);
    });

    it("删除不存在的 session 不应出错", () => {
      useTerminalStatusStore.getState().removeSession("non-exist");
      expect(useTerminalStatusStore.getState().statusMap.size).toBe(0);
    });
  });

  describe("init", () => {
    it("应注册 listen 事件和 setInterval", async () => {
      await useTerminalStatusStore.getState().init();

      expect(getCurrentWebview().listen).toHaveBeenCalledWith(
        "terminal-status",
        expect.any(Function)
      );
      expect(useTerminalStatusStore.getState()._initialized).toBe(true);
      expect(useTerminalStatusStore.getState()._unlisten).not.toBeNull();
      expect(useTerminalStatusStore.getState()._idleCheckInterval).not.toBeNull();
    });

    it("重复调用 init 不应重复注册", async () => {
      await useTerminalStatusStore.getState().init();
      await useTerminalStatusStore.getState().init();

      // listen 应只被调用一次
      expect(getCurrentWebview().listen).toHaveBeenCalledTimes(1);
    });

    it("listen 回调应更新 statusMap", async () => {
      // 捕获 listen 的回调函数
      let listenCallback: ((event: { payload: TerminalStatusInfo }) => void) | null = null;
      vi.mocked(getCurrentWebview().listen).mockImplementation(async (_event, handler) => {
        listenCallback = handler as (event: { payload: TerminalStatusInfo }) => void;
        return () => {};
      });

      await useTerminalStatusStore.getState().init();

      // 模拟事件
      expect(listenCallback).not.toBeNull();
      listenCallback!({
        payload: {
          sessionId: "session-1",
          status: "active",
          lastOutputAt: 1000,
        },
      });

      const map = useTerminalStatusStore.getState().statusMap;
      expect(map.has("session-1")).toBe(true);
      expect(map.get("session-1")?.status).toBe("active");
    });

    it("setInterval 应将超过 30s 无输出的 active 会话标记为 idle", async () => {
      await useTerminalStatusStore.getState().init();

      // 手动设置一个超时的 active 会话
      const now = Date.now();
      const map = new Map<string, TerminalStatusInfo>();
      map.set("session-old", {
        sessionId: "session-old",
        status: "active",
        lastOutputAt: now - 31000, // 超过 30 秒
      });
      map.set("session-recent", {
        sessionId: "session-recent",
        status: "active",
        lastOutputAt: now - 5000, // 5 秒前，未超时
      });
      map.set("session-idle", {
        sessionId: "session-idle",
        status: "idle",
        lastOutputAt: now - 60000, // 已经是 idle，不变
      });
      useTerminalStatusStore.setState({ statusMap: map });

      // 推进定时器 5s（interval 周期）
      vi.advanceTimersByTime(5000);

      const updatedMap = useTerminalStatusStore.getState().statusMap;
      expect(updatedMap.get("session-old")?.status).toBe("idle");
      expect(updatedMap.get("session-recent")?.status).toBe("active");
      expect(updatedMap.get("session-idle")?.status).toBe("idle");
    });
  });

  describe("cleanup", () => {
    it("应清除 unlisten 和 interval", async () => {
      const mockUnlisten = vi.fn();
      vi.mocked(getCurrentWebview().listen).mockResolvedValue(mockUnlisten);

      await useTerminalStatusStore.getState().init();
      useTerminalStatusStore.getState().cleanup();

      expect(mockUnlisten).toHaveBeenCalled();
      const state = useTerminalStatusStore.getState();
      expect(state._unlisten).toBeNull();
      expect(state._idleCheckInterval).toBeNull();
      expect(state._initialized).toBe(false);
    });

    it("未初始化时 cleanup 不应出错", () => {
      useTerminalStatusStore.getState().cleanup();
      // 不抛异常即可
      expect(useTerminalStatusStore.getState()._initialized).toBe(false);
    });
  });
});
