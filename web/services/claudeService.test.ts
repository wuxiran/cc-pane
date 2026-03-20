import { describe, it, expect, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { claudeService } from "./claudeService";
import {
  mockTauriInvoke,
  resetTauriInvoke,
} from "@/test/utils/mockTauriInvoke";

describe("claudeService", () => {
  beforeEach(() => {
    resetTauriInvoke();
  });

  describe("listSessions", () => {
    it("应该调用 list_claude_sessions 命令并返回会话列表", async () => {
      const sessions = [
        {
          id: "session-1",
          project_path: "/path/to/project",
          modified_at: 1704067200,
          file_path: "/home/user/.claude/sessions/session-1.json",
          description: "Refactoring service layer",
        },
        {
          id: "session-2",
          project_path: "/path/to/project",
          modified_at: 1704153600,
          file_path: "/home/user/.claude/sessions/session-2.json",
          description: "Adding unit tests",
        },
      ];
      mockTauriInvoke({ list_claude_sessions: sessions });

      const result = await claudeService.listSessions("/path/to/project");

      expect(invoke).toHaveBeenCalledWith("list_claude_sessions", {
        projectPath: "/path/to/project",
      });
      expect(result).toEqual(sessions);
    });

    it("应该在无会话时返回空数组", async () => {
      mockTauriInvoke({ list_claude_sessions: [] });

      const result = await claudeService.listSessions("/path/to/project");

      expect(result).toEqual([]);
    });
  });

  describe("listAllSessions", () => {
    it("应该调用 list_all_claude_sessions 命令（无参数）", async () => {
      const sessions = [
        {
          id: "session-1",
          project_path: "/path/to/project-a",
          modified_at: 1704067200,
          file_path: "/home/user/.claude/sessions/session-1.json",
          description: "Session in project A",
        },
      ];
      mockTauriInvoke({ list_all_claude_sessions: sessions });

      const result = await claudeService.listAllSessions();

      expect(invoke).toHaveBeenCalledWith("list_all_claude_sessions");
      expect(result).toEqual(sessions);
    });
  });

  describe("scanBrokenSessions", () => {
    it("应该调用 scan_broken_sessions 并传递 projectPath", async () => {
      const brokenSessions = [
        {
          id: "broken-1",
          file_path: "/home/user/.claude/sessions/broken-1.json",
          project_path: "/path/to/project",
          thinking_blocks: 3,
          file_size: 102400,
        },
      ];
      mockTauriInvoke({ scan_broken_sessions: brokenSessions });

      const result = await claudeService.scanBrokenSessions(
        "/path/to/project"
      );

      expect(invoke).toHaveBeenCalledWith("scan_broken_sessions", {
        projectPath: "/path/to/project",
      });
      expect(result).toEqual(brokenSessions);
    });

    it("应该在不传 projectPath 时传递 null", async () => {
      mockTauriInvoke({ scan_broken_sessions: [] });

      const result = await claudeService.scanBrokenSessions();

      expect(invoke).toHaveBeenCalledWith("scan_broken_sessions", {
        projectPath: null,
      });
      expect(result).toEqual([]);
    });

    it("应该在 projectPath 为空字符串时传递 null", async () => {
      mockTauriInvoke({ scan_broken_sessions: [] });

      const result = await claudeService.scanBrokenSessions("");

      expect(invoke).toHaveBeenCalledWith("scan_broken_sessions", {
        projectPath: null,
      });
      expect(result).toEqual([]);
    });
  });

  describe("cleanSessionFile", () => {
    it("应该调用 clean_session_file 命令并返回清理结果", async () => {
      const cleanResult = {
        file_path: "/home/user/.claude/sessions/broken-1.json",
        removed_blocks: 3,
        success: true,
        error: null,
      };
      mockTauriInvoke({ clean_session_file: cleanResult });

      const result = await claudeService.cleanSessionFile(
        "/home/user/.claude/sessions/broken-1.json"
      );

      expect(invoke).toHaveBeenCalledWith("clean_session_file", {
        filePath: "/home/user/.claude/sessions/broken-1.json",
      });
      expect(result).toEqual(cleanResult);
    });

    it("应该在清理失败时返回包含错误信息的结果", async () => {
      const cleanResult = {
        file_path: "/home/user/.claude/sessions/broken-1.json",
        removed_blocks: 0,
        success: false,
        error: "Permission denied",
      };
      mockTauriInvoke({ clean_session_file: cleanResult });

      const result = await claudeService.cleanSessionFile(
        "/home/user/.claude/sessions/broken-1.json"
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe("Permission denied");
    });
  });

  describe("cleanAllBrokenSessions", () => {
    it("应该调用 clean_all_broken_sessions 并传递 projectPath", async () => {
      const results = [
        {
          file_path: "/home/user/.claude/sessions/broken-1.json",
          removed_blocks: 2,
          success: true,
          error: null,
        },
        {
          file_path: "/home/user/.claude/sessions/broken-2.json",
          removed_blocks: 5,
          success: true,
          error: null,
        },
      ];
      mockTauriInvoke({ clean_all_broken_sessions: results });

      const result = await claudeService.cleanAllBrokenSessions(
        "/path/to/project"
      );

      expect(invoke).toHaveBeenCalledWith("clean_all_broken_sessions", {
        projectPath: "/path/to/project",
      });
      expect(result).toEqual(results);
    });

    it("应该在不传 projectPath 时传递 null", async () => {
      mockTauriInvoke({ clean_all_broken_sessions: [] });

      const result = await claudeService.cleanAllBrokenSessions();

      expect(invoke).toHaveBeenCalledWith("clean_all_broken_sessions", {
        projectPath: null,
      });
      expect(result).toEqual([]);
    });

    it("应该在 projectPath 为空字符串时传递 null", async () => {
      mockTauriInvoke({ clean_all_broken_sessions: [] });

      const result = await claudeService.cleanAllBrokenSessions("");

      expect(invoke).toHaveBeenCalledWith("clean_all_broken_sessions", {
        projectPath: null,
      });
      expect(result).toEqual([]);
    });
  });
});
