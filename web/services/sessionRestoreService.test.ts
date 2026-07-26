import { describe, it, expect, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { sessionRestoreService } from "./sessionRestoreService";
import {
  mockTauriInvoke,
  resetTauriInvoke,
} from "@/test/utils/mockTauriInvoke";
import type { SavedSession } from "@/types";

describe("sessionRestoreService", () => {
  beforeEach(() => {
    resetTauriInvoke();
  });

  describe("save", () => {
    it("应该调用 save_terminal_sessions 并传递会话列表", async () => {
      const sessions = [{ sessionId: "s-1" }] as unknown as SavedSession[];
      mockTauriInvoke({ save_terminal_sessions: undefined });

      await sessionRestoreService.save(sessions);

      expect(invoke).toHaveBeenCalledWith("save_terminal_sessions", { sessions });
    });
  });

  describe("load", () => {
    it("应该调用 load_terminal_sessions 并返回会话列表", async () => {
      const sessions = [{ sessionId: "s-1" }, { sessionId: "s-2" }];
      mockTauriInvoke({ load_terminal_sessions: sessions });

      const result = await sessionRestoreService.load();

      expect(invoke).toHaveBeenCalledWith("load_terminal_sessions");
      expect(result).toEqual(sessions);
    });
  });

  describe("clear", () => {
    it("应该调用 clear_terminal_sessions", async () => {
      mockTauriInvoke({ clear_terminal_sessions: undefined });

      await sessionRestoreService.clear();

      expect(invoke).toHaveBeenCalledWith("clear_terminal_sessions");
    });
  });

  describe("loadOutput", () => {
    it("应该调用 load_session_output 并返回输出行", async () => {
      mockTauriInvoke({ load_session_output: ["line1", "line2"] });

      const result = await sessionRestoreService.loadOutput("s-1");

      expect(invoke).toHaveBeenCalledWith("load_session_output", {
        sessionId: "s-1",
      });
      expect(result).toEqual(["line1", "line2"]);
    });

    it("应该在无输出文件时返回 null", async () => {
      mockTauriInvoke({ load_session_output: null });

      const result = await sessionRestoreService.loadOutput("s-x");

      expect(result).toBeNull();
    });
  });

  describe("clearOutput", () => {
    it("应该调用 clear_session_output", async () => {
      mockTauriInvoke({ clear_session_output: undefined });

      await sessionRestoreService.clearOutput("s-1");

      expect(invoke).toHaveBeenCalledWith("clear_session_output", {
        sessionId: "s-1",
      });
    });
  });

  describe("prune", () => {
    it("只把完整 daemon generation 快照交给后端剪枝", async () => {
      mockTauriInvoke({ prune_terminal_sessions: 3 });

      const deleted = await sessionRestoreService.prune(42, 1234, ["s-1", "s-2"]);

      expect(invoke).toHaveBeenCalledWith("prune_terminal_sessions", {
        daemonGeneration: 42,
        capturedAtMs: 1234,
        liveSessionIds: ["s-1", "s-2"],
      });
      expect(deleted).toBe(3);
    });
  });
});
