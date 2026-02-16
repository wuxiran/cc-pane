import { useState, useEffect, useMemo, useRef } from "react";
import { toast } from "sonner";
import { History, RotateCcw, FileText, Clock, Tag, Trash2, Diff, Code, GitBranch } from "lucide-react";
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
} from "@/services";
import { formatRelativeTime, formatFullTime, formatSize } from "@/utils";

interface LocalHistoryPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectPath: string;
  filePath?: string;
  onRestored?: () => void;
}

type ViewMode = "diff" | "content" | "deleted";

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
  const [labelFilter, setLabelFilter] = useState("");
  const [branchFilter, setBranchFilter] = useState("");
  const [fileBranches, setFileBranches] = useState<string[]>([]);

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
      loadVersions();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 预计算 versionId -> labels 映射
  const versionLabelsMap = useMemo(() => {
    const map = new Map<string, HistoryLabel[]>();
    for (const label of labels) {
      for (const snap of label.file_snapshots) {
        if (snap.file_path === filePath) {
          const arr = map.get(snap.version_id) || [];
          arr.push(label);
          map.set(snap.version_id, arr);
        }
      }
    }
    return map;
  }, [labels, filePath]);

  // 筛选后的版本列表
  const filteredVersions = useMemo(() => {
    let result = versions;
    if (branchFilter) result = result.filter((v) => v.branch === branchFilter);
    if (labelFilter) {
      const targetLabel = labels.find((l) => l.id === labelFilter);
      if (targetLabel) {
        const versionIds = new Set(
          targetLabel.file_snapshots.filter((s) => s.file_path === filePath).map((s) => s.version_id)
        );
        result = result.filter((v) => versionIds.has(v.id));
      }
    }
    return result;
  }, [versions, branchFilter, labelFilter, labels, filePath]);

  async function loadVersions() {
    if (!projectPath || !filePath) return;
    setLoading(true);
    try {
      const [vers, lbls, branches] = await Promise.all([
        localHistoryService.listFileVersions(projectPath, filePath),
        localHistoryService.listLabels(projectPath),
        localHistoryService.getFileBranches(projectPath, filePath),
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
      if (viewMode === "diff" && filePath) {
        const result = await localHistoryService.getVersionDiff(projectPath, filePath, version.id);
        if (requestId !== selectRequestIdRef.current) return;
        setDiffResult(result);
      } else {
        const content = await localHistoryService.getVersionContent(projectPath, filePath || "", version.id);
        if (requestId !== selectRequestIdRef.current) return;
        setVersionContent(content);
      }
    } catch (e) {
      if (requestId !== selectRequestIdRef.current) return;
      console.error("Failed to load version:", e);
      setVersionContent("加载失败");
    } finally {
      // 始终重置 loading，避免被取消的请求导致 loading 永远为 true
      setLoadingContent(false);
    }
  }

  async function restoreVersion() {
    if (!selectedVersion) return;
    try {
      await localHistoryService.restoreFileVersion(projectPath, filePath || "", selectedVersion.id);
      onRestored?.();
      onOpenChange(false);
    } catch (e) {
      console.error("Failed to restore version:", e);
      toast.error("恢复失败: " + e);
    }
  }

  async function switchViewMode(mode: ViewMode) {
    setViewMode(mode);
    if (mode === "deleted") {
      await loadDeletedFiles();
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
        label_type: "manual",
        source: "user",
        timestamp: new Date().toISOString(),
        file_snapshots: [{ file_path: filePath || "", version_id: labelTarget.id }],
        branch: labelTarget.branch || "",
      };
      await localHistoryService.putLabel(projectPath, label);
      setLabels(await localHistoryService.listLabels(projectPath));
      setLabelDialogOpen(false);
    } catch (e) {
      console.error("Failed to add label:", e);
      toast.error("添加标签失败: " + e);
    }
  }

  async function restoreDeletedFile(file: FileVersion) {
    try {
      await localHistoryService.restoreFileVersion(projectPath, file.file_path, file.id);
      toast.success(`文件 ${file.file_path} 已恢复`);
      await loadDeletedFiles();
    } catch (e) {
      toast.error("恢复失败: " + e);
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
        <DialogContent className="max-w-5xl max-h-[85vh]" onKeyDown={handleKeydown}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <History size={18} />
              文件历史{filePath ? ` - ${filePath}` : ""}
            </DialogTitle>
          </DialogHeader>

          {!filePath ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3" style={{ color: "var(--app-text-tertiary)" }}>
              <FileText size={48} />
              <p>请从项目右键菜单中打开文件历史</p>
              <p className="text-xs opacity-70">或在编辑器中选择文件后查看历史</p>
            </div>
          ) : (
            <>
              {/* 工具栏 */}
              <div className="flex items-center justify-between gap-2 mb-2">
                <div className="flex gap-1">
                  <Button size="sm" variant={viewMode === "diff" ? "default" : "ghost"} onClick={() => switchViewMode("diff")}>
                    <Diff size={14} className="mr-1" /> 差异
                  </Button>
                  <Button size="sm" variant={viewMode === "content" ? "default" : "ghost"} onClick={() => switchViewMode("content")}>
                    <Code size={14} className="mr-1" /> 完整内容
                  </Button>
                  <Button size="sm" variant={viewMode === "deleted" ? "default" : "ghost"} onClick={() => switchViewMode("deleted")}>
                    <Trash2 size={14} className="mr-1" /> 已删除
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
                      <option value="">所有分支</option>
                      {fileBranches.map((b) => <option key={b} value={b}>{b || "未知分支"}</option>)}
                    </select>
                  )}
                  {viewMode !== "deleted" && labels.length > 0 && (
                    <select
                      value={labelFilter}
                      onChange={(e) => setLabelFilter(e.target.value)}
                      className="px-2 py-1 text-xs rounded-md outline-none max-w-[200px]"
                      style={{ border: "1px solid var(--app-border)", background: "var(--app-content)", color: "var(--app-text-primary)" }}
                    >
                      <option value="">全部版本</option>
                      {labels.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                    </select>
                  )}
                </div>
              </div>

              {/* 已删除文件视图 */}
              {viewMode === "deleted" ? (
                <div className="max-h-[450px] overflow-y-auto rounded-lg p-2" style={{ border: "1px solid var(--app-border)" }}>
                  {deletedFiles.length === 0 ? (
                    <div className="py-5 text-center" style={{ color: "var(--app-text-tertiary)" }}>暂无已删除的文件</div>
                  ) : (
                    deletedFiles.map((file) => (
                      <div key={file.id} className="flex items-center justify-between px-3 py-2.5 rounded-md mb-1 transition-colors hover:bg-[var(--app-hover)]">
                        <div className="flex items-center gap-2 flex-1 min-w-0">
                          <Trash2 size={14} className="shrink-0 text-destructive" />
                          <span className="text-[13px] truncate" style={{ color: "var(--app-text-primary)" }}>{file.file_path}</span>
                          <span className="text-[11px] shrink-0" style={{ color: "var(--app-text-tertiary)" }} title={formatFullTime(file.created_at)}>
                            {formatRelativeTime(file.created_at)}
                          </span>
                          <span className="text-[11px] shrink-0" style={{ color: "var(--app-text-tertiary)" }}>{formatSize(file.size)}</span>
                        </div>
                        <Button size="sm" variant="outline" onClick={() => restoreDeletedFile(file)}>
                          <RotateCcw size={12} className="mr-1" /> 恢复
                        </Button>
                      </div>
                    ))
                  )}
                </div>
              ) : (
                /* 版本列表 + 预览 */
                <div className="flex gap-4 h-[450px]">
                  {/* 左侧版本列表 */}
                  <div className="w-[260px] shrink-0 overflow-y-auto rounded-lg p-2" style={{ border: "1px solid var(--app-border)" }}>
                    {loading ? (
                      <div className="py-5 text-center" style={{ color: "var(--app-text-tertiary)" }}>加载中...</div>
                    ) : filteredVersions.length === 0 ? (
                      <div className="py-5 text-center" style={{ color: "var(--app-text-tertiary)" }}>暂无历史版本</div>
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
                            <span title={formatFullTime(version.created_at)}>{formatRelativeTime(version.created_at)}</span>
                          </div>
                          <div className="text-[11px] mt-1 pl-[18px] flex items-center gap-2" style={{ color: "var(--app-text-tertiary)" }}>
                            <span>{formatSize(version.size)}</span>
                            {version.branch ? (
                              <Badge variant="outline" className="text-[10px] px-1 h-[18px]" style={{ borderColor: "#6366f1", color: "#6366f1" }}>
                                <GitBranch size={10} className="mr-1" />{version.branch}
                              </Badge>
                            ) : fileBranches.length > 1 ? (
                              <span className="text-[10px] opacity-60">未知分支</span>
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
                        <p>选择一个版本查看内容</p>
                        <p className="text-xs opacity-70">右键版本可添加标签</p>
                      </div>
                    ) : loadingContent ? (
                      <div className="flex-1 flex items-center justify-center" style={{ color: "var(--app-text-tertiary)" }}>
                        加载中...
                      </div>
                    ) : viewMode === "diff" ? (
                      <DiffView diff={diffResult} />
                    ) : (
                      <pre className="flex-1 m-0 p-3 overflow-auto text-xs leading-relaxed whitespace-pre-wrap break-all" style={{ background: "var(--app-content)" }}>
                        {versionContent}
                      </pre>
                    )}
                  </div>
                </div>
              )}

              {/* 操作按钮 */}
              {selectedVersion && viewMode !== "deleted" && (
                <div className="flex justify-between items-center mt-4">
                  <Button variant="outline" size="sm" onClick={() => openLabelDialog(selectedVersion)}>
                    <Tag size={14} className="mr-1" /> 添加标签
                  </Button>
                  <div className="flex gap-2">
                    <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
                    <Button onClick={restoreVersion}>
                      <RotateCcw size={14} className="mr-2" /> 恢复此版本
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
            <DialogTitle>添加标签</DialogTitle>
          </DialogHeader>
          <div className="py-4">
            <Input
              value={labelName}
              onChange={(e) => setLabelName(e.target.value)}
              placeholder="标签名称（如：v1.0 发布前）"
              onKeyDown={(e) => { if (e.key === "Enter") confirmAddLabel(); }}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setLabelDialogOpen(false)}>取消</Button>
            <Button onClick={confirmAddLabel}>确定</Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
