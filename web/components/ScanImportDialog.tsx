import { useState, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ChevronDown, ChevronRight, Folder, FolderOpen } from "lucide-react";
import type { ScannedRepo } from "@/services/workspaceService";

interface ScanImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repos: ScannedRepo[];
  onConfirm: (paths: string[]) => void;
}

function pathName(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || path;
}

export default function ScanImportDialog({
  open,
  onOpenChange,
  repos,
  onConfirm,
}: ScanImportDialogProps) {
  const { t } = useTranslation(["dialogs", "common"]);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [expandedRepos, setExpandedRepos] = useState<Set<number>>(new Set());

  const totalPaths = useMemo(() => {
    let count = 0;
    for (const repo of repos) {
      count += 1 + repo.worktrees.length;
    }
    return count;
  }, [repos]);

  // 初始化选择
  useEffect(() => {
    if (open && repos.length > 0) {
      const paths = new Set<string>();
      for (const repo of repos) {
        paths.add(repo.mainPath);
        for (const wt of repo.worktrees) {
          paths.add(wt.path);
        }
      }
      setSelectedPaths(paths);
      setExpandedRepos(new Set(repos.map((_, i) => i)));
    }
  }, [open, repos]);

  function toggleAll() {
    if (selectedPaths.size === totalPaths) {
      setSelectedPaths(new Set());
    } else {
      const paths = new Set<string>();
      for (const repo of repos) {
        paths.add(repo.mainPath);
        for (const wt of repo.worktrees) {
          paths.add(wt.path);
        }
      }
      setSelectedPaths(paths);
    }
  }

  function togglePath(path: string) {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function toggleRepo(repo: ScannedRepo) {
    const allPaths = [repo.mainPath, ...repo.worktrees.map((w) => w.path)];
    const allSelected = allPaths.every((p) => selectedPaths.has(p));
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      for (const p of allPaths) {
        if (allSelected) next.delete(p);
        else next.add(p);
      }
      return next;
    });
  }

  function toggleExpand(index: number) {
    setExpandedRepos((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  function handleConfirm() {
    onConfirm(Array.from(selectedPaths));
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>{t("scanTitle")}</DialogTitle>
        </DialogHeader>

        <div className="text-xs py-1" style={{ color: "var(--app-text-secondary)" }}>
          {t("scanSummary", { repoCount: repos.length, totalCount: totalPaths })}
        </div>

        {/* 全选 */}
        <div
          className="flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer text-xs transition-colors hover:bg-accent"
          style={{ color: "var(--app-text-secondary)" }}
          onClick={toggleAll}
        >
          <input
            type="checkbox"
            checked={selectedPaths.size === totalPaths}
            readOnly
            className="cursor-pointer shrink-0"
          />
          <span>{selectedPaths.size === totalPaths ? t("scanDeselectAll") : t("scanSelectAll")}</span>
          <Badge variant="secondary" className="ml-auto">
            {selectedPaths.size}/{totalPaths}
          </Badge>
        </div>

        {/* 仓库列表 */}
        <div className="flex-1 overflow-y-auto max-h-[400px] flex flex-col gap-1 py-1">
          {repos.map((repo, idx) => (
            <div key={repo.mainPath} className="rounded-md overflow-hidden" style={{ border: "1px solid var(--app-border)" }}>
              <div
                className="flex items-center gap-1.5 px-2.5 py-2 cursor-pointer transition-colors hover:bg-accent"
                onClick={() => toggleExpand(idx)}
              >
                {expandedRepos.has(idx) ? (
                  <ChevronDown size={14} className="shrink-0" style={{ color: "var(--app-text-tertiary)" }} />
                ) : (
                  <ChevronRight size={14} className="shrink-0" style={{ color: "var(--app-text-tertiary)" }} />
                )}
                <input
                  type="checkbox"
                  checked={[repo.mainPath, ...repo.worktrees.map((w) => w.path)].every((p) => selectedPaths.has(p))}
                  readOnly
                  className="cursor-pointer shrink-0"
                  onClick={(e) => { e.stopPropagation(); toggleRepo(repo); }}
                />
                <Folder size={14} className="shrink-0" style={{ color: "var(--app-accent)" }} />
                <span className="flex-1 text-[13px] font-medium truncate" style={{ color: "var(--app-text-primary)" }}>
                  {pathName(repo.mainPath)}
                </span>
                {repo.mainBranch && (
                  <Badge variant="outline" className="text-[10px] px-1 shrink-0">
                    {repo.mainBranch}
                  </Badge>
                )}
                {repo.worktrees.length > 0 && (
                  <Badge variant="secondary" className="text-[10px] px-1 shrink-0">
                    +{repo.worktrees.length} wt
                  </Badge>
                )}
              </div>

              {expandedRepos.has(idx) && (
                <div className="flex flex-col gap-0.5 px-1.5 py-1" style={{ borderTop: "1px solid var(--app-border)" }}>
                  <div
                    className="flex items-center gap-1.5 px-2 py-1 pl-7 rounded cursor-pointer transition-colors hover:bg-accent"
                    onClick={() => togglePath(repo.mainPath)}
                  >
                    <input
                      type="checkbox"
                      checked={selectedPaths.has(repo.mainPath)}
                      readOnly
                      className="cursor-pointer shrink-0"
                      onClick={(e) => { e.stopPropagation(); togglePath(repo.mainPath); }}
                    />
                    <Folder size={12} className="shrink-0" style={{ color: "var(--app-text-tertiary)" }} />
                    <span className="flex-1 text-xs truncate" style={{ color: "var(--app-text-primary)" }}>
                      {pathName(repo.mainPath)}
                    </span>
                    <Badge variant="outline" className="text-[9px] px-1 h-4 shrink-0">
                      {t("mainBadge")}
                    </Badge>
                  </div>

                  {repo.worktrees.map((wt) => (
                    <div
                      key={wt.path}
                      className="flex items-center gap-1.5 px-2 py-1 pl-7 rounded cursor-pointer transition-colors hover:bg-accent"
                      onClick={() => togglePath(wt.path)}
                    >
                      <input
                        type="checkbox"
                        checked={selectedPaths.has(wt.path)}
                        readOnly
                        className="cursor-pointer shrink-0"
                        onClick={(e) => { e.stopPropagation(); togglePath(wt.path); }}
                      />
                      <FolderOpen size={12} className="shrink-0 opacity-70" style={{ color: "var(--app-accent)" }} />
                      <span className="flex-1 text-xs truncate" style={{ color: "var(--app-text-primary)" }}>
                        {pathName(wt.path)}
                      </span>
                      {wt.branch && (
                        <Badge variant="outline" className="text-[9px] px-1 shrink-0">
                          {wt.branch}
                        </Badge>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>{t("common:cancel")}</Button>
          <Button disabled={selectedPaths.size === 0} onClick={handleConfirm}>
            {t("importCount", { count: selectedPaths.size })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
