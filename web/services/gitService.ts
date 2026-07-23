import { apiGet, apiJson, invokeOrApi } from "./apiClient";
import type { DiffResult } from "./localHistoryService";

export type GitRepoState = "ok" | "pathNotFound" | "notARepo" | "gitError";

export interface GitRepoInfo {
  state: GitRepoState;
  repoRoot: string | null;
  branch: string | null;
  hasChanges: boolean | null;
  message?: string | null;
}

export type GitChangeStatus =
  | "modified"
  | "added"
  | "deleted"
  | "untracked"
  | "renamed"
  | "copied"
  | "typeChanged"
  | "conflicted";

export interface GitChangedFile {
  status: GitChangeStatus;
  oldPath: string | null;
  newPath: string | null;
  oldMode: string | null;
  newMode: string | null;
}

export interface GitCommit {
  hash: string;
  shortHash: string;
  author: string;
  authorEmail: string;
  date: string;
  subject: string;
  refs: string;
  parents: string[];
}

export interface GitLogQuery {
  limit: number;
  offset: number;
  branch?: string;
  file?: string;
}

export interface GitLogPage {
  commits: GitCommit[];
  hasMore: boolean;
  nextOffset: number | null;
}

export type GitDiffSpec =
  | { mode: "worktreeVsHead"; file: GitChangedFile }
  | { mode: "commitVsCommit"; oldRev: string; newRev: string; file: GitChangedFile }
  | { mode: "commitVsParent"; commit: string; parentIndex?: number | null; file: GitChangedFile };

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

  getLog(path: string, query: GitLogQuery): Promise<GitLogPage> {
    return invokeOrApi<GitLogPage>("get_git_log", { path, query }, () =>
      apiGet<GitLogPage>("/api/git/log", {
        path,
        limit: query.limit,
        offset: query.offset,
        branch: query.branch,
        file: query.file,
      }),
    );
  },

  getLocalBranches(path: string): Promise<string[]> {
    return invokeOrApi<string[]>("get_git_local_branches", { path }, () =>
      apiGet<string[]>("/api/git/branches", { path }),
    );
  },

  getChangedFiles(path: string): Promise<GitChangedFile[]> {
    return invokeOrApi<GitChangedFile[]>("get_git_changed_files", { path }, () =>
      apiGet<GitChangedFile[]>("/api/git/changed-files", { path }),
    );
  },

  listCommitFiles(path: string, commit: string, parentIndex?: number): Promise<GitChangedFile[]> {
    return invokeOrApi<GitChangedFile[]>(
      "list_git_commit_files",
      { path, commit, parentIndex },
      () => apiGet<GitChangedFile[]>("/api/git/commit-files", { path, commit, parentIndex }),
    );
  },

  getDiff(path: string, spec: GitDiffSpec): Promise<DiffResult> {
    return invokeOrApi<DiffResult>("get_git_diff", { path, spec }, () =>
      apiJson<DiffResult>("/api/git/diff", "POST", { path, spec }),
    );
  },
};
