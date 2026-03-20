import { invoke } from "@tauri-apps/api/core";

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

export const localHistoryService = {
  // ============ 基础操作 ============

  async initProjectHistory(projectPath: string): Promise<void> {
    await invoke("init_project_history", { projectPath });
  },

  async listFileVersions(projectPath: string, filePath: string): Promise<FileVersion[]> {
    return invoke("list_file_versions", { projectPath, filePath });
  },

  async getVersionContent(projectPath: string, filePath: string, versionId: string): Promise<string> {
    return invoke("get_version_content", { projectPath, filePath, versionId });
  },

  async restoreFileVersion(projectPath: string, filePath: string, versionId: string): Promise<void> {
    await invoke("restore_file_version", { projectPath, filePath, versionId });
  },

  async getHistoryConfig(projectPath: string): Promise<HistoryConfig> {
    return invoke("get_history_config", { projectPath });
  },

  async updateHistoryConfig(projectPath: string, config: HistoryConfig): Promise<void> {
    await invoke("update_history_config", { projectPath, config });
  },

  async stopProjectHistory(projectPath: string): Promise<void> {
    await invoke("stop_project_history", { projectPath });
  },

  async cleanupProjectHistory(projectPath: string): Promise<void> {
    await invoke("cleanup_project_history", { projectPath });
  },

  // ============ Diff API ============

  async getVersionDiff(projectPath: string, filePath: string, versionId: string): Promise<DiffResult> {
    return invoke("get_version_diff", { projectPath, filePath, versionId });
  },

  async getVersionsDiff(projectPath: string, filePath: string, oldVersionId: string, newVersionId: string): Promise<DiffResult> {
    return invoke("get_versions_diff", { projectPath, filePath, oldVersionId, newVersionId });
  },

  // ============ 标签 API ============

  async putLabel(projectPath: string, label: HistoryLabel): Promise<void> {
    await invoke("put_label", { projectPath, label });
  },

  async listLabels(projectPath: string): Promise<HistoryLabel[]> {
    return invoke("list_labels", { projectPath });
  },

  async deleteLabel(projectPath: string, labelId: string): Promise<void> {
    await invoke("delete_label", { projectPath, labelId });
  },

  async restoreToLabel(projectPath: string, labelId: string): Promise<string[]> {
    return invoke("restore_to_label", { projectPath, labelId });
  },

  async createAutoLabel(projectPath: string, name: string, source: string): Promise<string> {
    return invoke("create_auto_label", { projectPath, name, source });
  },

  // ============ 目录级历史 + 最近更改 ============

  async listDirectoryChanges(projectPath: string, dirPath: string, since?: string): Promise<FileVersion[]> {
    return invoke("list_directory_changes", { projectPath, dirPath, since });
  },

  async getRecentChanges(projectPath: string, limit?: number): Promise<RecentChange[]> {
    return invoke("get_recent_changes", { projectPath, limit });
  },

  // ============ 删除文件恢复 ============

  async listDeletedFiles(projectPath: string): Promise<FileVersion[]> {
    return invoke("list_deleted_files", { projectPath });
  },

  // ============ 压缩 ============

  async compressHistory(projectPath: string): Promise<number> {
    return invoke("compress_history", { projectPath });
  },

  // ============ 分支感知 + Worktree ============

  async getCurrentBranch(projectPath: string): Promise<string> {
    return invoke("get_current_branch", { projectPath });
  },

  async getFileBranches(projectPath: string, filePath: string): Promise<string[]> {
    return invoke("get_file_branches", { projectPath, filePath });
  },

  async listVersionsByBranch(projectPath: string, filePath: string, branch: string): Promise<FileVersion[]> {
    return invoke("list_file_versions_by_branch", { projectPath, filePath, branch });
  },

  async listWorktreeRecentChanges(projectPath: string, limit?: number): Promise<WorktreeRecentChange[]> {
    return invoke("list_worktree_recent_changes", { projectPath, limit });
  },
};
