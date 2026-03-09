import { useState, useEffect, useMemo, useCallback } from "react";
import { FileStack, Trash2, Loader2, Search, FileText } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { planService, type PlanEntry } from "@/services";
import { handleErrorSilent } from "@/utils";
import { useTranslation } from "react-i18next";

interface PlansPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectPath: string;
}

/** 格式化文件大小 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 格式化归档时间显示 */
function formatArchivedAt(iso: string): string {
  if (!iso) return "-";
  try {
    const d = new Date(iso);
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const hour = String(d.getHours()).padStart(2, "0");
    const min = String(d.getMinutes()).padStart(2, "0");
    return `${month}-${day} ${hour}:${min}`;
  } catch {
    return iso;
  }
}

export default function PlansPanel({ open, onOpenChange, projectPath }: PlansPanelProps) {
  const { t } = useTranslation("sidebar");
  const [plans, setPlans] = useState<PlanEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedFile, setSelectedFile] = useState<string>("");
  const [content, setContent] = useState<string>("");
  const [contentLoading, setContentLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  const panelTitle = useMemo(() => {
    if (projectPath) {
      const name = projectPath.replace(/\\/g, "/").split("/").pop() || projectPath;
      return `${t("planArchive")} - ${name}`;
    }
    return t("planArchive");
  }, [projectPath, t]);

  const filteredPlans = useMemo(() => {
    if (!searchQuery.trim()) return plans;
    const q = searchQuery.toLowerCase();
    return plans.filter(
      (p) =>
        p.originalName.toLowerCase().includes(q) ||
        p.sessionId.toLowerCase().includes(q) ||
        p.fileName.toLowerCase().includes(q)
    );
  }, [plans, searchQuery]);

  const loadPlans = useCallback(async () => {
    if (!projectPath) return;
    setLoading(true);
    try {
      const result = await planService.listPlans(projectPath);
      setPlans(result);
      // 自动选中第一个
      if (result.length > 0 && !selectedFile) {
        setSelectedFile(result[0].fileName);
      }
    } catch (e) {
      handleErrorSilent(e, "load plans");
      setPlans([]);
    } finally {
      setLoading(false);
    }
  }, [projectPath, selectedFile]);

  useEffect(() => {
    if (open) {
      setSearchQuery("");
      setContent("");
      setSelectedFile("");
      loadPlans();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, projectPath]);

  // 加载选中文件内容
  useEffect(() => {
    if (!selectedFile || !projectPath) {
      setContent("");
      return;
    }
    let cancelled = false;
    setContentLoading(true);
    planService
      .getPlanContent(projectPath, selectedFile)
      .then((c) => {
        if (!cancelled) setContent(c);
      })
      .catch((e) => {
        if (!cancelled) {
          handleErrorSilent(e, "load plan content");
          setContent("");
        }
      })
      .finally(() => {
        if (!cancelled) setContentLoading(false);
      });
    return () => { cancelled = true; };
  }, [selectedFile, projectPath]);

  async function handleDelete(fileName: string) {
    try {
      await planService.deletePlan(projectPath, fileName);
      setPlans((prev) => prev.filter((p) => p.fileName !== fileName));
      if (selectedFile === fileName) {
        setSelectedFile("");
        setContent("");
      }
    } catch (e) {
      handleErrorSilent(e, "delete plan");
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent resizable className="w-[56rem] h-[80vh] max-w-[95vw] max-h-[90vh]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileStack size={18} />
            {panelTitle}
          </DialogTitle>
        </DialogHeader>

        {loading ? (
          <div
            className="flex items-center justify-center gap-2 py-10 text-sm"
            style={{ color: "var(--app-text-tertiary)" }}
          >
            <Loader2 size={20} className="animate-spin" />
            <span>{t("planArchive")}...</span>
          </div>
        ) : plans.length === 0 ? (
          <div
            className="flex flex-col items-center justify-center gap-2 py-10 text-sm"
            style={{ color: "var(--app-text-tertiary)" }}
          >
            <FileText size={32} strokeWidth={1.5} />
            <span>No archived plans</span>
          </div>
        ) : (
          <div className="flex gap-3 flex-1 min-h-0 overflow-hidden">
            {/* 左侧列表 */}
            <div
              className="flex flex-col w-[220px] shrink-0 rounded-lg overflow-hidden"
              style={{ border: "1px solid var(--app-border)" }}
            >
              {/* 搜索框 */}
              <div className="p-2" style={{ borderBottom: "1px solid var(--app-border)" }}>
                <div className="relative">
                  <Search
                    size={14}
                    className="absolute left-2 top-1/2 -translate-y-1/2"
                    style={{ color: "var(--app-text-tertiary)" }}
                  />
                  <Input
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search..."
                    className="h-7 pl-7 text-xs"
                  />
                </div>
              </div>

              {/* 列表 */}
              <div className="flex-1 overflow-y-auto">
                {filteredPlans.map((plan) => (
                  <div
                    key={plan.fileName}
                    className="group flex flex-col px-2.5 py-2 cursor-pointer transition-colors"
                    style={{
                      borderBottom: "1px solid var(--app-border)",
                      background: selectedFile === plan.fileName ? "var(--app-hover)" : undefined,
                    }}
                    onClick={() => setSelectedFile(plan.fileName)}
                  >
                    <div className="flex items-center justify-between">
                      <span
                        className="text-[11px] font-mono"
                        style={{ color: "var(--app-accent)" }}
                      >
                        {plan.sessionId || "no-session"}
                      </span>
                      <span
                        className="text-[10px]"
                        style={{ color: "var(--app-text-tertiary)" }}
                      >
                        {formatArchivedAt(plan.archivedAt)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between mt-0.5">
                      <span
                        className="text-[12px] truncate flex-1 mr-1"
                        style={{ color: "var(--app-text-primary)" }}
                        title={plan.originalName}
                      >
                        {plan.originalName}
                      </span>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-5 w-5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDelete(plan.fileName);
                        }}
                      >
                        <Trash2 size={12} />
                      </Button>
                    </div>
                    <span
                      className="text-[10px] mt-0.5"
                      style={{ color: "var(--app-text-tertiary)" }}
                    >
                      {formatSize(plan.size)}
                    </span>
                  </div>
                ))}
                {filteredPlans.length === 0 && (
                  <div
                    className="flex items-center justify-center py-6 text-xs"
                    style={{ color: "var(--app-text-tertiary)" }}
                  >
                    No matches
                  </div>
                )}
              </div>
            </div>

            {/* 右侧内容 */}
            <div
              className="flex-1 rounded-lg overflow-hidden flex flex-col min-w-0"
              style={{ border: "1px solid var(--app-border)" }}
            >
              {contentLoading ? (
                <div
                  className="flex items-center justify-center gap-2 flex-1 text-sm"
                  style={{ color: "var(--app-text-tertiary)" }}
                >
                  <Loader2 size={16} className="animate-spin" />
                </div>
              ) : content ? (
                <pre
                  className="flex-1 overflow-auto p-4 m-0 text-[13px] leading-relaxed whitespace-pre-wrap break-words"
                  style={{
                    color: "var(--app-text-primary)",
                    fontFamily: "var(--font-mono, monospace)",
                  }}
                >
                  {content}
                </pre>
              ) : (
                <div
                  className="flex items-center justify-center flex-1 text-sm"
                  style={{ color: "var(--app-text-tertiary)" }}
                >
                  Select a plan to preview
                </div>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
