import { describe, it, expect, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { historyService } from "./historyService";
import {
  mockTauriInvoke,
  resetTauriInvoke,
} from "@/test/utils/mockTauriInvoke";

describe("historyService", () => {
  beforeEach(() => {
    resetTauriInvoke();
  });

  describe("add", () => {
    it("应该调用 add_launch_history 命令并传递正确参数", async () => {
      mockTauriInvoke({ add_launch_history: undefined });

      await historyService.add("proj-1", "My Project", "/path/to/project", "claude", "local");

      expect(invoke).toHaveBeenCalledWith("add_launch_history", {
        projectId: "proj-1",
        projectName: "My Project",
        projectPath: "/path/to/project",
        cliTool: "claude",
        runtimeKind: "local",
        wslDistro: null,
        workspaceName: null,
        workspacePath: null,
        launchCwd: null,
        providerId: null,
        providerSelection: null,
        launchProfileId: null,
        workspaceSnapshotId: null,
      });
    });
  });

  describe("list", () => {
    it("应该调用 list_launch_history 命令并使用默认 limit=20", async () => {
      const records = [
        {
          id: 1,
          projectId: "proj-1",
          projectName: "Project 1",
          projectPath: "/path/1",
          launchedAt: "2024-01-01T00:00:00Z",
        },
      ];
      mockTauriInvoke({ list_launch_history: records });

      const result = await historyService.list();

      expect(invoke).toHaveBeenCalledWith("list_launch_history", { limit: 20 });
      expect(result).toEqual(records);
    });

    it("应该支持自定义 limit 参数", async () => {
      mockTauriInvoke({ list_launch_history: [] });

      const result = await historyService.list(50);

      expect(invoke).toHaveBeenCalledWith("list_launch_history", { limit: 50 });
      expect(result).toEqual([]);
    });

    it("应该在空列表时返回空数组", async () => {
      mockTauriInvoke({ list_launch_history: [] });

      const result = await historyService.list();

      expect(result).toEqual([]);
    });
  });

  describe("clear", () => {
    it("应该调用 clear_launch_history 命令", async () => {
      mockTauriInvoke({ clear_launch_history: undefined });

      await historyService.clear();

      expect(invoke).toHaveBeenCalledWith("clear_launch_history");
    });
  });

  describe("resume 相关命令", () => {
    it("应该调用 detect_resume_session 并传递运行环境参数", async () => {
      mockTauriInvoke({ detect_resume_session: "resume-123" });

      const result = await historyService.detectResumeSession(
        "codex",
        "wsl",
        "Ubuntu",
        "/project/path",
        "/workspace/path",
        "2026-04-20T00:00:00.000Z",
      );

      expect(invoke).toHaveBeenCalledWith("detect_resume_session", {
        cliTool: "codex",
        runtimeKind: "wsl",
        wslDistro: "Ubuntu",
        projectPath: "/project/path",
        workspacePath: "/workspace/path",
        afterTs: "2026-04-20T00:00:00.000Z",
      });
      expect(result).toBe("resume-123");
    });

    it("应该调用 start_launch_history_backfill 并传递 PTY 与 launch 元数据", async () => {
      mockTauriInvoke({ start_launch_history_backfill: undefined });

      await historyService.startLaunchHistoryBackfill(
        "launch-1",
        "pty-1",
        "claude",
        "local",
        undefined,
        "/project/path",
        "/workspace/path",
        "2026-04-20T00:00:00.000Z",
      );

      expect(invoke).toHaveBeenCalledWith("start_launch_history_backfill", {
        launchId: "launch-1",
        ptySessionId: "pty-1",
        cliTool: "claude",
        runtimeKind: "local",
        wslDistro: null,
        projectPath: "/project/path",
        workspacePath: "/workspace/path",
        afterTs: "2026-04-20T00:00:00.000Z",
      });
    });
  });
});
