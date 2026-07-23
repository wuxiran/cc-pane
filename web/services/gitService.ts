import { apiGet, invokeOrApi } from "./apiClient";

export type GitRepoState = "ok" | "pathNotFound" | "notARepo" | "gitError";

export interface GitRepoInfo {
  state: GitRepoState;
  repoRoot: string | null;
  branch: string | null;
  hasChanges: boolean | null;
  message?: string | null;
}

export const gitService = {
  getRepoInfo(path: string): Promise<GitRepoInfo> {
    return invokeOrApi<GitRepoInfo>("get_git_repo_info", { path }, () =>
      apiGet<GitRepoInfo>("/api/git/repo-info", { path }),
    );
  },

  getFileStatuses(path: string): Promise<Record<string, string>> {
    return invokeOrApi<Record<string, string>>("get_git_file_statuses", { path }, () =>
      apiGet<Record<string, string>>("/api/git/file-statuses", { path }),
    );
  },
};
