import { useState, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Clock, FileText, Tag, RefreshCw, GitBranch, FolderGit2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { localHistoryService, type RecentChange, type WorktreeRecentChange } from "@/services";
import { formatRelativeTime, formatFullTime, formatSize, getFileName, getDirName, handleErrorSilent } from "@/utils";

interface RecentChangesPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectPath: string;
  onOpenFileHistory: (filePath: string) => void;
}

export default function RecentChangesPanel({ open, onOpenChange, projectPath, onOpenFileHistory }: RecentChangesPanelProps) {
  const { t } = useTranslation(["dialogs", "common"]);
  const [changes, setChanges] = useState<RecentChange[]>([]);
  const [worktreeChanges, setWorktreeChanges] = useState<WorktreeRecentChange[]>([]);
  const [loading, setLoading] = useState(false);
  const [showAllWorktrees, setShowAllWorktrees] = useState(false);

  const groupedWorktreeChanges = useMemo(() => {
    const groups: Record<string, { path: string; branch: string; isMain: boolean; changes: RecentChange[] }> = {};
    for (const wc of worktreeChanges) {
      if (!groups[wc.worktreePath]) {
        groups[wc.worktreePath] = { path: wc.worktreePath, branch: wc.worktreeBranch, isMain: wc.isMain, changes: [] };
      }
      groups[wc.worktreePath].changes.push(wc.change);
    }
    return Object.values(groups).sort((a, b) => {
      if (a.isMain && !b.isMain) return -1;
      if (!a.isMain && b.isMain) return 1;
      return 0;
    });
  }, [worktreeChanges]);

  useEffect(() => {
    if (open) {
      setShowAllWorktrees(false);
      loadChanges();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (open) loadChanges();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showAllWorktrees]);

  async function loadChanges() {
    if (!projectPath) return;
    setLoading(true);
    try {
      if (showAllWorktrees) {
        setWorktreeChanges(await localHistoryService.listWorktreeRecentChanges(projectPath, 100));
      } else {
        setChanges(await localHistoryService.getRecentChanges(projectPath, 100));
      }
    } catch (e) {
      handleErrorSilent(e, "load recent changes");
      setChanges([]);
      setWorktreeChanges([]);
    } finally {
      setLoading(false);
    }
  }

  function handleClickChange(filePath: string) {
    onOpenFileHistory(filePath);
    onOpenChange(false);
  }

  function renderChangeItem(change: RecentChange, indent = false) {
    return (
      <div
        key={`${change.filePath}-${change.versionId}`}
        className="flex items-center gap-3 px-3 py-2.5 rounded-md cursor-pointer transition-colors hover:bg-[var(--app-hover)]"
        style={indent ? { paddingLeft: 24 } : undefined}
        onClick={() => handleClickChange(change.filePath)}
      >
        <div className="shrink-0" style={{ color: "var(--app-text-tertiary)" }}>
          <FileText size={14} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[13px] truncate" style={{ color: "var(--app-text-primary)" }}>
            <span style={{ color: "var(--app-text-tertiary)" }}>{getDirName(change.filePath)}</span>
            <span className="font-medium">{getFileName(change.filePath)}</span>
          </div>
          <div className="flex gap-3 text-[11px] mt-0.5" style={{ color: "var(--app-text-tertiary)" }}>
            <span title={formatFullTime(change.timestamp)}>{formatRelativeTime(change.timestamp)}</span>
            <span>{formatSize(change.size)}</span>
            {change.branch && (
              <Badge variant="outline" className="text-[10px] px-1 h-4" style={{ borderColor: "#6366f1", color: "#6366f1" }}>
                <GitBranch size={10} className="mr-1" />
                {change.branch}
              </Badge>
            )}
          </div>
        </div>
        {change.labelName && (
          <Badge variant="outline" className="shrink-0 text-[10px]">
            <Tag size={10} className="mr-1" />
            {change.labelName}
          </Badge>
        )}
      </div>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[80vh]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Clock size={18} />
            {t("recentChangesTitle")}
            <div className="ml-auto flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowAllWorktrees(!showAllWorktrees)}
                title={t("recentChangesAllWorktrees")}
                style={showAllWorktrees ? { background: "var(--app-active-bg)", color: "var(--app-accent)" } : undefined}
              >
                <FolderGit2 size={14} />
              </Button>
              <Button variant="ghost" size="sm" onClick={loadChanges}>
                <RefreshCw size={14} />
              </Button>
            </div>
          </DialogTitle>
        </DialogHeader>

        <div className="max-h-[500px] overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-16" style={{ color: "var(--app-text-tertiary)" }}>
              {t("common:loading")}
            </div>
          ) : !showAllWorktrees ? (
            changes.length === 0 ? (
              <div className="flex items-center justify-center py-16" style={{ color: "var(--app-text-tertiary)" }}>
                {t("recentChangesNoChanges")}
              </div>
            ) : (
              changes.map((change) => renderChangeItem(change))
            )
          ) : groupedWorktreeChanges.length === 0 ? (
            <div className="flex items-center justify-center py-16" style={{ color: "var(--app-text-tertiary)" }}>
              {t("recentChangesNoChanges")}
            </div>
          ) : (
            groupedWorktreeChanges.map((group) => (
              <div key={group.path} className="mb-4">
                <div
                  className="flex items-center gap-2 px-3 py-2 text-xs mb-1"
                  style={{ color: "var(--app-text-secondary)", borderBottom: "1px solid var(--app-border)" }}
                >
                  <FolderGit2 size={14} />
                  <span className="font-medium flex-1 min-w-0 truncate" style={{ color: "var(--app-text-primary)" }}>
                    {group.path}
                  </span>
                  <Badge variant="outline" className="text-[10px] px-1 h-4" style={{ borderColor: "#6366f1", color: "#6366f1" }}>
                    <GitBranch size={10} className="mr-1" />
                    {group.branch || t("recentChangesUnknownBranch")}
                  </Badge>
                  {group.isMain && <Badge variant="secondary" className="text-[10px] px-1 h-4 shrink-0">{t("recentChangesMainRepo")}</Badge>}
                </div>
                {group.changes.map((change) => renderChangeItem(change, true))}
              </div>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
