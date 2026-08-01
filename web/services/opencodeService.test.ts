import { describe, expect, it, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { opencodeService } from "./opencodeService";
import {
  mockTauriInvoke,
  resetTauriInvoke,
} from "@/test/utils/mockTauriInvoke";

describe("opencodeService", () => {
  beforeEach(() => {
    resetTauriInvoke();
  });

  it("调用 list_opencode_sessions 并返回会话列表", async () => {
    const sessions = [
      {
        id: "ses_123",
        project_path: "/path/to/project",
        modified_at: 1785000000,
        file_path: "/home/user/.local/share/opencode/opencode.db#session:ses_123",
        description: "Implement OpenCode support",
      },
    ];
    mockTauriInvoke({ list_opencode_sessions: sessions });

    const result = await opencodeService.listSessions(
      "/path/to/project",
      "local",
    );

    expect(invoke).toHaveBeenCalledWith("list_opencode_sessions", {
      projectPath: "/path/to/project",
      runtimeKind: "local",
      wslDistro: undefined,
    });
    expect(result).toEqual(sessions);
  });
});
