import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { FolderOpen } from "lucide-react";
import { useWorkspacesStore, normalizedWorkspaceGroup } from "@/stores/useWorkspacesStore";
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
import ScanImportDialog from "@/components/ScanImportDialog";
import GitCloneDialog from "@/components/GitCloneDialog";
import type { ProjectPathStatus, Workspace, WorkspaceProject } from "@/types";
import ProjectMigrationDialog from "./ProjectMigrationDialog";
import MissingProjectsCleanupDialog from "./MissingProjectsCleanupDialog";
import type { ScannedRepo } from "@/services/workspaceService";

interface DialogFieldProps {
  open: boolean;
  setOpen: (v: boolean) => void;
}

interface TextDialogProps extends DialogFieldProps {
  title: string;
  placeholder: string;
  value: string;
  setValue: (v: string) => void;
  onConfirm: () => void;
}

function TextInputDialog({
  open,
  setOpen,
  title,
  placeholder,
  value,
  setValue,
  onConfirm,
}: TextDialogProps) {
  const { t } = useTranslation("dialogs");
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="py-4">
          <Input
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={placeholder}
            onKeyDown={(event) => event.key === "Enter" && onConfirm()}
          />
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => setOpen(false)}>
            {t("cancel", { ns: "common" })}
          </Button>
          <Button onClick={onConfirm}>{t("confirm", { ns: "common" })}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface ConfirmDialogProps extends DialogFieldProps {
  title: string;
  description: string;
  onConfirm: () => void;
  variant?: "default" | "destructive";
}

export function ConfirmDialog({
  open,
  setOpen,
  title,
  description,
  onConfirm,
  variant = "default",
}: ConfirmDialogProps) {
  const { t } = useTranslation("dialogs");
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <DialogDescription className="py-2 text-sm text-muted-foreground">
          {description}
        </DialogDescription>
        <DialogFooter>
          <Button variant="secondary" onClick={() => setOpen(false)}>
            {t("cancel", { ns: "common" })}
          </Button>
          <Button
            variant={variant === "destructive" ? "destructive" : "default"}
            onClick={onConfirm}
          >
            {t("confirm", { ns: "common" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export interface ConfirmDialogState {
  open: boolean;
  setOpen: (v: boolean) => void;
  title: string;
  description: string;
  onConfirm: () => void;
  variant?: "default" | "destructive";
}

export interface WorkspaceDialogsProps {
  newWorkspace: {
    open: boolean;
    setOpen: (v: boolean) => void;
    name: string;
    setName: (v: string) => void;
    path: string;
    setPath: (v: string) => void;
    group: string;
    setGroup: (v: string) => void;
    onSelectPath: () => void;
    onConfirm: () => void;
  };
  renameWorkspace: {
    open: boolean;
    setOpen: (v: boolean) => void;
    name: string;
    setName: (v: string) => void;
    onConfirm: () => void;
  };
  projectAlias: {
    open: boolean;
    setOpen: (v: boolean) => void;
    value: string;
    setValue: (v: string) => void;
    onConfirm: () => void;
  };
  workspaceAlias: {
    open: boolean;
    setOpen: (v: boolean) => void;
    value: string;
    setValue: (v: string) => void;
    onConfirm: () => void;
  };
  scan: {
    open: boolean;
    setOpen: (v: boolean) => void;
    results: ScannedRepo[];
    onConfirm: (paths: string[]) => void;
  };
  gitClone: {
    open: boolean;
    setOpen: (v: boolean) => void;
    workspaceName: string;
    onCloned: (path: string) => void;
  };
  projectMigration: {
    open: boolean;
    setOpen: (v: boolean) => void;
    workspace: Workspace | null;
    project: WorkspaceProject | null;
  };
  missingProjects: {
    open: boolean;
    setOpen: (v: boolean) => void;
    workspace: Workspace | null;
    statuses: ProjectPathStatus[];
    onConfirm: (projectIds: string[]) => void | Promise<void>;
  };
  confirm: ConfirmDialogState;
}

export default function WorkspaceDialogs(props: WorkspaceDialogsProps) {
  const { t } = useTranslation("dialogs");
  const {
    newWorkspace,
    renameWorkspace,
    projectAlias,
    workspaceAlias,
    scan,
    gitClone,
    projectMigration,
    missingProjects,
    confirm,
  } = props;
  // 现有分组名 → 新建弹窗分组输入的 datalist 补全
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const existingGroups = useMemo(() => {
    const values = new Set<string>();
    for (const ws of workspaces) {
      const group = normalizedWorkspaceGroup(ws);
      if (group) values.add(group);
    }
    return [...values];
  }, [workspaces]);

  return (
    <>
      <ConfirmDialog
        open={confirm.open}
        setOpen={confirm.setOpen}
        title={confirm.title}
        description={confirm.description}
        onConfirm={confirm.onConfirm}
        variant={confirm.variant}
      />

      <MissingProjectsCleanupDialog
        open={missingProjects.open}
        setOpen={missingProjects.setOpen}
        workspace={missingProjects.workspace}
        statuses={missingProjects.statuses}
        onConfirm={missingProjects.onConfirm}
      />

      <Dialog open={newWorkspace.open} onOpenChange={newWorkspace.setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("newWorkspace")}</DialogTitle>
          </DialogHeader>
          <div className="py-4 flex flex-col gap-3">
            <Input
              value={newWorkspace.name}
              onChange={(event) => newWorkspace.setName(event.target.value)}
              placeholder={t("workspaceNamePlaceholder")}
              onKeyDown={(event) => event.key === "Enter" && newWorkspace.onConfirm()}
            />
            <div className="flex gap-2">
              <Input
                value={newWorkspace.path}
                readOnly
                placeholder={t("workspaceAnchorPathPlaceholder")}
                className="flex-1"
              />
              <Button variant="secondary" onClick={newWorkspace.onSelectPath}>
                <FolderOpen size={14} className="mr-1" /> Browse
              </Button>
            </div>
            <Input
              value={newWorkspace.group}
              onChange={(event) => newWorkspace.setGroup(event.target.value)}
              placeholder={t("newWorkspaceGroupPlaceholder")}
              list="new-workspace-group-options"
              onKeyDown={(event) => event.key === "Enter" && newWorkspace.onConfirm()}
            />
            <datalist id="new-workspace-group-options">
              {existingGroups.map((group) => (
                <option key={group} value={group} />
              ))}
            </datalist>
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => newWorkspace.setOpen(false)}>
              {t("cancel", { ns: "common" })}
            </Button>
            <Button onClick={newWorkspace.onConfirm} disabled={!newWorkspace.name.trim()}>
              {t("create", { ns: "common", defaultValue: "Create" })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <TextInputDialog
        open={renameWorkspace.open}
        setOpen={renameWorkspace.setOpen}
        title={t("renameWorkspace")}
        placeholder={t("newNamePlaceholder")}
        value={renameWorkspace.name}
        setValue={renameWorkspace.setName}
        onConfirm={renameWorkspace.onConfirm}
      />

      <TextInputDialog
        open={projectAlias.open}
        setOpen={projectAlias.setOpen}
        title={t("setProjectAlias")}
        placeholder={t("projectAliasPlaceholder")}
        value={projectAlias.value}
        setValue={projectAlias.setValue}
        onConfirm={projectAlias.onConfirm}
      />

      <TextInputDialog
        open={workspaceAlias.open}
        setOpen={workspaceAlias.setOpen}
        title={t("setWorkspaceAlias")}
        placeholder={t("workspaceAliasPlaceholder")}
        value={workspaceAlias.value}
        setValue={workspaceAlias.setValue}
        onConfirm={workspaceAlias.onConfirm}
      />

      <ScanImportDialog
        open={scan.open}
        onOpenChange={scan.setOpen}
        repos={scan.results}
        onConfirm={scan.onConfirm}
      />

      <GitCloneDialog
        open={gitClone.open}
        onOpenChange={gitClone.setOpen}
        workspaceName={gitClone.workspaceName}
        onCloned={gitClone.onCloned}
      />

      <ProjectMigrationDialog
        open={projectMigration.open}
        onOpenChange={projectMigration.setOpen}
        workspace={projectMigration.workspace}
        project={projectMigration.project}
      />
    </>
  );
}
