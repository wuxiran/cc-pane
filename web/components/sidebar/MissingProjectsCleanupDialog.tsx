import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { FolderX, HelpCircle } from "lucide-react";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { getProjectName } from "@/utils";
import type { ProjectPathStatus, Workspace, WorkspaceProject } from "@/types";

export interface MissingProjectsCleanupDialogProps {
  open: boolean;
  setOpen: (open: boolean) => void;
  workspace: Workspace | null;
  statuses: ProjectPathStatus[];
  onConfirm: (projectIds: string[]) => void | Promise<void>;
}

interface Row {
  project: WorkspaceProject;
  path: string;
}

function collectRows(
  workspace: Workspace | null,
  statuses: ProjectPathStatus[],
  kind: "missing" | "unverifiable",
): Row[] {
  if (!workspace) return [];
  const byId = new Map(workspace.projects.map((project) => [project.id, project]));
  return statuses
    .filter((status) => status.status === kind)
    .flatMap((status) => {
      const project = byId.get(status.projectId);
      return project ? [{ project, path: status.path }] : [];
    });
}

/**
 * 失效项目批量清理。**只移除工作空间记录，不触碰磁盘上的任何文件。**
 *
 * `unverifiable`（WSL 发行版未运行 / SSH 远程）默认不勾选：那种状态下无法区分
 * 「路径真没了」与「暂时看不到」，默认勾选会诱导用户误删仍然有效的注册。
 */
export default function MissingProjectsCleanupDialog({
  open, setOpen, workspace, statuses, onConfirm,
}: MissingProjectsCleanupDialogProps) {
  const { t } = useTranslation(["sidebar", "common"]);
  const missing = useMemo(
    () => collectRows(workspace, statuses, "missing"),
    [workspace, statuses],
  );
  const unverifiable = useMemo(
    () => collectRows(workspace, statuses, "unverifiable"),
    [workspace, statuses],
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);

  // 每次打开都按「missing 全选、unverifiable 不选」重置
  useEffect(() => {
    if (!open) return;
    setSelected(new Set(missing.map((row) => row.project.id)));
    setSubmitting(false);
  }, [open, missing]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleConfirm = async () => {
    setSubmitting(true);
    try {
      await onConfirm([...selected]);
      setOpen(false);
    } finally {
      setSubmitting(false);
    }
  };

  const renderRow = (row: Row, muted: boolean) => (
    <label
      key={row.project.id}
      className={`flex cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-[var(--app-hover)] ${
        muted ? "text-[var(--app-text-tertiary)]" : "text-[var(--app-text-secondary)]"
      }`}
    >
      <input
        type="checkbox"
        className="mt-0.5 accent-[var(--app-accent)]"
        checked={selected.has(row.project.id)}
        onChange={() => toggle(row.project.id)}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] text-[var(--app-text-primary)]">
          {row.project.alias || getProjectName(row.path)}
        </span>
        <span className="block truncate text-[11px]" title={row.path}>{row.path}</span>
      </span>
    </label>
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FolderX size={16} />
            {t("missingProjectsTitle")}
          </DialogTitle>
        </DialogHeader>
        <DialogDescription className="text-sm text-muted-foreground">
          {t("missingProjectsDescription")}
        </DialogDescription>

        <div className="max-h-[45vh] overflow-y-auto">
          {missing.length === 0 && unverifiable.length === 0 ? (
            <div className="py-6 text-center text-sm text-[var(--app-text-tertiary)]">
              {t("missingProjectsEmpty")}
            </div>
          ) : null}
          {missing.map((row) => renderRow(row, false))}
          {unverifiable.length > 0 ? (
            <div className="mt-3 border-t border-[var(--app-border)] pt-3">
              <div className="flex items-center gap-1.5 px-2 pb-1 text-[11px] font-medium text-[var(--app-text-tertiary)]">
                <HelpCircle size={12} />
                {t("missingProjectsUnverifiableTitle")}
              </div>
              <div className="px-2 pb-1 text-[11px] text-[var(--app-text-tertiary)]">
                {t("missingProjectsUnverifiableHint")}
              </div>
              {unverifiable.map((row) => renderRow(row, true))}
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            {t("cancel", { ns: "common" })}
          </Button>
          <Button
            variant="destructive"
            disabled={selected.size === 0 || submitting}
            onClick={handleConfirm}
          >
            {t("missingProjectsConfirm", { count: selected.size })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
