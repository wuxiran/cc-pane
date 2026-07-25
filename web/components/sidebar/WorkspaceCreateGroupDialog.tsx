// 头部「新建分组」弹窗：组名 + 勾选成员。分组由工作空间字段派生（空组不存在），
// 因此新建分组必须至少带一个成员，逐个走 saveWorkspace 落盘。
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useWorkspacesStore, normalizedWorkspaceGroup } from "@/stores/useWorkspacesStore";

export default function WorkspaceCreateGroupDialog({
  open,
  setOpen,
}: {
  open: boolean;
  setOpen: (v: boolean) => void;
}) {
  const { t } = useTranslation("sidebar");
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const saveWorkspace = useWorkspacesStore((s) => s.saveWorkspace);
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // 默认工作空间恒置顶不参与分组
  const candidates = useMemo(() => workspaces.filter((ws) => !ws.isDefault), [workspaces]);

  const toggle = (wsName: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(wsName)) next.delete(wsName);
      else next.add(wsName);
      return next;
    });
  };

  const reset = () => {
    setName("");
    setSelected(new Set());
  };

  const confirm = async () => {
    const group = name.trim();
    if (!group || selected.size === 0) return;
    try {
      for (const ws of candidates.filter((w) => selected.has(w.name))) {
        await saveWorkspace({ ...ws, group });
      }
      setOpen(false);
      reset();
    } catch (e) {
      toast.error(t("workspaceAppearanceSaveFailed", { error: String(e) }));
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) reset(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("workspaceGroupDialogTitle")}</DialogTitle>
          <DialogDescription>{t("workspaceGroupCreateDescription")}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3 py-2">
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t("workspaceGroupPlaceholder")}
            autoFocus
          />
          <div className="max-h-56 overflow-y-auto rounded-md border border-[var(--app-border)] p-1">
            {candidates.map((ws) => {
              const checked = selected.has(ws.name);
              const currentGroup = normalizedWorkspaceGroup(ws);
              return (
                <button
                  type="button"
                  key={ws.id}
                  onClick={() => toggle(ws.name)}
                  aria-pressed={checked}
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-[var(--app-hover)]"
                >
                  <span
                    className={`flex size-3.5 shrink-0 items-center justify-center rounded-sm border ${checked ? "border-[var(--app-accent)] bg-[var(--app-accent)] text-white" : "border-[var(--app-border)]"}`}
                  >
                    {checked ? <Check className="size-2.5" /> : null}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{ws.alias || ws.name}</span>
                  {currentGroup ? (
                    <span className="shrink-0 text-[10px] text-[var(--app-text-tertiary)]">{currentGroup}</span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => setOpen(false)}>
            {t("cancel", { ns: "common" })}
          </Button>
          <Button onClick={confirm} disabled={!name.trim() || selected.size === 0}>
            {t("workspaceGroupSave")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
