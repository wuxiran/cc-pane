import { useState, useEffect } from "react";
import { toast } from "sonner";
import { GitBranch, Plus, Trash2, FolderOpen } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { worktreeService, type WorktreeInfo } from "@/services";

interface WorktreeManagerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectPath: string;
  onOpenWorktree: (path: string) => void;
}

export default function WorktreeManager({ open, onOpenChange, projectPath, onOpenWorktree }: WorktreeManagerProps) {
  const [loading, setLoading] = useState(false);
  const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([]);
  const [newName, setNewName] = useState("");
  const [newBranch, setNewBranch] = useState("");
  const [adding, setAdding] = useState(false);

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
      console.error("Failed to load worktrees:", e);
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
      console.error("Failed to add worktree:", e);
      toast.error("创建 Worktree 失败: " + e);
    } finally {
      setAdding(false);
    }
  }

  async function removeWorktree(wt: WorktreeInfo) {
    if (wt.is_main) { toast.error("不能删除主工作目录"); return; }
    if (!confirm(`确定要删除 Worktree "${wt.path}" 吗？`)) return;
    try {
      await worktreeService.remove(projectPath, wt.path);
      await loadWorktrees();
    } catch (e) {
      console.error("Failed to remove worktree:", e);
      toast.error("删除 Worktree 失败: " + e);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitBranch size={18} />
            Git Worktree 管理
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-5">
          {/* 添加新 Worktree */}
          <div className="p-4 rounded-lg" style={{ border: "1px solid var(--app-border)", background: "var(--app-content)" }}>
            <h3 className="text-sm font-semibold mb-3" style={{ color: "var(--app-text-primary)" }}>创建新 Worktree</h3>
            <div className="flex gap-2 items-center">
              <Input className="flex-1" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="名称（如：feature-login）" />
              <Input className="flex-1" value={newBranch} onChange={(e) => setNewBranch(e.target.value)} placeholder="分支名（可选）" />
              <Button disabled={!newName.trim() || adding} onClick={addWorktree}>
                <Plus size={14} className="mr-1" />
                {adding ? "创建中..." : "创建"}
              </Button>
            </div>
          </div>

          {/* Worktree 列表 */}
          <div className="max-h-[300px] overflow-y-auto">
            <h3 className="text-sm font-semibold mb-3" style={{ color: "var(--app-text-primary)" }}>现有 Worktree</h3>
            {loading ? (
              <div className="py-5 text-center" style={{ color: "var(--app-text-tertiary)" }}>加载中...</div>
            ) : worktrees.length === 0 ? (
              <div className="py-5 text-center" style={{ color: "var(--app-text-tertiary)" }}>暂无 Worktree</div>
            ) : (
              <div className="flex flex-col gap-2">
                {worktrees.map((wt) => (
                  <div
                    key={wt.path}
                    className="flex justify-between items-center p-3 rounded-lg"
                    style={{
                      border: `1px solid ${wt.is_main ? "var(--app-accent)" : "var(--app-border)"}`,
                      background: "var(--app-content)",
                    }}
                  >
                    <div className="flex-1">
                      <div className="flex items-center gap-1.5 font-medium" style={{ color: "var(--app-text-primary)" }}>
                        <GitBranch size={14} />
                        <span>{wt.branch || "(detached)"}</span>
                        {wt.is_main && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded text-white" style={{ background: "var(--app-accent)" }}>
                            主目录
                          </span>
                        )}
                      </div>
                      <div className="text-xs mt-1" style={{ color: "var(--app-text-secondary)" }}>{wt.path}</div>
                      <div className="text-[11px] font-mono" style={{ color: "var(--app-text-tertiary)" }}>{wt.commit}</div>
                    </div>
                    <div className="flex gap-1">
                      <Button variant="ghost" size="sm" onClick={() => onOpenWorktree(wt.path)} title="在此目录打开">
                        <FolderOpen size={14} />
                      </Button>
                      {!wt.is_main && (
                        <Button variant="ghost" size="sm" onClick={() => removeWorktree(wt)} title="删除">
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
  );
}
