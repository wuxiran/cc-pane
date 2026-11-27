/**
 * GitHub 服务层 — 经本机 gh CLI（桌面端独有；Web 壳视为不可用，入口隐藏）。
 */
import { invokeIfTauri } from "./runtime";
import type { GhAvailability, GithubIssue, GithubIssueImportResult } from "@/types";

const UNAVAILABLE: GhAvailability = { installed: false, authenticated: false };

export function isGhReady(availability: GhAvailability | null | undefined): boolean {
  return Boolean(availability?.installed && availability.authenticated);
}

export const githubService = {
  /** gh 是否已安装且已登录；refresh=true 时强制重新探测 */
  async status(refresh = false): Promise<GhAvailability> {
    return (await invokeIfTauri<GhAvailability>("github_cli_status", { refresh })) ?? UNAVAILABLE;
  },

  /** 列出项目仓库的 Issue（可带 GitHub 搜索语法） */
  async listIssues(projectPath: string, query?: string): Promise<GithubIssue[]> {
    const trimmed = query?.trim();
    return (
      (await invokeIfTauri<GithubIssue[]>("github_list_issues", {
        projectPath,
        query: trimmed ? trimmed : null,
      })) ?? []
    );
  },

  /** 把选中的 Issue 导入为项目 Todo（同一 issue 只导入一次） */
  async importIssues(projectPath: string, numbers: number[]): Promise<GithubIssueImportResult[]> {
    return (
      (await invokeIfTauri<GithubIssueImportResult[]>("github_import_issues", {
        projectPath,
        numbers,
      })) ?? []
    );
  },

  /** 回复后端的 PR 合并确认请求 */
  async respondMergeConfirm(requestId: string, approved: boolean): Promise<void> {
    await invokeIfTauri<void>("respond_orchestrator_query", {
      requestId,
      data: JSON.stringify({ approved }),
    });
  },
};
