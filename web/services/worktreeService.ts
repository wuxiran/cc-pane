import { invoke } from "@tauri-apps/api/core";

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
  /**
   * 检查项目是否为 Git 仓库
   */
  async isGitRepo(projectPath: string): Promise<boolean> {
    return invoke<boolean>("is_git_repo", { projectPath });
  },

  /**
   * 列出所有 worktree
   */
  async list(projectPath: string): Promise<WorktreeInfo[]> {
    return invoke<WorktreeInfo[]>("list_worktrees", { projectPath });
  },

  /**
   * 添加新的 worktree
   */
  async add(
    projectPath: string,
    name: string,
    branch?: string
  ): Promise<string> {
    return invoke<string>("add_worktree", { projectPath, name, branch });
  },

  /**
   * 删除 worktree
   */
  async remove(projectPath: string, worktreePath: string): Promise<void> {
    return invoke("remove_worktree", { projectPath, worktreePath });
  },
};
