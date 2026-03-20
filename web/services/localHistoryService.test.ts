import { describe, it, expect, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { localHistoryService } from "./localHistoryService";
import type {
  HistoryConfig,
  HistoryLabel,
  DiffResult,
  FileVersion,
  RecentChange,
  WorktreeRecentChange,
} from "./localHistoryService";
import {
  mockTauriInvoke,
  resetTauriInvoke,
} from "@/test/utils/mockTauriInvoke";
import { resetTestDataCounter } from "@/test/utils/testData";

// ---- 测试数据工厂 ----

function createTestFileVersion(overrides?: Partial<FileVersion>): FileVersion {
  return {
    id: "ver-1",
    filePath: "src/main.ts",
    hash: "abc123",
    size: 1024,
    createdAt: "2024-01-01T00:00:00Z",
    isDeleted: false,
    branch: "main",
    ...overrides,
  };
}

function createTestHistoryConfig(overrides?: Partial<HistoryConfig>): HistoryConfig {
  return {
    enabled: true,
    ignorePatterns: ["node_modules/**"],
    maxVersionsPerFile: 100,
    maxAgeDays: 30,
    maxFileSize: 1048576,
    maxTotalSize: 104857600,
    minSaveIntervalSecs: 300,
    ...overrides,
  };
}

function createTestDiffResult(): DiffResult {
  return {
    hunks: [],
    stats: { additions: 1, deletions: 0, changes: 1 },
    isBinary: false,
    truncated: false,
  };
}

function createTestLabel(overrides?: Partial<HistoryLabel>): HistoryLabel {
  return {
    id: "label-1",
    name: "v1.0",
    labelType: "user",
    source: "manual",
    timestamp: "2024-01-01T00:00:00Z",
    fileSnapshots: [],
    branch: "main",
    ...overrides,
  };
}

function createTestRecentChange(overrides?: Partial<RecentChange>): RecentChange {
  return {
    filePath: "src/main.ts",
    versionId: "ver-1",
    timestamp: "2024-01-01T00:00:00Z",
    size: 1024,
    hash: "abc123",
    labelName: null,
    branch: "main",
    ...overrides,
  };
}

describe("localHistoryService", () => {
  beforeEach(() => {
    resetTauriInvoke();
    resetTestDataCounter();
  });

  // ============ 基础操作 ============

  describe("initProjectHistory", () => {
    it("应该调用 init_project_history 命令", async () => {
      mockTauriInvoke({ init_project_history: undefined });

      await localHistoryService.initProjectHistory("/tmp/project");

      expect(invoke).toHaveBeenCalledWith("init_project_history", {
        projectPath: "/tmp/project",
      });
    });
  });

  describe("listFileVersions", () => {
    it("应该调用 list_file_versions 命令并返回版本列表", async () => {
      const versions = [createTestFileVersion()];
      mockTauriInvoke({ list_file_versions: versions });

      const result = await localHistoryService.listFileVersions(
        "/tmp/project",
        "src/main.ts",
      );

      expect(invoke).toHaveBeenCalledWith("list_file_versions", {
        projectPath: "/tmp/project",
        filePath: "src/main.ts",
      });
      expect(result).toEqual(versions);
    });
  });

  describe("getVersionContent", () => {
    it("应该调用 get_version_content 命令并返回内容", async () => {
      mockTauriInvoke({ get_version_content: "file content" });

      const result = await localHistoryService.getVersionContent(
        "/tmp/project",
        "src/main.ts",
        "ver-1",
      );

      expect(invoke).toHaveBeenCalledWith("get_version_content", {
        projectPath: "/tmp/project",
        filePath: "src/main.ts",
        versionId: "ver-1",
      });
      expect(result).toBe("file content");
    });
  });

  describe("restoreFileVersion", () => {
    it("应该调用 restore_file_version 命令", async () => {
      mockTauriInvoke({ restore_file_version: undefined });

      await localHistoryService.restoreFileVersion(
        "/tmp/project",
        "src/main.ts",
        "ver-1",
      );

      expect(invoke).toHaveBeenCalledWith("restore_file_version", {
        projectPath: "/tmp/project",
        filePath: "src/main.ts",
        versionId: "ver-1",
      });
    });
  });

  describe("getHistoryConfig", () => {
    it("应该调用 get_history_config 命令并返回配置", async () => {
      const config = createTestHistoryConfig();
      mockTauriInvoke({ get_history_config: config });

      const result = await localHistoryService.getHistoryConfig("/tmp/project");

      expect(invoke).toHaveBeenCalledWith("get_history_config", {
        projectPath: "/tmp/project",
      });
      expect(result).toEqual(config);
    });
  });

  describe("updateHistoryConfig", () => {
    it("应该调用 update_history_config 命令", async () => {
      const config = createTestHistoryConfig({ maxAgeDays: 60 });
      mockTauriInvoke({ update_history_config: undefined });

      await localHistoryService.updateHistoryConfig("/tmp/project", config);

      expect(invoke).toHaveBeenCalledWith("update_history_config", {
        projectPath: "/tmp/project",
        config,
      });
    });
  });

  describe("stopProjectHistory", () => {
    it("应该调用 stop_project_history 命令", async () => {
      mockTauriInvoke({ stop_project_history: undefined });

      await localHistoryService.stopProjectHistory("/tmp/project");

      expect(invoke).toHaveBeenCalledWith("stop_project_history", {
        projectPath: "/tmp/project",
      });
    });
  });

  describe("cleanupProjectHistory", () => {
    it("应该调用 cleanup_project_history 命令", async () => {
      mockTauriInvoke({ cleanup_project_history: undefined });

      await localHistoryService.cleanupProjectHistory("/tmp/project");

      expect(invoke).toHaveBeenCalledWith("cleanup_project_history", {
        projectPath: "/tmp/project",
      });
    });
  });

  // ============ Diff API ============

  describe("getVersionDiff", () => {
    it("应该调用 get_version_diff 命令并返回 Diff 结果", async () => {
      const diff = createTestDiffResult();
      mockTauriInvoke({ get_version_diff: diff });

      const result = await localHistoryService.getVersionDiff(
        "/tmp/project",
        "src/main.ts",
        "ver-1",
      );

      expect(invoke).toHaveBeenCalledWith("get_version_diff", {
        projectPath: "/tmp/project",
        filePath: "src/main.ts",
        versionId: "ver-1",
      });
      expect(result).toEqual(diff);
    });
  });

  describe("getVersionsDiff", () => {
    it("应该调用 get_versions_diff 命令并返回 Diff 结果", async () => {
      const diff = createTestDiffResult();
      mockTauriInvoke({ get_versions_diff: diff });

      const result = await localHistoryService.getVersionsDiff(
        "/tmp/project",
        "src/main.ts",
        "ver-1",
        "ver-2",
      );

      expect(invoke).toHaveBeenCalledWith("get_versions_diff", {
        projectPath: "/tmp/project",
        filePath: "src/main.ts",
        oldVersionId: "ver-1",
        newVersionId: "ver-2",
      });
      expect(result).toEqual(diff);
    });
  });

  // ============ 标签 API ============

  describe("putLabel", () => {
    it("应该调用 put_label 命令", async () => {
      const label = createTestLabel();
      mockTauriInvoke({ put_label: undefined });

      await localHistoryService.putLabel("/tmp/project", label);

      expect(invoke).toHaveBeenCalledWith("put_label", {
        projectPath: "/tmp/project",
        label,
      });
    });
  });

  describe("listLabels", () => {
    it("应该调用 list_labels 命令并返回标签列表", async () => {
      const labels = [createTestLabel()];
      mockTauriInvoke({ list_labels: labels });

      const result = await localHistoryService.listLabels("/tmp/project");

      expect(invoke).toHaveBeenCalledWith("list_labels", {
        projectPath: "/tmp/project",
      });
      expect(result).toEqual(labels);
    });
  });

  describe("deleteLabel", () => {
    it("应该调用 delete_label 命令", async () => {
      mockTauriInvoke({ delete_label: undefined });

      await localHistoryService.deleteLabel("/tmp/project", "label-1");

      expect(invoke).toHaveBeenCalledWith("delete_label", {
        projectPath: "/tmp/project",
        labelId: "label-1",
      });
    });
  });

  describe("restoreToLabel", () => {
    it("应该调用 restore_to_label 命令并返回恢复的文件列表", async () => {
      const files = ["src/main.ts", "src/lib.ts"];
      mockTauriInvoke({ restore_to_label: files });

      const result = await localHistoryService.restoreToLabel(
        "/tmp/project",
        "label-1",
      );

      expect(invoke).toHaveBeenCalledWith("restore_to_label", {
        projectPath: "/tmp/project",
        labelId: "label-1",
      });
      expect(result).toEqual(files);
    });
  });

  describe("createAutoLabel", () => {
    it("应该调用 create_auto_label 命令并返回标签 ID", async () => {
      mockTauriInvoke({ create_auto_label: "label-auto-1" });

      const result = await localHistoryService.createAutoLabel(
        "/tmp/project",
        "auto-save",
        "system",
      );

      expect(invoke).toHaveBeenCalledWith("create_auto_label", {
        projectPath: "/tmp/project",
        name: "auto-save",
        source: "system",
      });
      expect(result).toBe("label-auto-1");
    });
  });

  // ============ 目录级历史 + 最近更改 ============

  describe("listDirectoryChanges", () => {
    it("应该调用 list_directory_changes 命令并返回版本列表", async () => {
      const versions = [createTestFileVersion()];
      mockTauriInvoke({ list_directory_changes: versions });

      const result = await localHistoryService.listDirectoryChanges(
        "/tmp/project",
        "src/",
      );

      expect(invoke).toHaveBeenCalledWith("list_directory_changes", {
        projectPath: "/tmp/project",
        dirPath: "src/",
        since: undefined,
      });
      expect(result).toEqual(versions);
    });

    it("应该支持 since 参数", async () => {
      mockTauriInvoke({ list_directory_changes: [] });

      await localHistoryService.listDirectoryChanges(
        "/tmp/project",
        "src/",
        "2024-01-01T00:00:00Z",
      );

      expect(invoke).toHaveBeenCalledWith("list_directory_changes", {
        projectPath: "/tmp/project",
        dirPath: "src/",
        since: "2024-01-01T00:00:00Z",
      });
    });
  });

  describe("getRecentChanges", () => {
    it("应该调用 get_recent_changes 命令并返回最近更改", async () => {
      const changes = [createTestRecentChange()];
      mockTauriInvoke({ get_recent_changes: changes });

      const result = await localHistoryService.getRecentChanges("/tmp/project", 10);

      expect(invoke).toHaveBeenCalledWith("get_recent_changes", {
        projectPath: "/tmp/project",
        limit: 10,
      });
      expect(result).toEqual(changes);
    });

    it("应该支持不传 limit 参数", async () => {
      mockTauriInvoke({ get_recent_changes: [] });

      await localHistoryService.getRecentChanges("/tmp/project");

      expect(invoke).toHaveBeenCalledWith("get_recent_changes", {
        projectPath: "/tmp/project",
        limit: undefined,
      });
    });
  });

  // ============ 删除文件恢复 ============

  describe("listDeletedFiles", () => {
    it("应该调用 list_deleted_files 命令并返回已删除文件列表", async () => {
      const versions = [createTestFileVersion({ isDeleted: true })];
      mockTauriInvoke({ list_deleted_files: versions });

      const result = await localHistoryService.listDeletedFiles("/tmp/project");

      expect(invoke).toHaveBeenCalledWith("list_deleted_files", {
        projectPath: "/tmp/project",
      });
      expect(result).toEqual(versions);
    });
  });

  // ============ 压缩 ============

  describe("compressHistory", () => {
    it("应该调用 compress_history 命令并返回压缩数量", async () => {
      mockTauriInvoke({ compress_history: 42 });

      const result = await localHistoryService.compressHistory("/tmp/project");

      expect(invoke).toHaveBeenCalledWith("compress_history", {
        projectPath: "/tmp/project",
      });
      expect(result).toBe(42);
    });
  });

  // ============ 分支感知 + Worktree ============

  describe("getCurrentBranch", () => {
    it("应该调用 get_current_branch 命令并返回分支名", async () => {
      mockTauriInvoke({ get_current_branch: "main" });

      const result = await localHistoryService.getCurrentBranch("/tmp/project");

      expect(invoke).toHaveBeenCalledWith("get_current_branch", {
        projectPath: "/tmp/project",
      });
      expect(result).toBe("main");
    });
  });

  describe("getFileBranches", () => {
    it("应该调用 get_file_branches 命令并返回分支列表", async () => {
      const branches = ["main", "feature"];
      mockTauriInvoke({ get_file_branches: branches });

      const result = await localHistoryService.getFileBranches(
        "/tmp/project",
        "src/main.ts",
      );

      expect(invoke).toHaveBeenCalledWith("get_file_branches", {
        projectPath: "/tmp/project",
        filePath: "src/main.ts",
      });
      expect(result).toEqual(branches);
    });
  });

  describe("listVersionsByBranch", () => {
    it("应该调用 list_file_versions_by_branch 命令并返回版本列表", async () => {
      const versions = [createTestFileVersion({ branch: "feature" })];
      mockTauriInvoke({ list_file_versions_by_branch: versions });

      const result = await localHistoryService.listVersionsByBranch(
        "/tmp/project",
        "src/main.ts",
        "feature",
      );

      expect(invoke).toHaveBeenCalledWith("list_file_versions_by_branch", {
        projectPath: "/tmp/project",
        filePath: "src/main.ts",
        branch: "feature",
      });
      expect(result).toEqual(versions);
    });
  });

  describe("listWorktreeRecentChanges", () => {
    it("应该调用 list_worktree_recent_changes 命令并返回变更列表", async () => {
      const changes: WorktreeRecentChange[] = [
        {
          worktreePath: "/tmp/project-wt",
          worktreeBranch: "feature",
          isMain: false,
          change: createTestRecentChange(),
        },
      ];
      mockTauriInvoke({ list_worktree_recent_changes: changes });

      const result = await localHistoryService.listWorktreeRecentChanges(
        "/tmp/project",
        5,
      );

      expect(invoke).toHaveBeenCalledWith("list_worktree_recent_changes", {
        projectPath: "/tmp/project",
        limit: 5,
      });
      expect(result).toEqual(changes);
    });

    it("应该支持不传 limit 参数", async () => {
      mockTauriInvoke({ list_worktree_recent_changes: [] });

      await localHistoryService.listWorktreeRecentChanges("/tmp/project");

      expect(invoke).toHaveBeenCalledWith("list_worktree_recent_changes", {
        projectPath: "/tmp/project",
        limit: undefined,
      });
    });
  });
});
