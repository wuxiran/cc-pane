import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  History,
  RotateCcw,
  FileText,
  Tag,
  Trash2,
  Diff,
  Code,
  GitBranch,
  ChevronLeft,
  FolderOpen,
  FolderGit2,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  localHistoryService,
  type RecentChange,
  type WorktreeRecentChange,
} from "@/services";
import {
  formatRelativeTime,
  formatFullTime,
  formatSize,
  getFileName,
  getDirName,
  handleErrorSilent,
} from "@/utils";
import { useLocalHistoryData, getLabelColor } from "./useLocalHistoryData";
import VersionListSidebar from "./VersionListSidebar";
import VersionDiffView from "./VersionDiffView";
import LabelDialog from "./LabelDialog";

interface LocalHistoryPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectPath: string;
  filePath?: string;
  onRestored?: () => void;
  onOpenFileHistory?: (filePath: string, worktreePath?: string) => void;
}

export default function LocalHistoryPanel({
  open,
  onOpenChange,
  projectPath,
  filePath,
  onRestored,
  onOpenFileHistory,
}: LocalHistoryPanelProps) {
  const { t } = useTranslation(["dialogs", "common"]);
  const [showAllWorktrees, setShowAllWorktrees] = useState(false);
  const [worktreeChanges, setWorktreeChanges] = useState<
    WorktreeRecentChange[]
  >([]);
  const [worktreeLoading, setWorktreeLoading] = useState(false);
  const {
    labels,
    loading,
    selectedVersion,
    versionContent,
    diffResult,
    loadingContent,
    viewMode,
    labelDialogOpen,
    labelName,
    deletedFiles,
    diffDescription,
    projectLabels,
    restoring,
    labelFilter,
    branchFilter,
    fileBranches,
    recentChanges,
    fileListLoading,
    effectiveFilePath,
    filteredVersions,
    setLabelDialogOpen,
    setLabelName,
    setLabelFilter,
    setBranchFilter,
    setInternalFilePath,
    loadFileList,
    selectVersion,
    restoreVersion,
    switchViewMode,
    openLabelDialog,
    confirmAddLabel,
    restoreDeletedFile,
    restoreLabelSnapshot,
    handleKeydown,
    getVersionLabels,
  } = useLocalHistoryData({
    open,
    projectPath,
    filePath,
    onOpenChange,
    onRestored,
  });

  const groupedWorktreeChanges = useMemo(() => {
    const groups: Record<
      string,
      { path: string; branch: string; isMain: boolean; changes: RecentChange[] }
    > = {};
    for (const item of worktreeChanges) {
      groups[item.worktreePath] ??= {
        path: item.worktreePath,
        branch: item.worktreeBranch,
        isMain: item.isMain,
        changes: [],
      };
      groups[item.worktreePath].changes.push(item.change);
    }
    return Object.values(groups).sort(
      (a, b) => Number(b.isMain) - Number(a.isMain),
    );
  }, [worktreeChanges]);

  useEffect(() => {
    if (open) setShowAllWorktrees(false);
  }, [open, projectPath]);

  useEffect(() => {
    if (!open || filePath || !showAllWorktrees || !projectPath) return;

    let cancelled = false;
    setWorktreeLoading(true);
    localHistoryService
      .listWorktreeRecentChanges(projectPath, 200)
      .then((changes) => {
        if (!cancelled) setWorktreeChanges(changes);
      })
      .catch((error) => {
        handleErrorSilent(error, "load worktree recent changes");
        if (!cancelled) setWorktreeChanges([]);
      })
      .finally(() => {
        if (!cancelled) setWorktreeLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, projectPath, filePath, showAllWorktrees]);

  function openFileHistory(changeFilePath: string, worktreePath?: string) {
    if (worktreePath) {
      onOpenFileHistory?.(changeFilePath, worktreePath);
      return;
    }
    setInternalFilePath(changeFilePath);
  }

  function renderRecentChange(change: RecentChange, worktreePath?: string) {
    return (
      <div
        key={`${worktreePath || projectPath}:${change.filePath}:${change.versionId}`}
        className="flex items-center gap-3 px-3 py-2.5 rounded-md cursor-pointer transition-colors hover:bg-[var(--app-hover)]"
        onClick={() => openFileHistory(change.filePath, worktreePath)}
      >
        <FolderOpen
          size={14}
          className="shrink-0"
          style={{ color: "var(--app-accent)" }}
        />
        <div className="flex-1 min-w-0">
          <div
            className="text-[13px] truncate"
            style={{ color: "var(--app-text-primary)" }}
          >
            {getFileName(change.filePath)}
          </div>
          <div
            className="text-[11px] truncate"
            style={{ color: "var(--app-text-tertiary)" }}
          >
            {getDirName(change.filePath)}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span
            className="text-[11px]"
            style={{ color: "var(--app-text-tertiary)" }}
            title={formatFullTime(change.timestamp)}
          >
            {formatRelativeTime(change.timestamp)}
          </span>
          <span
            className="text-[11px]"
            style={{ color: "var(--app-text-tertiary)" }}
          >
            {formatSize(change.size)}
          </span>
          {change.branch && (
            <Badge
              variant="outline"
              className="text-[10px] px-1 h-[18px]"
              style={{ borderColor: "#6366f1", color: "#6366f1" }}
            >
              <GitBranch size={10} className="mr-0.5" />
              {change.branch}
            </Badge>
          )}
        </div>
      </div>
    );
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          resizable
          className="w-[80rem] h-[85vh] max-w-[95vw] max-h-[90vh]"
          onKeyDown={handleKeydown}
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {!filePath && effectiveFilePath && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0 mr-1"
                  onClick={() => {
                    setInternalFilePath("");
                    loadFileList();
                  }}
                >
                  <ChevronLeft size={16} />
                </Button>
              )}
              <History size={18} />
              {effectiveFilePath
                ? t("localHistoryTitle", { path: effectiveFilePath })
                : t("localHistoryTitleNoPath")}
              {!effectiveFilePath && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto h-7 w-7 p-0"
                  onClick={() => setShowAllWorktrees((value) => !value)}
                  title={t("recentChangesAllWorktrees")}
                  aria-label={t("recentChangesAllWorktrees")}
                  style={
                    showAllWorktrees
                      ? {
                          background: "var(--app-active-bg)",
                          color: "var(--app-accent)",
                        }
                      : undefined
                  }
                >
                  <FolderGit2 size={14} />
                </Button>
              )}
            </DialogTitle>
          </DialogHeader>

          {!effectiveFilePath ? (
            <div className="max-h-[600px] overflow-y-auto">
              {(showAllWorktrees ? worktreeLoading : fileListLoading) ? (
                <div
                  className="flex flex-col items-center justify-center py-16 gap-3"
                  style={{ color: "var(--app-text-tertiary)" }}
                >
                  <p>{t("loadingFileList")}</p>
                </div>
              ) : showAllWorktrees && groupedWorktreeChanges.length > 0 ? (
                groupedWorktreeChanges.map((group) => (
                  <div key={group.path} className="mb-4">
                    <div
                      className="flex items-center gap-2 px-3 py-2 text-xs mb-1"
                      style={{
                        color: "var(--app-text-secondary)",
                        borderBottom: "1px solid var(--app-border)",
                      }}
                    >
                      <FolderGit2 size={14} />
                      <span
                        className="font-medium flex-1 min-w-0 truncate"
                        style={{ color: "var(--app-text-primary)" }}
                      >
                        {group.path}
                      </span>
                      <Badge
                        variant="outline"
                        className="text-[10px] px-1 h-4"
                        style={{ borderColor: "#6366f1", color: "#6366f1" }}
                      >
                        <GitBranch size={10} className="mr-1" />
                        {group.branch || t("recentChangesUnknownBranch")}
                      </Badge>
                      {group.isMain && (
                        <Badge
                          variant="secondary"
                          className="text-[10px] px-1 h-4 shrink-0"
                        >
                          {t("recentChangesMainRepo")}
                        </Badge>
                      )}
                    </div>
                    {group.changes.map((change) =>
                      renderRecentChange(change, group.path),
                    )}
                  </div>
                ))
              ) : !showAllWorktrees && recentChanges.length > 0 ? (
                recentChanges.map((change) => renderRecentChange(change))
              ) : (
                <div
                  className="flex flex-col items-center justify-center py-16 gap-3"
                  style={{ color: "var(--app-text-tertiary)" }}
                >
                  <FileText size={48} />
                  <p>{t("noFileHistory")}</p>
                  <p className="text-xs opacity-70">{t("autoTrackChanges")}</p>
                </div>
              )}
            </div>
          ) : (
            <>
              {/* 工具栏 */}
              <div className="flex items-center justify-between gap-2 mb-2">
                <div className="flex gap-1">
                  <Button
                    size="sm"
                    variant={viewMode === "diff" ? "default" : "ghost"}
                    onClick={() => switchViewMode("diff")}
                  >
                    <Diff size={14} className="mr-1" /> {t("diff")}
                  </Button>
                  <Button
                    size="sm"
                    variant={viewMode === "content" ? "default" : "ghost"}
                    onClick={() => switchViewMode("content")}
                  >
                    <Code size={14} className="mr-1" /> {t("fullContent")}
                  </Button>
                  <Button
                    size="sm"
                    variant={viewMode === "deleted" ? "default" : "ghost"}
                    onClick={() => switchViewMode("deleted")}
                  >
                    <Trash2 size={14} className="mr-1" /> {t("deleted")}
                  </Button>
                  <Button
                    size="sm"
                    variant={
                      viewMode === "project-restore" ? "default" : "ghost"
                    }
                    onClick={() => switchViewMode("project-restore")}
                  >
                    <RotateCcw size={14} className="mr-1" />{" "}
                    {t("projectRestore")}
                  </Button>
                </div>

                <div className="flex items-center gap-2">
                  {viewMode !== "deleted" && fileBranches.length > 1 && (
                    <select
                      value={branchFilter}
                      onChange={(e) => setBranchFilter(e.target.value)}
                      className="px-2 py-1 text-xs rounded-md outline-none max-w-[200px]"
                      style={{
                        border: "1px solid var(--app-border)",
                        background: "var(--app-content)",
                        color: "var(--app-text-primary)",
                      }}
                    >
                      <option value="">{t("allBranches")}</option>
                      {fileBranches.map((b) => (
                        <option key={b} value={b}>
                          {b || t("unknownBranch")}
                        </option>
                      ))}
                    </select>
                  )}
                  {viewMode !== "deleted" && labels.length > 0 && (
                    <select
                      value={labelFilter}
                      onChange={(e) => setLabelFilter(e.target.value)}
                      className="px-2 py-1 text-xs rounded-md outline-none max-w-[200px]"
                      style={{
                        border: "1px solid var(--app-border)",
                        background: "var(--app-content)",
                        color: "var(--app-text-primary)",
                      }}
                    >
                      <option value="">{t("allVersions")}</option>
                      {labels.map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.name}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              </div>

              {/* 项目恢复视图 */}
              {viewMode === "project-restore" ? (
                <div
                  className="h-[600px] overflow-y-auto rounded-lg p-2"
                  style={{ border: "1px solid var(--app-border)" }}
                >
                  {projectLabels.length === 0 ? (
                    <div
                      className="py-5 text-center"
                      style={{ color: "var(--app-text-tertiary)" }}
                    >
                      {t("noSnapshots")}
                    </div>
                  ) : (
                    projectLabels.map((label) => (
                      <div
                        key={label.id}
                        className="flex items-center justify-between px-3 py-2.5 rounded-md mb-1 transition-colors hover:bg-[var(--app-hover)]"
                      >
                        <div className="flex items-center gap-2 flex-1 min-w-0">
                          <Badge
                            variant="outline"
                            className="text-[10px] px-1.5 h-[18px] shrink-0"
                            style={{
                              borderColor: getLabelColor(label.source),
                              color: getLabelColor(label.source),
                            }}
                          >
                            {label.source === "claude_session"
                              ? t("labelSourceClaudeSession")
                              : label.source === "restore"
                                ? t("labelSourceRestore")
                                : label.source}
                          </Badge>
                          <span
                            className="text-[13px] truncate"
                            style={{ color: "var(--app-text-primary)" }}
                          >
                            {label.name}
                          </span>
                          <span
                            className="text-[11px] shrink-0"
                            style={{ color: "var(--app-text-tertiary)" }}
                            title={formatFullTime(label.timestamp)}
                          >
                            {formatRelativeTime(label.timestamp)}
                          </span>
                          <span
                            className="text-[11px] shrink-0"
                            style={{ color: "var(--app-text-tertiary)" }}
                          >
                            {t("fileCount", {
                              count: label.fileSnapshots.length,
                            })}
                          </span>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={restoring}
                          onClick={() => restoreLabelSnapshot(label)}
                        >
                          <RotateCcw size={12} className="mr-1" />{" "}
                          {t("restoreToSnapshot")}
                        </Button>
                      </div>
                    ))
                  )}
                </div>
              ) : viewMode === "deleted" ? (
                <div
                  className="max-h-[600px] overflow-y-auto rounded-lg p-2"
                  style={{ border: "1px solid var(--app-border)" }}
                >
                  {deletedFiles.length === 0 ? (
                    <div
                      className="py-5 text-center"
                      style={{ color: "var(--app-text-tertiary)" }}
                    >
                      {t("noDeletedFiles")}
                    </div>
                  ) : (
                    deletedFiles.map((file) => (
                      <div
                        key={file.id}
                        className="flex items-center justify-between px-3 py-2.5 rounded-md mb-1 transition-colors hover:bg-[var(--app-hover)]"
                      >
                        <div className="flex items-center gap-2 flex-1 min-w-0">
                          <Trash2
                            size={14}
                            className="shrink-0 text-destructive"
                          />
                          <span
                            className="text-[13px] truncate"
                            style={{ color: "var(--app-text-primary)" }}
                          >
                            {file.filePath}
                          </span>
                          <span
                            className="text-[11px] shrink-0"
                            style={{ color: "var(--app-text-tertiary)" }}
                            title={formatFullTime(file.createdAt)}
                          >
                            {formatRelativeTime(file.createdAt)}
                          </span>
                          <span
                            className="text-[11px] shrink-0"
                            style={{ color: "var(--app-text-tertiary)" }}
                          >
                            {formatSize(file.size)}
                          </span>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => restoreDeletedFile(file)}
                        >
                          <RotateCcw size={12} className="mr-1" />{" "}
                          {t("common:restore")}
                        </Button>
                      </div>
                    ))
                  )}
                </div>
              ) : (
                /* 版本列表 + 预览 */
                <div className="flex gap-4 h-[600px]">
                  <VersionListSidebar
                    loading={loading}
                    filteredVersions={filteredVersions}
                    selectedVersion={selectedVersion}
                    fileBranches={fileBranches}
                    selectVersion={selectVersion}
                    openLabelDialog={openLabelDialog}
                    getVersionLabels={getVersionLabels}
                  />
                  <VersionDiffView
                    selectedVersion={selectedVersion}
                    loadingContent={loadingContent}
                    viewMode={viewMode}
                    diffDescription={diffDescription}
                    diffResult={diffResult}
                    versionContent={versionContent}
                  />
                </div>
              )}

              {/* 操作按钮 */}
              {selectedVersion &&
                viewMode !== "deleted" &&
                viewMode !== "project-restore" && (
                  <div className="flex justify-between items-center mt-4">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => openLabelDialog(selectedVersion)}
                    >
                      <Tag size={14} className="mr-1" /> {t("addTag")}
                    </Button>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        onClick={() => onOpenChange(false)}
                      >
                        {t("common:cancel")}
                      </Button>
                      <Button onClick={restoreVersion}>
                        <RotateCcw size={14} className="mr-2" />{" "}
                        {t("restoreVersion")}
                      </Button>
                    </div>
                  </div>
                )}
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* 添加标签对话框 */}
      <LabelDialog
        open={labelDialogOpen}
        onOpenChange={setLabelDialogOpen}
        labelName={labelName}
        setLabelName={setLabelName}
        onConfirm={confirmAddLabel}
      />
    </>
  );
}
