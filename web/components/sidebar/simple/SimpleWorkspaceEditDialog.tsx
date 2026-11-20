// 简洁模式的「编辑工作空间」对话框：显示名 + 项目文件夹（增 / 删）+ 移除工作空间。
// 文件夹的增删先记在对话框里，点保存才落到后端——取消就什么都不动。
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { open as openDirectoryDialog } from "@tauri-apps/plugin-dialog";
import { Folder, FolderPlus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { isTauriRuntime } from "@/services/runtime";
import { useWorkspacesStore } from "@/stores";
import type { Workspace } from "@/types";
import { getErrorMessage, getProjectName } from "@/utils";
import { normalizePath, primaryFolder, workspaceFolders } from "./simpleExplorerModel";

interface SimpleWorkspaceEditDialogProps {
  workspace: Workspace | null;
  onOpenChange: (open: boolean) => void;
}

export default function SimpleWorkspaceEditDialog({ workspace, onOpenChange }: SimpleWorkspaceEditDialogProps) {
  const { t } = useTranslation(["sidebar", "common"]);
  const [name, setName] = useState("");
  const [removedIds, setRemovedIds] = useState<string[]>([]);
  const [addedPaths, setAddedPaths] = useState<string[]>([]);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [busy, setBusy] = useState(false);

  // 每次打开都从这个工作空间的当前状态重新开始。
  const workspaceId = workspace?.id ?? null;
  useEffect(() => {
    if (!workspace) return;
    setName(workspace.alias || workspace.name);
    setRemovedIds([]);
    setAddedPaths([]);
    setConfirmingRemove(false);
    setBusy(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  const folders = useMemo(() => (workspace ? workspaceFolders(workspace) : []), [workspace]);
  const primaryId = workspace ? primaryFolder(workspace)?.id : undefined;
  const keptFolders = folders.filter((folder) => !removedIds.includes(folder.id));

  if (!workspace) return null;

  const addFolder = async () => {
    try {
      const selected = isTauriRuntime()
        ? await openDirectoryDialog({ directory: true, multiple: false, title: t("selectProjectDir") })
        : window.prompt(t("selectProjectDir"));
      if (!selected) return;
      const path = String(selected);
      const key = normalizePath(path);
      const known = [...keptFolders.map((folder) => folder.path), ...addedPaths].some((item) => normalizePath(item) === key);
      if (!known) setAddedPaths((current) => [...current, path]);
    } catch (error) {
      toast.error(getErrorMessage(error));
    }
  };

  const save = async () => {
    const store = useWorkspacesStore.getState();
    const nextName = name.trim();
    setBusy(true);
    try {
      if (nextName && nextName !== (workspace.alias || workspace.name)) {
        // 改的是显示名（别名）。工作空间的真实名字是它在磁盘和各处引用里的身份，不在这里动。
        await store.updateWorkspaceAlias(workspace.name, nextName === workspace.name ? null : nextName);
      }
      for (const id of removedIds) await store.removeProject(workspace.name, id);
      for (const path of addedPaths) await store.addProject(workspace.name, path);
      onOpenChange(false);
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const removeWorkspace = async () => {
    setBusy(true);
    try {
      // 归档而不是删除：不动磁盘上的任何东西，之后还能在完整模式的「含已归档」里恢复。
      await useWorkspacesStore.getState().setArchived(workspace.name, true);
      toast.success(t("simple.workspaceRemoved", { name: workspace.alias || workspace.name }));
      onOpenChange(false);
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const rowClass = "flex items-center gap-2.5 px-3 py-2.5 text-[length:var(--text-row)] text-[var(--app-text-primary)]";

  return (
    <Dialog open onOpenChange={(next) => { if (!busy) onOpenChange(next); }}>
      <DialogContent className="sm:max-w-md" data-testid="simple-workspace-edit">
        <DialogHeader>
          <DialogTitle>{t("simple.editWorkspace")}</DialogTitle>
          <DialogDescription className="sr-only">{t("simple.editWorkspaceHint")}</DialogDescription>
        </DialogHeader>

        <label className="flex items-center overflow-hidden rounded-lg border border-[var(--app-border)] focus-within:border-[var(--app-text-tertiary)]">
          <span className="flex size-10 shrink-0 items-center justify-center border-r border-[var(--app-border)] text-[var(--app-text-tertiary)]">
            <Folder className="size-4" aria-hidden="true" />
          </span>
          <input
            aria-label={t("simple.workspaceName")}
            value={name}
            disabled={busy}
            onChange={(event) => setName(event.target.value)}
            className="h-10 min-w-0 flex-1 bg-transparent px-3 text-[length:var(--text-row)] text-[var(--app-text-primary)] outline-none"
          />
        </label>

        <div>
          <p className="mb-1.5 text-[length:var(--text-small)] font-medium text-[var(--app-text-secondary)]">{t("simple.folders")}</p>
          <ul className="divide-y divide-[var(--app-border)] overflow-hidden rounded-lg border border-[var(--app-border)]">
            {keptFolders.map((folder) => (
              <li key={folder.id} className={rowClass} title={folder.path} data-testid="simple-edit-folder">
                <Folder className="size-4 shrink-0 text-[var(--app-text-tertiary)]" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">{folder.alias || getProjectName(folder.path)}</span>
                {folder.id === primaryId && (
                  <span className="shrink-0 rounded-full border border-[var(--app-border)] px-2 py-0.5 text-[length:var(--text-micro)] text-[var(--app-text-secondary)]">
                    {t("simple.primaryFolder")}
                  </span>
                )}
                <button
                  type="button"
                  disabled={busy}
                  aria-label={t("simple.removeFolder", { name: folder.alias || getProjectName(folder.path) })}
                  className="flex size-6 shrink-0 items-center justify-center rounded text-[var(--app-text-tertiary)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-text-primary)]"
                  onClick={() => setRemovedIds((current) => [...current, folder.id])}
                >
                  <X className="size-3.5" aria-hidden="true" />
                </button>
              </li>
            ))}
            {addedPaths.map((path) => (
              <li key={path} className={rowClass} title={path} data-testid="simple-edit-folder">
                <Folder className="size-4 shrink-0 text-[var(--app-text-tertiary)]" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">{getProjectName(path)}</span>
                <button
                  type="button"
                  disabled={busy}
                  aria-label={t("simple.removeFolder", { name: getProjectName(path) })}
                  className="flex size-6 shrink-0 items-center justify-center rounded text-[var(--app-text-tertiary)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-text-primary)]"
                  onClick={() => setAddedPaths((current) => current.filter((item) => item !== path))}
                >
                  <X className="size-3.5" aria-hidden="true" />
                </button>
              </li>
            ))}
            <li>
              <button
                type="button"
                disabled={busy}
                className={`${rowClass} w-full text-left transition-colors hover:bg-[var(--app-hover)]`}
                onClick={() => void addFolder()}
              >
                <FolderPlus className="size-4 shrink-0 text-[var(--app-text-tertiary)]" aria-hidden="true" />
                {t("simple.addFolder")}
              </button>
            </li>
          </ul>
          <p className="mt-1.5 text-[length:var(--text-micro)] text-[var(--app-text-tertiary)]">{t("simple.foldersHint")}</p>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="destructive"
            disabled={busy}
            onClick={() => (confirmingRemove ? void removeWorkspace() : setConfirmingRemove(true))}
          >
            {t(confirmingRemove ? "simple.removeWorkspaceConfirm" : "simple.removeWorkspace")}
          </Button>
          <span className="flex-1" />
          <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
            {t("cancel", { ns: "common" })}
          </Button>
          <Button disabled={busy || !name.trim()} onClick={() => void save()}>
            {t("save", { ns: "common" })}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
