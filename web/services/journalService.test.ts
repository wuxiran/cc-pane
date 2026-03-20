import { describe, it, expect, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { journalService } from "./journalService";
import {
  mockTauriInvoke,
  resetTauriInvoke,
} from "@/test/utils/mockTauriInvoke";

describe("journalService", () => {
  beforeEach(() => {
    resetTauriInvoke();
  });

  describe("addSession", () => {
    it("应该调用 add_journal_session 命令并使用默认 commits=[]", async () => {
      mockTauriInvoke({ add_journal_session: 1 });

      const result = await journalService.addSession(
        "my-workspace",
        "Session Title",
        "Session summary content"
      );

      expect(invoke).toHaveBeenCalledWith("add_journal_session", {
        workspaceName: "my-workspace",
        title: "Session Title",
        summary: "Session summary content",
        commits: [],
      });
      expect(result).toBe(1);
    });

    it("应该支持自定义 commits 参数", async () => {
      mockTauriInvoke({ add_journal_session: 5 });
      const commits = ["abc1234", "def5678"];

      const result = await journalService.addSession(
        "my-workspace",
        "Session Title",
        "Session summary",
        commits
      );

      expect(invoke).toHaveBeenCalledWith("add_journal_session", {
        workspaceName: "my-workspace",
        title: "Session Title",
        summary: "Session summary",
        commits: ["abc1234", "def5678"],
      });
      expect(result).toBe(5);
    });
  });

  describe("getIndex", () => {
    it("应该调用 get_journal_index 命令并返回 JournalIndex 结构", async () => {
      const index = {
        activeFile: "journal-2024-01.md",
        totalSessions: 42,
        lastActive: "2024-01-15T10:30:00Z",
      };
      mockTauriInvoke({ get_journal_index: index });

      const result = await journalService.getIndex("my-workspace");

      expect(invoke).toHaveBeenCalledWith("get_journal_index", {
        workspaceName: "my-workspace",
      });
      expect(result).toEqual(index);
    });
  });

  describe("getRecentJournal", () => {
    it("应该调用 get_recent_journal 命令并返回字符串内容", async () => {
      const journalContent =
        "## Session 1\n\nDid some refactoring.\n\n## Session 2\n\nFixed bugs.";
      mockTauriInvoke({ get_recent_journal: journalContent });

      const result = await journalService.getRecentJournal("my-workspace");

      expect(invoke).toHaveBeenCalledWith("get_recent_journal", {
        workspaceName: "my-workspace",
      });
      expect(result).toBe(journalContent);
    });

    it("应该在无日志时返回空字符串", async () => {
      mockTauriInvoke({ get_recent_journal: "" });

      const result = await journalService.getRecentJournal("my-workspace");

      expect(result).toBe("");
    });
  });
});
