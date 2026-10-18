import { apiGet, apiJson, apiNoContent, invokeOrApi } from "./apiClient";

export interface WorktreeInfo {
  path: string;
  branch: string;
  commit: string;
  isMain: boolean;
}

/**
 * Worktree 服务 - 管理 Git Worktree
 */
export const worktreeService = {
  async forkChat(cwd: string): Promise<string> {
    return invokeOrApi<string>("fork_chat_worktree", { cwd }, () =>
      apiJson<string>("/api/worktrees/fork", "POST", { cwd }),
    );
  },
  /**
   * 检查项目是否为 Git 仓库
   */
  async isGitRepo(projectPath: string): Promise<boolean> {
    return invokeOrApi<boolean>("is_git_repo", { projectPath }, () =>
      apiGet<boolean>("/api/worktrees/is-git-repo", { projectPath }),
    );
  },

  /**
   * 列出所有 worktree
   */
  async list(projectPath: string): Promise<WorktreeInfo[]> {
    return invokeOrApi<WorktreeInfo[]>("list_worktrees", { projectPath }, () =>
      apiGet<WorktreeInfo[]>("/api/worktrees", { projectPath }),
    );
  },

  /**
   * 添加新的 worktree
   */
  async add(
    projectPath: string,
    name: string,
    branch?: string
  ): Promise<string> {
    return invokeOrApi<string>("add_worktree", { projectPath, name, branch }, () =>
      apiJson<string>("/api/worktrees", "POST", {
        projectPath,
        name,
        branch: branch ?? null,
      }),
    );
  },

  /**
   * 删除 worktree
   */
  async remove(projectPath: string, worktreePath: string): Promise<void> {
    return invokeOrApi<void>("remove_worktree", { projectPath, worktreePath }, () =>
      apiNoContent("/api/worktrees", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectPath, worktreePath }),
      }),
    );
  },
};
