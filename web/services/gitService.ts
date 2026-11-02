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

export interface GitBranchReview {
  baseCommit: string;
  headCommit: string;
  files: GitChangedFile[];
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

export type GitMergeState = "clean" | "merging" | "rebasing" | "cherryPicking";

export type GitConflictStageKind = "base" | "ours" | "theirs";

export interface GitConflictStage {
  kind: GitConflictStageKind;
  stage: number;
  blob: string;
  mode: string;
}

export interface GitConflictFile {
  path: string;
  absolutePath: string;
  stages: GitConflictStage[];
  isBinary: boolean;
}

export interface GitConflictSummary {
  mergeState: GitMergeState;
  hasConflicts: boolean;
  files: GitConflictFile[];
  theirsRef: string | null;
}

export interface GitConflictContent {
  content: string | null;
  size: number;
  isBinary: boolean;
  tooLarge: boolean;
}

export interface GitConflictVersions {
  path: string;
  absolutePath: string;
  base: GitConflictContent;
  ours: GitConflictContent;
  theirs: GitConflictContent;
  result: GitConflictContent;
}

export interface GitResolveConflictRequest {
  path: string;
  file: string;
  content: string;
}

export interface GitResolveConflictResult {
  path: string;
  staged: boolean;
  remainingConflicts: number;
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

  getBranchReview(path: string, baseRef: string): Promise<GitBranchReview> {
    return invokeOrApi<GitBranchReview>("get_git_branch_review", { path, baseRef }, () =>
      apiGet<GitBranchReview>("/api/git/branch-review", { path, baseRef }),
    );
  },

  listConflicts(path: string): Promise<GitConflictSummary> {
    return invokeOrApi<GitConflictSummary>("list_git_conflicts", { path }, () =>
      apiGet<GitConflictSummary>("/api/git/conflicts", { path }),
    );
  },

  getConflictVersions(path: string, file: string): Promise<GitConflictVersions> {
    return invokeOrApi<GitConflictVersions>("get_git_conflict_versions", { path, file }, () =>
      apiGet<GitConflictVersions>("/api/git/conflict-versions", { path, file }),
    );
  },

  resolveConflict(request: GitResolveConflictRequest): Promise<GitResolveConflictResult> {
    return invokeOrApi<GitResolveConflictResult>("resolve_git_conflict", { request }, () =>
      apiJson<GitResolveConflictResult>("/api/git/resolve-conflict", "POST", request),
    );
  },
};
