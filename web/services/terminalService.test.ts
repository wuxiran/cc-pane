import { beforeEach, describe, expect, it } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { terminalService } from "./terminalService";
import { mockTauriInvoke, resetTauriInvoke } from "@/test/utils/mockTauriInvoke";

describe("terminalService", () => {
  beforeEach(() => {
    resetTauriInvoke();
  });

  describe("createSession", () => {
    it("calls create_terminal_session with a request object", async () => {
      mockTauriInvoke({ create_terminal_session: "session-1" });

      const result = await terminalService.createSession({
        projectPath: "/tmp/project",
        cols: 80,
        rows: 24,
        cliTool: "claude",
      });

      expect(invoke).toHaveBeenCalledWith("create_terminal_session", {
        request: {
          projectPath: "/tmp/project",
          cols: 80,
          rows: 24,
          cliTool: "claude",
        },
      });
      expect(result).toBe("session-1");
    });

    it("rejects a null request before invoking Tauri", async () => {
      await expect(
        terminalService.createSession(null),
      ).rejects.toThrow("create_terminal_session requires a non-null request");

      expect(invoke).not.toHaveBeenCalled();
    });
  });

  describe("getReplaySnapshot", () => {
    it("calls get_terminal_replay_snapshot and returns the snapshot", async () => {
      const snapshot = {
        data: "\x1b[?1049hhello",
        bufferMode: "alternate" as const,
      };
      mockTauriInvoke({ get_terminal_replay_snapshot: snapshot });

      const result = await terminalService.getReplaySnapshot("session-1");

      expect(invoke).toHaveBeenCalledWith("get_terminal_replay_snapshot", {
        sessionId: "session-1",
      });
      expect(result).toEqual(snapshot);
    });

    it("supports sessions without a replay snapshot", async () => {
      mockTauriInvoke({ get_terminal_replay_snapshot: null });

      const result = await terminalService.getReplaySnapshot("session-2");

      expect(result).toBeNull();
    });
  });
});
