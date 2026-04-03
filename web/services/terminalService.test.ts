import { beforeEach, describe, expect, it } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { terminalService } from "./terminalService";
import { mockTauriInvoke, resetTauriInvoke } from "@/test/utils/mockTauriInvoke";

describe("terminalService", () => {
  beforeEach(() => {
    resetTauriInvoke();
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
