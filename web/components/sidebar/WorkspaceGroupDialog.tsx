import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useWorkspacesStore } from "@/stores";
import type { Workspace } from "@/types";

interface WorkspaceGroupDialogProps {
  workspace: Workspace;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function WorkspaceGroupDialog({
  workspace,
  open,
  onOpenChange,
}: WorkspaceGroupDialogProps) {
  const { t } = useTranslation(["sidebar", "common"]);
  const saveWorkspace = useWorkspacesStore((state) => state.saveWorkspace);
  const [group, setGroup] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) setGroup(workspace.group?.trim() ?? "");
  }, [open, workspace.group]);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const normalized = group.trim();
    if (!normalized || saving) return;
    setSaving(true);
    try {
      await saveWorkspace({ ...workspace, group: normalized });
      onOpenChange(false);
    } catch (error) {
      toast.error(t("workspaceAppearanceSaveFailed", { error }));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <form
          onSubmit={(event) => void handleSubmit(event)}
          className="space-y-4"
        >
          <DialogHeader>
            <DialogTitle>{t("workspaceGroupDialogTitle")}</DialogTitle>
            <DialogDescription>
              {t("workspaceGroupDialogDescription", {
                name: workspace.alias || workspace.name,
              })}
            </DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={group}
            onChange={(event) => setGroup(event.target.value)}
            placeholder={t("workspaceGroupPlaceholder")}
          />
          <DialogFooter>
            <Button
              type="button"
              variant="secondary"
              onClick={() => onOpenChange(false)}
            >
              {t("cancel", { ns: "common" })}
            </Button>
            <Button type="submit" disabled={!group.trim() || saving}>
              {t("workspaceGroupSave")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
