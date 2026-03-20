import { describe, it, expect, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { worktreeService } from "./worktreeService";
import {
  mockTauriInvoke,
  resetTauriInvoke,
} from "@/test/utils/mockTauriInvoke";

describe("worktreeService", () => {
  beforeEach(() => {
    resetTauriInvoke();
  });

  describe("isGitRepo", () => {
    it("应该调用 is_git_repo 命令并返回 true", async () => {
      mockTauriInvoke({ is_git_repo: true });

      const result = await worktreeService.isGitRepo("/path/to/project");

      expect(invoke).toHaveBeenCalledWith("is_git_repo", {
        projectPath: "/path/to/project",
      });
      expect(result).toBe(true);
    });

    it("应该在非 Git 仓库时返回 false", async () => {
      mockTauriInvoke({ is_git_repo: false });

      const result = await worktreeService.isGitRepo("/path/to/non-git");

      expect(result).toBe(false);
    });
  });

  describe("list", () => {
    it("应该调用 list_worktrees 命令并返回 worktree 列表", async () => {
      const worktrees = [
        {
          path: "/path/to/project",
          branch: "main",
          commit: "abc1234",
          isMain: true,
        },
        {
          path: "/path/to/project-feature",
          branch: "feature/login",
          commit: "def5678",
          isMain: false,
        },
      ];
      mockTauriInvoke({ list_worktrees: worktrees });

      const result = await worktreeService.list("/path/to/project");

      expect(invoke).toHaveBeenCalledWith("list_worktrees", {
        projectPath: "/path/to/project",
      });
      expect(result).toEqual(worktrees);
    });

    it("应该在无 worktree 时返回空数组", async () => {
      mockTauriInvoke({ list_worktrees: [] });

      const result = await worktreeService.list("/path/to/project");

      expect(result).toEqual([]);
    });
  });

  describe("add", () => {
    it("应该调用 add_worktree 命令并传递 branch 参数", async () => {
      mockTauriInvoke({ add_worktree: "/path/to/project-feature" });

      const result = await worktreeService.add(
        "/path/to/project",
        "feature",
        "feature/login"
      );

      expect(invoke).toHaveBeenCalledWith("add_worktree", {
        projectPath: "/path/to/project",
        name: "feature",
        branch: "feature/login",
      });
      expect(result).toBe("/path/to/project-feature");
    });

    it("应该在不指定 branch 时传递 undefined", async () => {
      mockTauriInvoke({ add_worktree: "/path/to/project-new" });

      const result = await worktreeService.add("/path/to/project", "new");

      expect(invoke).toHaveBeenCalledWith("add_worktree", {
        projectPath: "/path/to/project",
        name: "new",
        branch: undefined,
      });
      expect(result).toBe("/path/to/project-new");
    });
  });

  describe("remove", () => {
    it("应该调用 remove_worktree 命令", async () => {
      mockTauriInvoke({ remove_worktree: undefined });

      await worktreeService.remove(
        "/path/to/project",
        "/path/to/project-feature"
      );

      expect(invoke).toHaveBeenCalledWith("remove_worktree", {
        projectPath: "/path/to/project",
        worktreePath: "/path/to/project-feature",
      });
    });
  });
});
