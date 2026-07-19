import { useState, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  localHistoryService,
  type FileVersion,
  type DiffResult,
  type HistoryLabel,
  type RecentChange,
} from "@/services";
import { formatRelativeTime, getErrorMessage } from "@/utils";

export type ViewMode = "diff" | "content" | "deleted" | "project-restore";

export function getLabelColor(source: string): string {
  const colors: Record<string, string> = {
    git_commit: "#f59e0b",
    claude_session: "#8b5cf6",
    user: "#3b82f6",
    build: "#10b981",
    restore: "#ef4444",
  };
  return colors[source] || "#6b7280";
}

interface UseLocalHistoryDataParams {
  open: boolean;
  projectPath: string;
  filePath?: string;
  onOpenChange: (open: boolean) => void;
  onRestored?: () => void;
}

export function useLocalHistoryData({
  open,
  projectPath,
  filePath,
  onOpenChange,
  onRestored,
}: UseLocalHistoryDataParams) {
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

  async function restoreLabelSnapshot(label: HistoryLabel) {
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

  return {
    // state
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
    internalFilePath,
    recentChanges,
    fileListLoading,
    // derived
    effectiveFilePath,
    filteredVersions,
    // setters
    setLabelDialogOpen,
    setLabelName,
    setLabelFilter,
    setBranchFilter,
    setInternalFilePath,
    // actions
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
  };
}
