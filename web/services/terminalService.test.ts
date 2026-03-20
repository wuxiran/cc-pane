import { describe, it, expect, beforeEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { terminalService, _resetListenersForTest } from "./terminalService";
import {
  mockTauriInvoke,
  resetTauriInvoke,
} from "@/test/utils/mockTauriInvoke";
import { resetTestDataCounter } from "@/test/utils/testData";
import type { CreateSessionRequest, ResizeRequest } from "@/types";

describe("terminalService", () => {
  beforeEach(() => {
    resetTauriInvoke();
    resetTestDataCounter();
    _resetListenersForTest();
    vi.mocked(getCurrentWebview().listen).mockReset();
  });

  describe("createSession", () => {
    it("应该调用 create_terminal_session 命令并返回会话 ID", async () => {
      const request: CreateSessionRequest = {
        projectPath: "/tmp/project",
        cols: 80,
        rows: 24,
      };
      mockTauriInvoke({ create_terminal_session: "session-123" });

      const result = await terminalService.createSession(request);

      expect(invoke).toHaveBeenCalledWith("create_terminal_session", {
        request,
      });
      expect(result).toBe("session-123");
    });
  });

  describe("write", () => {
    it("应该调用 write_terminal 命令", async () => {
      mockTauriInvoke({ write_terminal: undefined });

      await terminalService.write("sid-1", "ls -la\n");

      expect(invoke).toHaveBeenCalledWith("write_terminal", {
        sessionId: "sid-1",
        data: "ls -la\n",
      });
    });
  });

  describe("resize", () => {
    it("应该调用 resize_terminal 命令", async () => {
      const request: ResizeRequest = {
        sessionId: "sid-1",
        cols: 120,
        rows: 40,
      };
      mockTauriInvoke({ resize_terminal: undefined });

      await terminalService.resize(request);

      expect(invoke).toHaveBeenCalledWith("resize_terminal", { request });
    });
  });

  describe("kill", () => {
    it("应该调用 kill_terminal 命令", async () => {
      mockTauriInvoke({ kill_terminal: undefined });

      await terminalService.kill("sid-1");

      expect(invoke).toHaveBeenCalledWith("kill_terminal", {
        sessionId: "sid-1",
      });
    });
  });

  // ── 单例监听器 API ──────────────────────────────────

  describe("registerOutput / unregisterOutput", () => {
    it("应该注册全局 listener 并通过 sessionId 分发回调", async () => {
      // 捕获 listen 注册的 handler
      let capturedHandler: ((event: { payload: { sessionId: string; data: string } }) => void) | null = null;
      vi.mocked(getCurrentWebview().listen).mockImplementation(async (event, handler) => {
        if (event === "terminal-output") {
          capturedHandler = handler as unknown as typeof capturedHandler;
        }
        return (() => {}) as never;
      });

      const callback = vi.fn();
      await terminalService.registerOutput("sid-1", callback);

      expect(capturedHandler).not.toBeNull();

      // 模拟事件
      capturedHandler!({ payload: { sessionId: "sid-1", data: "hello" } });
      expect(callback).toHaveBeenCalledWith("hello");
    });

    it("同一 sessionId 重复注册应覆盖旧回调", async () => {
      let capturedHandler: ((event: { payload: { sessionId: string; data: string } }) => void) | null = null;
      vi.mocked(getCurrentWebview().listen).mockImplementation(async (event, handler) => {
        if (event === "terminal-output") {
          capturedHandler = handler as unknown as typeof capturedHandler;
        }
        return (() => {}) as never;
      });

      const callback1 = vi.fn();
      const callback2 = vi.fn();
      await terminalService.registerOutput("sid-1", callback1);
      await terminalService.registerOutput("sid-1", callback2);

      capturedHandler!({ payload: { sessionId: "sid-1", data: "test" } });

      expect(callback1).not.toHaveBeenCalled();
      expect(callback2).toHaveBeenCalledWith("test");
    });

    it("不同 sessionId 的回调应独立分发", async () => {
      let capturedHandler: ((event: { payload: { sessionId: string; data: string } }) => void) | null = null;
      vi.mocked(getCurrentWebview().listen).mockImplementation(async (event, handler) => {
        if (event === "terminal-output") {
          capturedHandler = handler as unknown as typeof capturedHandler;
        }
        return (() => {}) as never;
      });

      const cb1 = vi.fn();
      const cb2 = vi.fn();
      await terminalService.registerOutput("sid-1", cb1);
      await terminalService.registerOutput("sid-2", cb2);

      capturedHandler!({ payload: { sessionId: "sid-1", data: "data1" } });
      capturedHandler!({ payload: { sessionId: "sid-2", data: "data2" } });

      expect(cb1).toHaveBeenCalledWith("data1");
      expect(cb2).toHaveBeenCalledWith("data2");
    });

    it("unregisterOutput 后不应再收到回调", async () => {
      let capturedHandler: ((event: { payload: { sessionId: string; data: string } }) => void) | null = null;
      vi.mocked(getCurrentWebview().listen).mockImplementation(async (event, handler) => {
        if (event === "terminal-output") {
          capturedHandler = handler as unknown as typeof capturedHandler;
        }
        return (() => {}) as never;
      });

      const callback = vi.fn();
      await terminalService.registerOutput("sid-1", callback);
      terminalService.unregisterOutput("sid-1");

      capturedHandler!({ payload: { sessionId: "sid-1", data: "ignored" } });
      expect(callback).not.toHaveBeenCalled();
    });

    it("ensureListeners 只初始化一次", async () => {
      vi.mocked(getCurrentWebview().listen).mockResolvedValue((() => {}) as never);

      await terminalService.registerOutput("sid-1", vi.fn());
      await terminalService.registerOutput("sid-2", vi.fn());

      // listen 应只被调用 2 次（terminal-output + terminal-exit），而非 4 次
      expect(getCurrentWebview().listen).toHaveBeenCalledTimes(2);
    });
  });

  describe("registerExit / unregisterExit", () => {
    it("应该通过 sessionId 分发退出回调", async () => {
      let capturedHandler: ((event: { payload: { sessionId: string; exitCode: number } }) => void) | null = null;
      vi.mocked(getCurrentWebview().listen).mockImplementation(async (event, handler) => {
        if (event === "terminal-exit") {
          capturedHandler = handler as unknown as typeof capturedHandler;
        }
        return (() => {}) as never;
      });

      const callback = vi.fn();
      await terminalService.registerExit("sid-1", callback);

      capturedHandler!({ payload: { sessionId: "sid-1", exitCode: 0 } });
      expect(callback).toHaveBeenCalledWith(0);
    });

    it("unregisterExit 后不应再收到回调", async () => {
      let capturedHandler: ((event: { payload: { sessionId: string; exitCode: number } }) => void) | null = null;
      vi.mocked(getCurrentWebview().listen).mockImplementation(async (event, handler) => {
        if (event === "terminal-exit") {
          capturedHandler = handler as unknown as typeof capturedHandler;
        }
        return (() => {}) as never;
      });

      const callback = vi.fn();
      await terminalService.registerExit("sid-1", callback);
      terminalService.unregisterExit("sid-1");

      capturedHandler!({ payload: { sessionId: "sid-1", exitCode: 1 } });
      expect(callback).not.toHaveBeenCalled();
    });
  });
});
