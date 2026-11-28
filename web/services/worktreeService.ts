import { apiGet, apiJson, apiNoContent, invokeOrApi } from "./apiClient";

export interface WorktreeInfo {
  path: string;
  branch: string;
  commit: string;
  isMain: boolean;
}

/** `.ccpanes/worktree.json` 应用后的 setup 计划（与 Rust `WorktreeSetupPlan` 对齐） */
export interface WorktreeSetupPlan {
  projectPath: string;
  worktreePath: string;
  setup: string[];
  commandLine: string;
  configHash: string;
  alwaysAllowed: boolean;
  copiedFiles: string[];
  sparseApplied: boolean;
  warnings: string[];
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
    branch?: string,
    baseRef?: string,
    preserveCwd?: boolean,
  ): Promise<string> {
    const launchOptions = { ...(baseRef ? { baseRef } : {}), ...(preserveCwd ? { preserveCwd } : {}) };
    return invokeOrApi<string>("add_worktree", { projectPath, name, branch, ...launchOptions }, () =>
      apiJson<string>("/api/worktrees", "POST", {
        projectPath,
        name,
        branch: branch ?? null,
        ...launchOptions,
      }),
    );
  },

  /**
   * 新 worktree 建好后：应用 copyFiles / sparseCheckout，返回 setup 计划（不执行命令）。
   * Web 模式没有对应路由，直接返回 null（不做 setup）。
   */
  async prepareSetup(worktreePath: string): Promise<WorktreeSetupPlan | null> {
    return invokeOrApi<WorktreeSetupPlan | null>("prepare_worktree_setup", { worktreePath }, () =>
      Promise.resolve(null),
    );
  },

  /** 记「始终允许」：按 项目 + 配置 hash */
  async approveSetup(projectPath: string, configHash: string): Promise<void> {
    return invokeOrApi<void>("approve_worktree_setup", { projectPath, configHash }, () =>
      Promise.reject(new Error("Worktree setup approval requires the desktop app")),
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
