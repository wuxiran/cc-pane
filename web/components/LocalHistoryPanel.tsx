import { useState, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { History, RotateCcw, FileText, Clock, Tag, Trash2, Diff, Code, GitBranch, ChevronLeft, FolderOpen } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import DiffView from "@/components/DiffView";
import {
  localHistoryService,
  type FileVersion,
  type DiffResult,
  type HistoryLabel,
  type RecentChange,
} from "@/services";
import { formatRelativeTime, formatFullTime, formatSize, getFileName, getDirName, getErrorMessage } from "@/utils";

interface LocalHistoryPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectPath: string;
  filePath?: string;
  onRestored?: () => void;
}

type ViewMode = "diff" | "content" | "deleted" | "project-restore";

function getLabelColor(source: string): string {
  const colors: Record<string, string> = {
    git_commit: "#f59e0b",
    claude_session: "#8b5cf6",
    user: "#3b82f6",
    build: "#10b981",
    restore: "#ef4444",
  };
  return colors[source] || "#6b7280";
}

export default function LocalHistoryPanel({
  open,
  onOpenChange,
  projectPath,
  filePath,
  onRestored,
}: LocalHistoryPanelProps) {
  const { t } = useTranslation(["dialogs", "common"]);
  const [versions, setVersions] = useState<FileVersion[]>([]);
  const [labels, setLabels] = useState<HistoryLabel[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedVersion, setSelectedVersion] = useState<FileVersion | null>(null);
  const [versionContent, setVersionContent] = useState("");
  const [diffResult, setDiffResult] = useState<DiffResult | null>(null);
  const [loadingContent, setLoadingContent] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("diff");
  const [labelDialogOpen, setLabelDialogOpen] = useState(false);
  const [labelName, setLabelName] = useState("");
  const [labelTarget, setLabelTarget] = useState<FileVersion | null>(null);
  const [deletedFiles, setDeletedFiles] = useState<FileVersion[]>([]);
  const [diffDescription, setDiffDescription] = useState("");
  const [projectLabels, setProjectLabels] = useState<HistoryLabel[]>([]);
  const [restoring, setRestoring] = useState(false);
  const [labelFilter, setLabelFilter] = useState("");
  const [branchFilter, setBranchFilter] = useState("");
  const [fileBranches, setFileBranches] = useState<string[]>([]);

  // 文件列表模式（两阶段视图）
  const [internalFilePath, setInternalFilePath] = useState("");
  const [recentChanges, setRecentChanges] = useState<RecentChange[]>([]);
  const [fileListLoading, setFileListLoading] = useState(false);

  const effectiveFilePath = filePath || internalFilePath;

  const selectRequestIdRef = useRef(0);

  // 打开时加载
  useEffect(() => {
    if (open) {
      setSelectedVersion(null);
      setVersionContent("");
      setDiffResult(null);
      setViewMode("diff");
      setLabelFilter("");
      setBranchFilter("");
      setInternalFilePath(filePath || "");
      if (filePath) {
        loadVersions();
      } else {
        loadFileList();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // internalFilePath 变化时加载版本
  useEffect(() => {
    if (internalFilePath && open) {
      setSelectedVersion(null);
      setVersionContent("");
      setDiffResult(null);
      loadVersions();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [internalFilePath]);

  // 预计算 versionId -> labels 映射
  const versionLabelsMap = useMemo(() => {
    const map = new Map<string, HistoryLabel[]>();
    for (const label of labels) {
      for (const snap of label.fileSnapshots) {
        if (snap.filePath === effectiveFilePath) {
          const arr = map.get(snap.versionId) || [];
          arr.push(label);
          map.set(snap.versionId, arr);
        }
      }
    }
    return map;
  }, [labels, effectiveFilePath]);

  // 筛选后的版本列表
  const filteredVersions = useMemo(() => {
    let result = versions;
    if (branchFilter) result = result.filter((v) => v.branch === branchFilter);
    if (labelFilter) {
      const targetLabel = labels.find((l) => l.id === labelFilter);
      if (targetLabel) {
        const versionIds = new Set(
          targetLabel.fileSnapshots.filter((s) => s.filePath === effectiveFilePath).map((s) => s.versionId)
        );
        result = result.filter((v) => versionIds.has(v.id));
      }
    }
    return result;
  }, [versions, branchFilter, labelFilter, labels, effectiveFilePath]);

  async function loadFileList() {
    if (!projectPath) return;
    setFileListLoading(true);
    try {
      const changes = await localHistoryService.getRecentChanges(projectPath, 200);
      // 去重：每个 filePath 只保留最新一条
      const seen = new Set<string>();
      const unique: RecentChange[] = [];
      for (const c of changes) {
        if (!seen.has(c.filePath)) {
          seen.add(c.filePath);
          unique.push(c);
        }
      }
      setRecentChanges(unique);
    } catch (e) {
      console.error("Failed to load file list:", e);
      setRecentChanges([]);
    } finally {
      setFileListLoading(false);
    }
  }

  async function loadVersions() {
    if (!projectPath || !effectiveFilePath) return;
    setLoading(true);
    try {
      const [vers, lbls, branches] = await Promise.all([
        localHistoryService.listFileVersions(projectPath, effectiveFilePath),
        localHistoryService.listLabels(projectPath),
        localHistoryService.getFileBranches(projectPath, effectiveFilePath),
      ]);
      setVersions([...vers].reverse());
      setLabels(lbls);
      setFileBranches(branches);
    } catch (e) {
      console.error("Failed to load versions:", e);
      setVersions([]);
    } finally {
      setLoading(false);
    }
  }

  async function loadProjectLabels() {
    if (!projectPath) return;
    try {
      const allLabels = await localHistoryService.listLabels(projectPath);
      setProjectLabels(allLabels.sort((a, b) => b.timestamp.localeCompare(a.timestamp)));
    } catch (e) {
      console.error("Failed to load project labels:", e);
      setProjectLabels([]);
    }
  }

  async function loadDeletedFiles() {
    if (!projectPath) return;
    try {
      setDeletedFiles(await localHistoryService.listDeletedFiles(projectPath));
    } catch (e) {
      console.error("Failed to load deleted files:", e);
      setDeletedFiles([]);
    }
  }

  async function selectVersion(version: FileVersion) {
    setSelectedVersion(version);
    setLoadingContent(true);
    setDiffResult(null);

    const requestId = ++selectRequestIdRef.current;

    try {
      if (viewMode === "diff" && effectiveFilePath) {
        // versions 数组是 newest-first 排列（.reverse()）
        const currentIndex = versions.findIndex(v => v.id === version.id);
        const prevVersion = currentIndex < versions.length - 1 ? versions[currentIndex + 1] : null;

        if (prevVersion) {
          // 与上一个版本比较（old=前一版本, new=选中版本）
          setDiffDescription(`${formatRelativeTime(prevVersion.createdAt)} → ${formatRelativeTime(version.createdAt)}`);
          const result = await localHistoryService.getVersionsDiff(
            projectPath, effectiveFilePath, prevVersion.id, version.id
          );
          if (requestId !== selectRequestIdRef.current) return;
          setDiffResult(result);
        } else {
          // 最早的版本，没有更早版本可比较 → 与当前磁盘文件比较作为 fallback
          setDiffDescription(t("diffEarliestToCurrent"));
          const result = await localHistoryService.getVersionDiff(projectPath, effectiveFilePath, version.id);
          if (requestId !== selectRequestIdRef.current) return;
          setDiffResult(result);
        }
      } else {
        const content = await localHistoryService.getVersionContent(projectPath, effectiveFilePath || "", version.id);
        if (requestId !== selectRequestIdRef.current) return;
        setVersionContent(content);
      }
    } catch (e) {
      if (requestId !== selectRequestIdRef.current) return;
      console.error("Failed to load version:", e);
      setVersionContent(t("loadFailed"));
    } finally {
      setLoadingContent(false);
    }
  }

  async function restoreVersion() {
    if (!selectedVersion) return;
    try {
      await localHistoryService.restoreFileVersion(projectPath, effectiveFilePath || "", selectedVersion.id);
      onRestored?.();
      onOpenChange(false);
    } catch (e) {
      console.error("Failed to restore version:", e);
      toast.error(t("restoreFailed", { error: getErrorMessage(e) }));
    }
  }

  async function switchViewMode(mode: ViewMode) {
    setViewMode(mode);
    if (mode === "deleted") {
      await loadDeletedFiles();
      return;
    }
    if (mode === "project-restore") {
      await loadProjectLabels();
      return;
    }
    if (selectedVersion) await selectVersion(selectedVersion);
  }

  function openLabelDialog(version: FileVersion) {
    setLabelTarget(version);
    setLabelName("");
    setLabelDialogOpen(true);
  }

  async function confirmAddLabel() {
    if (!labelTarget || !labelName.trim()) return;
    try {
      const label: HistoryLabel = {
        id: crypto.randomUUID(),
        name: labelName.trim(),
        labelType: "manual",
        source: "user",
        timestamp: new Date().toISOString(),
        fileSnapshots: [{ filePath: effectiveFilePath || "", versionId: labelTarget.id }],
        branch: labelTarget.branch || "",
      };
      await localHistoryService.putLabel(projectPath, label);
      setLabels(await localHistoryService.listLabels(projectPath));
      setLabelDialogOpen(false);
    } catch (e) {
      console.error("Failed to add label:", e);
      toast.error(t("addTagFailed", { error: getErrorMessage(e) }));
    }
  }

  async function restoreDeletedFile(file: FileVersion) {
    try {
      await localHistoryService.restoreFileVersion(projectPath, file.filePath, file.id);
      toast.success(t("fileRestored", { path: file.filePath }));
      await loadDeletedFiles();
    } catch (e) {
      toast.error(t("restoreFailed", { error: getErrorMessage(e) }));
    }
  }

  function handleKeydown(e: React.KeyboardEvent) {
    const list = filteredVersions;
    if (list.length === 0) return;
    const currentIndex = selectedVersion ? list.findIndex((v) => v.id === selectedVersion.id) : -1;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      const next = Math.min(currentIndex + 1, list.length - 1);
      selectVersion(list[next]);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const prev = Math.max(currentIndex - 1, 0);
      selectVersion(list[prev]);
    } else if (e.key === "Enter" && selectedVersion) {
      restoreVersion();
    }
  }

  function getVersionLabels(versionId: string): HistoryLabel[] {
    return versionLabelsMap.get(versionId) || [];
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent resizable className="w-[80rem] h-[85vh] max-w-[95vw] max-h-[90vh]" onKeyDown={handleKeydown}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {!filePath && effectiveFilePath && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0 mr-1"
                  onClick={() => { setInternalFilePath(""); loadFileList(); }}
                >
                  <ChevronLeft size={16} />
                </Button>
              )}
              <History size={18} />
              {effectiveFilePath ? t("localHistoryTitle", { path: effectiveFilePath }) : t("localHistoryTitleNoPath")}
            </DialogTitle>
          </DialogHeader>

          {!effectiveFilePath ? (
            <div className="max-h-[600px] overflow-y-auto">
              {fileListLoading ? (
                <div className="flex flex-col items-center justify-center py-16 gap-3" style={{ color: "var(--app-text-tertiary)" }}>
                  <p>{t("loadingFileList")}</p>
                </div>
              ) : recentChanges.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 gap-3" style={{ color: "var(--app-text-tertiary)" }}>
                  <FileText size={48} />
                  <p>{t("noFileHistory")}</p>
                  <p className="text-xs opacity-70">{t("autoTrackChanges")}</p>
                </div>
              ) : (
                recentChanges.map((change) => (
                  <div
                    key={change.filePath}
                    className="flex items-center gap-3 px-3 py-2.5 rounded-md cursor-pointer transition-colors hover:bg-[var(--app-hover)]"
                    onClick={() => setInternalFilePath(change.filePath)}
                  >
                    <FolderOpen size={14} className="shrink-0" style={{ color: "var(--app-accent)" }} />
                    <div className="flex-1 min-w-0">
                      <div className="text-[13px] truncate" style={{ color: "var(--app-text-primary)" }}>
                        {getFileName(change.filePath)}
                      </div>
                      <div className="text-[11px] truncate" style={{ color: "var(--app-text-tertiary)" }}>
                        {getDirName(change.filePath)}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-[11px]" style={{ color: "var(--app-text-tertiary)" }} title={formatFullTime(change.timestamp)}>
                        {formatRelativeTime(change.timestamp)}
                      </span>
                      <span className="text-[11px]" style={{ color: "var(--app-text-tertiary)" }}>
                        {formatSize(change.size)}
                      </span>
                      {change.branch && (
                        <Badge variant="outline" className="text-[10px] px-1 h-[18px]" style={{ borderColor: "#6366f1", color: "#6366f1" }}>
                          <GitBranch size={10} className="mr-0.5" />{change.branch}
                        </Badge>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          ) : (
            <>
              {/* 工具栏 */}
              <div className="flex items-center justify-between gap-2 mb-2">
                <div className="flex gap-1">
                  <Button size="sm" variant={viewMode === "diff" ? "default" : "ghost"} onClick={() => switchViewMode("diff")}>
                    <Diff size={14} className="mr-1" /> {t("diff")}
                  </Button>
                  <Button size="sm" variant={viewMode === "content" ? "default" : "ghost"} onClick={() => switchViewMode("content")}>
                    <Code size={14} className="mr-1" /> {t("fullContent")}
                  </Button>
                  <Button size="sm" variant={viewMode === "deleted" ? "default" : "ghost"} onClick={() => switchViewMode("deleted")}>
                    <Trash2 size={14} className="mr-1" /> {t("deleted")}
                  </Button>
                  <Button size="sm" variant={viewMode === "project-restore" ? "default" : "ghost"} onClick={() => switchViewMode("project-restore")}>
                    <RotateCcw size={14} className="mr-1" /> {t("projectRestore")}
                  </Button>
                </div>

                <div className="flex items-center gap-2">
                  {viewMode !== "deleted" && fileBranches.length > 1 && (
                    <select
                      value={branchFilter}
                      onChange={(e) => setBranchFilter(e.target.value)}
                      className="px-2 py-1 text-xs rounded-md outline-none max-w-[200px]"
                      style={{ border: "1px solid var(--app-border)", background: "var(--app-content)", color: "var(--app-text-primary)" }}
                    >
                      <option value="">{t("allBranches")}</option>
                      {fileBranches.map((b) => <option key={b} value={b}>{b || t("unknownBranch")}</option>)}
                    </select>
                  )}
                  {viewMode !== "deleted" && labels.length > 0 && (
                    <select
                      value={labelFilter}
                      onChange={(e) => setLabelFilter(e.target.value)}
                      className="px-2 py-1 text-xs rounded-md outline-none max-w-[200px]"
                      style={{ border: "1px solid var(--app-border)", background: "var(--app-content)", color: "var(--app-text-primary)" }}
                    >
                      <option value="">{t("allVersions")}</option>
                      {labels.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                    </select>
                  )}
                </div>
              </div>

              {/* 项目恢复视图 */}
              {viewMode === "project-restore" ? (
                <div className="h-[600px] overflow-y-auto rounded-lg p-2" style={{ border: "1px solid var(--app-border)" }}>
                  {projectLabels.length === 0 ? (
                    <div className="py-5 text-center" style={{ color: "var(--app-text-tertiary)" }}>
                      {t("noSnapshots")}
                    </div>
                  ) : (
                    projectLabels.map((label) => (
                      <div key={label.id} className="flex items-center justify-between px-3 py-2.5 rounded-md mb-1 transition-colors hover:bg-[var(--app-hover)]">
                        <div className="flex items-center gap-2 flex-1 min-w-0">
                          <Badge
                            variant="outline"
                            className="text-[10px] px-1.5 h-[18px] shrink-0"
                            style={{ borderColor: getLabelColor(label.source), color: getLabelColor(label.source) }}
                          >
                            {label.source === "claude_session" ? t("labelSourceClaudeSession") : label.source === "restore" ? t("labelSourceRestore") : label.source}
                          </Badge>
                          <span className="text-[13px] truncate" style={{ color: "var(--app-text-primary)" }}>{label.name}</span>
                          <span className="text-[11px] shrink-0" style={{ color: "var(--app-text-tertiary)" }} title={formatFullTime(label.timestamp)}>
                            {formatRelativeTime(label.timestamp)}
                          </span>
                          <span className="text-[11px] shrink-0" style={{ color: "var(--app-text-tertiary)" }}>
                            {t("fileCount", { count: label.fileSnapshots.length })}
                          </span>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={restoring}
                          onClick={async () => {
                            if (!confirm(t("confirmRestoreToLabel", { name: label.name, count: label.fileSnapshots.length }))) return;
                            setRestoring(true);
                            try {
                              const restored = await localHistoryService.restoreToLabel(projectPath, label.id);
                              toast.success(t("filesRestored", { count: restored.length }));
                              onRestored?.();
                              await loadProjectLabels();
                            } catch (e) {
                              toast.error(t("restoreFailed", { error: getErrorMessage(e) }));
                            } finally {
                              setRestoring(false);
                            }
                          }}
                        >
                          <RotateCcw size={12} className="mr-1" /> {t("restoreToSnapshot")}
                        </Button>
                      </div>
                    ))
                  )}
                </div>
              ) : viewMode === "deleted" ? (
                <div className="max-h-[600px] overflow-y-auto rounded-lg p-2" style={{ border: "1px solid var(--app-border)" }}>
                  {deletedFiles.length === 0 ? (
                    <div className="py-5 text-center" style={{ color: "var(--app-text-tertiary)" }}>{t("noDeletedFiles")}</div>
                  ) : (
                    deletedFiles.map((file) => (
                      <div key={file.id} className="flex items-center justify-between px-3 py-2.5 rounded-md mb-1 transition-colors hover:bg-[var(--app-hover)]">
                        <div className="flex items-center gap-2 flex-1 min-w-0">
                          <Trash2 size={14} className="shrink-0 text-destructive" />
                          <span className="text-[13px] truncate" style={{ color: "var(--app-text-primary)" }}>{file.filePath}</span>
                          <span className="text-[11px] shrink-0" style={{ color: "var(--app-text-tertiary)" }} title={formatFullTime(file.createdAt)}>
                            {formatRelativeTime(file.createdAt)}
                          </span>
                          <span className="text-[11px] shrink-0" style={{ color: "var(--app-text-tertiary)" }}>{formatSize(file.size)}</span>
                        </div>
                        <Button size="sm" variant="outline" onClick={() => restoreDeletedFile(file)}>
                          <RotateCcw size={12} className="mr-1" /> {t("common:restore")}
                        </Button>
                      </div>
                    ))
                  )}
                </div>
              ) : (
                /* 版本列表 + 预览 */
                <div className="flex gap-4 h-[600px]">
                  {/* 左侧版本列表 */}
                  <div className="w-[260px] shrink-0 overflow-y-auto rounded-lg p-2" style={{ border: "1px solid var(--app-border)" }}>
                    {loading ? (
                      <div className="py-5 text-center" style={{ color: "var(--app-text-tertiary)" }}>{t("common:loading")}</div>
                    ) : filteredVersions.length === 0 ? (
                      <div className="py-5 text-center" style={{ color: "var(--app-text-tertiary)" }}>{t("noHistory")}</div>
                    ) : (
                      filteredVersions.map((version) => (
                        <div
                          key={version.id}
                          className="px-3 py-2.5 rounded-md cursor-pointer transition-all mb-1"
                          style={{
                            background: selectedVersion?.id === version.id ? "var(--app-active-bg)" : undefined,
                            borderLeft: selectedVersion?.id === version.id ? "3px solid var(--app-accent)" : "3px solid transparent",
                          }}
                          onClick={() => selectVersion(version)}
                          onContextMenu={(e) => { e.preventDefault(); openLabelDialog(version); }}
                        >
                          <div className="flex items-center gap-1.5 text-[13px]" style={{ color: "var(--app-text-primary)" }}>
                            <Clock size={12} />
                            <span title={formatFullTime(version.createdAt)}>{formatRelativeTime(version.createdAt)}</span>
                          </div>
                          <div className="text-[11px] mt-1 pl-[18px] flex items-center gap-2" style={{ color: "var(--app-text-tertiary)" }}>
                            <span>{formatSize(version.size)}</span>
                            {version.branch ? (
                              <Badge variant="outline" className="text-[10px] px-1 h-[18px]" style={{ borderColor: "#6366f1", color: "#6366f1" }}>
                                <GitBranch size={10} className="mr-1" />{version.branch}
                              </Badge>
                            ) : fileBranches.length > 1 ? (
                              <span className="text-[10px] opacity-60">{t("unknownBranch")}</span>
                            ) : null}
                          </div>
                          {getVersionLabels(version.id).length > 0 && (
                            <div className="flex flex-wrap gap-1 mt-1.5 pl-[18px]">
                              {getVersionLabels(version.id).map((label) => (
                                <Badge
                                  key={label.id}
                                  variant="outline"
                                  className="text-[10px] px-1.5 h-[18px]"
                                  style={{ borderColor: getLabelColor(label.source), color: getLabelColor(label.source) }}
                                >
                                  <Tag size={10} className="mr-1" />{label.name}
                                </Badge>
                              ))}
                            </div>
                          )}
                        </div>
                      ))
                    )}
                  </div>

                  {/* 右侧预览区域 */}
                  <div className="flex-1 rounded-lg overflow-hidden flex flex-col" style={{ border: "1px solid var(--app-border)" }}>
                    {!selectedVersion ? (
                      <div className="flex-1 flex flex-col items-center justify-center gap-3" style={{ color: "var(--app-text-tertiary)" }}>
                        <FileText size={48} />
                        <p>{t("selectVersionToView")}</p>
                        <p className="text-xs opacity-70">{t("rightClickForTag")}</p>
                      </div>
                    ) : loadingContent ? (
                      <div className="flex-1 flex items-center justify-center" style={{ color: "var(--app-text-tertiary)" }}>
                        {t("common:loading")}
                      </div>
                    ) : viewMode === "diff" ? (
                      <div className="flex-1 flex flex-col overflow-hidden">
                        {diffDescription && (
                          <div className="px-3 py-1.5 text-[11px] flex items-center gap-2 border-b shrink-0"
                               style={{ color: "var(--app-text-tertiary)", borderColor: "var(--app-border)" }}>
                            <Diff size={12} />
                            <span>{diffDescription}</span>
                          </div>
                        )}
                        <DiffView diff={diffResult} />
                      </div>
                    ) : (
                      <pre className="flex-1 m-0 p-3 overflow-auto text-xs leading-relaxed whitespace-pre-wrap break-all" style={{ background: "var(--app-content)" }}>
                        {versionContent}
                      </pre>
                    )}
                  </div>
                </div>
              )}

              {/* 操作按钮 */}
              {selectedVersion && viewMode !== "deleted" && viewMode !== "project-restore" && (
                <div className="flex justify-between items-center mt-4">
                  <Button variant="outline" size="sm" onClick={() => openLabelDialog(selectedVersion)}>
                    <Tag size={14} className="mr-1" /> {t("addTag")}
                  </Button>
                  <div className="flex gap-2">
                    <Button variant="outline" onClick={() => onOpenChange(false)}>{t("common:cancel")}</Button>
                    <Button onClick={restoreVersion}>
                      <RotateCcw size={14} className="mr-2" /> {t("restoreVersion")}
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* 添加标签对话框 */}
      <Dialog open={labelDialogOpen} onOpenChange={setLabelDialogOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("addTag")}</DialogTitle>
          </DialogHeader>
          <div className="py-4">
            <Input
              value={labelName}
              onChange={(e) => setLabelName(e.target.value)}
              placeholder={t("tagNamePlaceholder")}
              onKeyDown={(e) => { if (e.key === "Enter") confirmAddLabel(); }}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setLabelDialogOpen(false)}>{t("common:cancel")}</Button>
            <Button onClick={confirmAddLabel}>{t("common:confirm")}</Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
