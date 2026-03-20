import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { GitBranch, Plus, Trash2, FolderOpen, Terminal } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/sidebar/WorkspaceDialogs";
import { worktreeService, type WorktreeInfo } from "@/services";
import { openPath } from "@tauri-apps/plugin-opener";
import { handleError, handleErrorSilent } from "@/utils";

interface WorktreeManagerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectPath: string;
  onOpenWorktree: (path: string) => void;
}

export default function WorktreeManager({ open, onOpenChange, projectPath, onOpenWorktree }: WorktreeManagerProps) {
  const { t } = useTranslation(["dialogs", "common", "sidebar"]);
  const [loading, setLoading] = useState(false);
  const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([]);
  const [newName, setNewName] = useState("");
  const [newBranch, setNewBranch] = useState("");
  const [adding, setAdding] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingRemove, setPendingRemove] = useState<WorktreeInfo | null>(null);

  useEffect(() => {
    if (open) loadWorktrees();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function loadWorktrees() {
    if (!projectPath) return;
    setLoading(true);
    try {
      setWorktrees(await worktreeService.list(projectPath));
    } catch (e) {
      handleErrorSilent(e, "load worktrees");
      setWorktrees([]);
    } finally {
      setLoading(false);
    }
  }

  async function addWorktree() {
    if (!projectPath || !newName.trim()) return;
    setAdding(true);
    try {
      const branch = newBranch.trim() || undefined;
      await worktreeService.add(projectPath, newName.trim(), branch);
      await loadWorktrees();
      setNewName("");
      setNewBranch("");
    } catch (e) {
      handleError(e, "add worktree");
    } finally {
      setAdding(false);
    }
  }

  function requestRemoveWorktree(wt: WorktreeInfo) {
    if (wt.isMain) { toast.error(t("cannotDeleteMain")); return; }
    setPendingRemove(wt);
    setConfirmOpen(true);
  }

  const doRemoveWorktree = useCallback(async () => {
    if (!pendingRemove) return;
    setConfirmOpen(false);
    try {
      await worktreeService.remove(projectPath, pendingRemove.path);
      await loadWorktrees();
    } catch (e) {
      handleError(e, "remove worktree");
    } finally {
      setPendingRemove(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingRemove, projectPath, t]);

  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitBranch size={18} />
            {t("worktreeTitle")}
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-5">
          {/* 添加新 Worktree */}
          <div className="p-4 rounded-lg" style={{ border: "1px solid var(--app-border)", background: "var(--app-content)" }}>
            <h3 className="text-sm font-semibold mb-3" style={{ color: "var(--app-text-primary)" }}>{t("createWorktree")}</h3>
            <div className="flex gap-2 items-center">
              <Input className="flex-1" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={t("worktreeNamePlaceholder")} />
              <Input className="flex-1" value={newBranch} onChange={(e) => setNewBranch(e.target.value)} placeholder={t("branchNamePlaceholder")} />
              <Button disabled={!newName.trim() || adding} onClick={addWorktree}>
                <Plus size={14} className="mr-1" />
                {adding ? t("creating") : t("common:create")}
              </Button>
            </div>
          </div>

          {/* Worktree 列表 */}
          <div className="max-h-[300px] overflow-y-auto">
            <h3 className="text-sm font-semibold mb-3" style={{ color: "var(--app-text-primary)" }}>{t("existingWorktrees")}</h3>
            {loading ? (
              <div className="py-5 text-center" style={{ color: "var(--app-text-tertiary)" }}>{t("common:loading")}</div>
            ) : worktrees.length === 0 ? (
              <div className="py-5 text-center" style={{ color: "var(--app-text-tertiary)" }}>{t("noWorktrees")}</div>
            ) : (
              <div className="flex flex-col gap-2">
                {worktrees.map((wt) => (
                  <div
                    key={wt.path}
                    className="flex justify-between items-center p-3 rounded-lg"
                    style={{
                      border: `1px solid ${wt.isMain ? "var(--app-accent)" : "var(--app-border)"}`,
                      background: "var(--app-content)",
                    }}
                  >
                    <div className="flex-1">
                      <div className="flex items-center gap-1.5 font-medium" style={{ color: "var(--app-text-primary)" }}>
                        <GitBranch size={14} />
                        <span>{wt.branch || "(detached)"}</span>
                        {wt.isMain && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded text-white" style={{ background: "var(--app-accent)" }}>
                            {t("mainBadge")}
                          </span>
                        )}
                      </div>
                      <div className="text-xs mt-1" style={{ color: "var(--app-text-secondary)" }}>{wt.path}</div>
                      <div className="text-[11px] font-mono" style={{ color: "var(--app-text-tertiary)" }}>{wt.commit}</div>
                    </div>
                    <div className="flex gap-1">
                      <Button variant="ghost" size="sm" onClick={() => onOpenWorktree(wt.path)} title={t("sidebar:openHere")}>
                        <Terminal size={14} />
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => openPath(wt.path).catch((e) => handleErrorSilent(e, "open path"))} title={t("sidebar:openFolder")}>
                        <FolderOpen size={14} />
                      </Button>
                      {!wt.isMain && (
                        <Button variant="ghost" size="sm" onClick={() => requestRemoveWorktree(wt)} title={t("common:delete")}>
                          <Trash2 size={14} />
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
    <ConfirmDialog
      open={confirmOpen}
      setOpen={(v) => { setConfirmOpen(v); if (!v) setPendingRemove(null); }}
      title={t("deleteWorktree", { defaultValue: "删除 Worktree" })}
      description={t("confirmDeleteWorktree", { path: pendingRemove?.path ?? "" })}
      onConfirm={doRemoveWorktree}
      variant="destructive"
    />
    </>
  );
}
