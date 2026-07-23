import { apiDelete, apiGet, apiJson, apiNoContent, invokeOrApi } from "./apiClient";
import { invokeIfTauri } from "./runtime";

export interface FileVersion {
  id: string;
  filePath: string;
  hash: string;
  size: number;
  createdAt: string;
  isDeleted: boolean;
  branch: string;
}

export interface HistoryConfig {
  enabled: boolean;
  ignorePatterns: string[];
  maxVersionsPerFile: number;
  maxAgeDays: number;
  maxFileSize: number;
  maxTotalSize: number;
  minSaveIntervalSecs: number;
}

// ============ Diff 类型 ============

export type DiffChangeType = "equal" | "insert" | "delete" | "replace";

export interface InlineChange {
  start: number;
  end: number;
  changeType: DiffChangeType;
}

export interface DiffLine {
  changeType: DiffChangeType;
  content: string;
  oldLineNo: number | null;
  newLineNo: number | null;
  inlineChanges: InlineChange[] | null;
}

export interface DiffStats {
  additions: number;
  deletions: number;
  changes: number;
}

export interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

export interface DiffResult {
  hunks: DiffHunk[];
  stats: DiffStats;
  isBinary: boolean;
  truncated: boolean;
}

// ============ 标签类型 ============

export interface LabelFileSnapshot {
  filePath: string;
  versionId: string;
}

export interface HistoryLabel {
  id: string;
  name: string;
  labelType: string;
  source: string;
  timestamp: string;
  fileSnapshots: LabelFileSnapshot[];
  branch: string;
}

// ============ 最近更改类型 ============

export interface RecentChange {
  filePath: string;
  versionId: string;
  timestamp: string;
  size: number;
  hash: string;
  labelName: string | null;
  branch: string;
}

export interface WorktreeRecentChange {
  worktreePath: string;
  worktreeBranch: string;
  isMain: boolean;
  change: RecentChange;
}

export interface HistoryWatchStats {
  watchingProjects: number;
  sessionCount: number;
}

export const localHistoryService = {
  // ============ 基础操作 ============

  async initProjectHistory(projectPath: string): Promise<void> {
    await invokeOrApi<void>("init_project_history", { projectPath }, () =>
      apiJson<void>("/api/local-history/init", "POST", { projectPath }),
    );
  },

  async getHistoryWatchStats(): Promise<HistoryWatchStats | null> {
    return (await invokeIfTauri<HistoryWatchStats>("get_history_watch_stats")) ?? null;
  },

  async listFileVersions(projectPath: string, filePath: string): Promise<FileVersion[]> {
    return invokeOrApi<FileVersion[]>("list_file_versions", { projectPath, filePath }, () =>
      apiGet<FileVersion[]>("/api/local-history/files/versions", { projectPath, filePath }),
    );
  },

  async getVersionContent(projectPath: string, filePath: string, versionId: string): Promise<string> {
    return invokeOrApi<string>("get_version_content", { projectPath, filePath, versionId }, () =>
      apiGet<string>("/api/local-history/files/content", { projectPath, filePath, versionId }),
    );
  },

  async restoreFileVersion(projectPath: string, filePath: string, versionId: string): Promise<void> {
    await invokeOrApi<void>("restore_file_version", { projectPath, filePath, versionId }, () =>
      apiJson<void>("/api/local-history/files/restore", "POST", { projectPath, filePath, versionId }),
    );
  },

  async getHistoryConfig(projectPath: string): Promise<HistoryConfig> {
    return invokeOrApi<HistoryConfig>("get_history_config", { projectPath }, () =>
      apiGet<HistoryConfig>("/api/local-history/config", { projectPath }),
    );
  },

  async updateHistoryConfig(projectPath: string, config: HistoryConfig): Promise<void> {
    await invokeOrApi<void>("update_history_config", { projectPath, config }, () =>
      apiNoContent("/api/local-history/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectPath, config }),
      }),
    );
  },

  async stopProjectHistory(projectPath: string): Promise<void> {
    await invokeOrApi<void>("stop_project_history", { projectPath }, () =>
      apiJson<void>("/api/local-history/stop", "POST", { projectPath }),
    );
  },

  async cleanupProjectHistory(projectPath: string): Promise<void> {
    await invokeOrApi<void>("cleanup_project_history", { projectPath }, () =>
      apiJson<void>("/api/local-history/cleanup", "POST", { projectPath }),
    );
  },

  // ============ Diff API ============

  async getVersionDiff(projectPath: string, filePath: string, versionId: string): Promise<DiffResult> {
    return invokeOrApi<DiffResult>("get_version_diff", { projectPath, filePath, versionId }, () =>
      apiGet<DiffResult>("/api/local-history/files/diff", { projectPath, filePath, versionId }),
    );
  },

  async getVersionsDiff(projectPath: string, filePath: string, oldVersionId: string, newVersionId: string): Promise<DiffResult> {
    return invokeOrApi<DiffResult>(
      "get_versions_diff",
      { projectPath, filePath, oldVersionId, newVersionId },
      () =>
        apiGet<DiffResult>("/api/local-history/files/diff-between", {
          projectPath,
          filePath,
          oldVersionId,
          newVersionId,
        }),
    );
  },

  // ============ 标签 API ============

  async putLabel(projectPath: string, label: HistoryLabel): Promise<void> {
    await invokeOrApi<void>("put_label", { projectPath, label }, () =>
      apiJson<void>("/api/local-history/labels", "PUT", { projectPath, label }),
    );
  },

  async listLabels(projectPath: string): Promise<HistoryLabel[]> {
    return invokeOrApi<HistoryLabel[]>("list_labels", { projectPath }, () =>
      apiGet<HistoryLabel[]>("/api/local-history/labels", { projectPath }),
    );
  },

  async deleteLabel(projectPath: string, labelId: string): Promise<void> {
    await invokeOrApi<void>("delete_label", { projectPath, labelId }, () =>
      apiDelete(`/api/local-history/labels?projectPath=${encodeURIComponent(projectPath)}&labelId=${encodeURIComponent(labelId)}`),
    );
  },

  async restoreToLabel(projectPath: string, labelId: string): Promise<string[]> {
    return invokeOrApi<string[]>("restore_to_label", { projectPath, labelId }, () =>
      apiJson<string[]>("/api/local-history/labels/restore", "POST", { projectPath, labelId }),
    );
  },

  async createAutoLabel(projectPath: string, name: string, source: string): Promise<string> {
    return invokeOrApi<string>("create_auto_label", { projectPath, name, source }, () =>
      apiJson<string>("/api/local-history/labels/auto", "POST", { projectPath, name, source }),
    );
  },

  // ============ 目录级历史 + 最近更改 ============

  async listDirectoryChanges(projectPath: string, dirPath: string, since?: string): Promise<FileVersion[]> {
    return invokeOrApi<FileVersion[]>("list_directory_changes", { projectPath, dirPath, since }, () =>
      apiGet<FileVersion[]>("/api/local-history/directory-changes", { projectPath, dirPath, since }),
    );
  },

  async getRecentChanges(projectPath: string, limit?: number): Promise<RecentChange[]> {
    return invokeOrApi<RecentChange[]>("get_recent_changes", { projectPath, limit }, () =>
      apiGet<RecentChange[]>("/api/local-history/recent-changes", { projectPath, limit }),
    );
  },

  // ============ 删除文件恢复 ============

  async listDeletedFiles(projectPath: string): Promise<FileVersion[]> {
    return invokeOrApi<FileVersion[]>("list_deleted_files", { projectPath }, () =>
      apiGet<FileVersion[]>("/api/local-history/deleted-files", { projectPath }),
    );
  },

  // ============ 压缩 ============

  async compressHistory(projectPath: string): Promise<number> {
    return invokeOrApi<number>("compress_history", { projectPath }, () =>
      apiJson<number>("/api/local-history/compress", "POST", { projectPath }),
    );
  },

  // ============ 分支感知 + Worktree ============

  async getCurrentBranch(projectPath: string): Promise<string> {
    return invokeOrApi<string>("get_current_branch", { projectPath }, () =>
      apiGet<string>("/api/local-history/current-branch", { projectPath }),
    );
  },

  async getFileBranches(projectPath: string, filePath: string): Promise<string[]> {
    return invokeOrApi<string[]>("get_file_branches", { projectPath, filePath }, () =>
      apiGet<string[]>("/api/local-history/file-branches", { projectPath, filePath }),
    );
  },

  async listVersionsByBranch(projectPath: string, filePath: string, branch: string): Promise<FileVersion[]> {
    return invokeOrApi<FileVersion[]>("list_file_versions_by_branch", { projectPath, filePath, branch }, () =>
      apiGet<FileVersion[]>("/api/local-history/file-versions-by-branch", { projectPath, filePath, branch }),
    );
  },

  async listWorktreeRecentChanges(projectPath: string, limit?: number): Promise<WorktreeRecentChange[]> {
    return invokeOrApi<WorktreeRecentChange[]>("list_worktree_recent_changes", { projectPath, limit }, () =>
      apiGet<WorktreeRecentChange[]>("/api/local-history/worktree-recent-changes", { projectPath, limit }),
    );
  },
};
