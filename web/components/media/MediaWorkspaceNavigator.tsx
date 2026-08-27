import { useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { ChevronRight, Folder, FolderOpen, FolderPlus, Grid2X2, Import, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  sidebarEntityCountClass,
  sidebarEntityRowClass,
  sidebarSectionCountClass,
  sidebarSectionHeaderClass,
  sidebarSectionTitleClass,
} from "@/components/sidebar/sidebarStyles";
import { isTauriRuntime } from "@/services/runtime";
import { useWorkspacesStore } from "@/stores";
import { getErrorMessage } from "@/utils";
import type { Workspace, WorkspaceProject } from "@/types";

interface MediaWorkspaceNavigatorProps {
  workspaceId: string | null;
  projectId: string | null;
  onWorkspaceChange: (workspaceId: string) => void;
  onProjectChange: (projectId: string) => void;
  onCreateCanvas: (scope: { workspaceId: string; projectId: string | null }) => void;
}

function projectName(project: WorkspaceProject): string {
  return project.alias?.trim() || project.path.split(/[\\/]/).filter(Boolean).pop() || project.path;
}

export default function MediaWorkspaceNavigator({
  workspaceId,
  projectId,
  onWorkspaceChange,
  onProjectChange,
  onCreateCanvas,
}: MediaWorkspaceNavigatorProps) {
  const { t } = useTranslation("media");
  const workspaces = useWorkspacesStore((state) => state.workspaces);
  const loading = useWorkspacesStore((state) => state.loading);
  const load = useWorkspacesStore((state) => state.load);
  const create = useWorkspacesStore((state) => state.create);
  const addProject = useWorkspacesStore((state) => state.addProject);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [rootPath, setRootPath] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (workspaces.length === 0) void load().catch(() => undefined);
  }, [load, workspaces.length]);

  useEffect(() => {
    if (!workspaceId && workspaces[0]) {
      onWorkspaceChange(workspaces[0].id);
      return;
    }
    if (workspaceId && !workspaces.some((workspace) => workspace.id === workspaceId)) {
      onWorkspaceChange(workspaces[0]?.id ?? "");
    }
  }, [onWorkspaceChange, workspaceId, workspaces]);

  const selectedWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === workspaceId),
    [workspaceId, workspaces],
  );

  useEffect(() => {
    if (!selectedWorkspace) return;
    setExpanded((current) => ({ ...current, [selectedWorkspace.id]: true }));
    const activeProject = selectedWorkspace.projects.find((project) => project.id === projectId);
    if (!activeProject && selectedWorkspace.projects[0]) onProjectChange(selectedWorkspace.projects[0].id);
  }, [onProjectChange, projectId, selectedWorkspace]);

  async function importProject(workspace: Workspace) {
    try {
      const selected = isTauriRuntime()
        ? await open({ directory: true, multiple: false, title: t("importProjectDialogTitle") })
        : window.prompt(t("projectDirectoryPrompt"));
      if (!selected) return;
      const project = await addProject(workspace.name, String(selected));
      onWorkspaceChange(workspace.id);
      onProjectChange(project.id);
      setExpanded((current) => ({ ...current, [workspace.id]: true }));
    } catch (error) {
      toast.error(t("importProjectFailed", { message: getErrorMessage(error) }));
    }
  }

  async function selectRoot() {
    if (!isTauriRuntime()) {
      const selected = window.prompt(t("workspaceDirectoryPrompt"), rootPath);
      if (selected) setRootPath(selected);
      return;
    }
    const selected = await open({ directory: true, multiple: false, title: t("chooseWorkspaceDirectory") });
    if (selected) setRootPath(String(selected));
  }

  async function createWorkspace() {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const workspace = await create(name.trim(), rootPath.trim() || undefined);
      onWorkspaceChange(workspace.id);
      setExpanded((current) => ({ ...current, [workspace.id]: true }));
      setName("");
      setRootPath("");
      setCreateOpen(false);
    } catch (error) {
      toast.error(t("createWorkspaceFailed", { message: getErrorMessage(error) }));
    } finally {
      setBusy(false);
    }
  }

  function selectWorkspace(workspace: Workspace) {
    const isSelected = workspace.id === workspaceId;
    const isExpanded = expanded[workspace.id] ?? isSelected;
    if (!isSelected) {
      onWorkspaceChange(workspace.id);
      setExpanded((current) => ({ ...current, [workspace.id]: true }));
      return;
    }
    setExpanded((current) => ({ ...current, [workspace.id]: !isExpanded }));
  }

  return (
    <section className="shrink-0 border-b border-[var(--app-border)] pb-3" data-testid="media-workspace-navigator">
      <div className={sidebarSectionHeaderClass}>
        <div className="flex min-w-0 items-center gap-2">
          <FolderOpen className="size-3.5 shrink-0" style={{ color: "var(--app-accent)" }} aria-hidden="true" />
          <span className={sidebarSectionTitleClass}>{t("workspace")}</span>
          <span className={sidebarSectionCountClass} style={{ background: "color-mix(in srgb, var(--app-text-primary) 8%, transparent)" }}>{workspaces.length}</span>
        </div>
        <Button type="button" variant="ghost" size="icon-xs" aria-label={t("newWorkspace")} title={t("newWorkspace")} onClick={() => setCreateOpen(true)}>
          <Plus aria-hidden="true" />
        </Button>
      </div>

      <div className="max-h-56 space-y-1 overflow-y-auto px-2">
        {loading && workspaces.length === 0 ? (
          <div className="px-2 py-4 text-xs" style={{ color: "var(--app-text-tertiary)" }}>{t("loadingWorkspaces")}</div>
        ) : workspaces.length === 0 ? (
          <div className="px-2 py-4 text-xs" style={{ color: "var(--app-text-tertiary)" }}>{t("noWorkspaces")}</div>
        ) : workspaces.map((workspace) => {
          const isSelected = workspace.id === workspaceId;
          const isExpanded = expanded[workspace.id] ?? isSelected;
          const displayName = workspace.alias || workspace.name;
          return (
            <div key={workspace.id}>
              <ContextMenu>
                <ContextMenuTrigger asChild>
                  <button
                    type="button"
                    aria-expanded={isExpanded}
                    className={`${sidebarEntityRowClass} flex items-center justify-between gap-2 text-left ${isSelected ? "bg-[var(--app-active-bg)] text-[var(--app-accent)]" : "text-[var(--app-text-primary)] hover:bg-[var(--app-hover)]"}`}
                    onClick={() => selectWorkspace(workspace)}
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      <ChevronRight className={`size-3.5 shrink-0 transition-transform ${isExpanded ? "rotate-90" : ""}`} aria-hidden="true" />
                      {isExpanded ? <FolderOpen className="size-4 shrink-0" aria-hidden="true" /> : <Folder className="size-4 shrink-0" aria-hidden="true" />}
                      <span className="truncate text-[13px] font-medium">{displayName}</span>
                      {workspace.isDefault ? <span className="shrink-0 text-[10px]" style={{ color: "var(--app-text-tertiary)" }}>{t("defaultBadge")}</span> : null}
                    </span>
                    <span className={sidebarEntityCountClass}>{workspace.projects.length}</span>
                  </button>
                </ContextMenuTrigger>
                <ContextMenuContent className="w-56">
                  <ContextMenuItem onSelect={() => void importProject(workspace)}>
                    <Import /> {t("importProject")}
                  </ContextMenuItem>
                  <ContextMenuItem onSelect={() => onCreateCanvas({ workspaceId: workspace.id, projectId: null })}>
                    <Grid2X2 /> {t("createWorkspaceCanvas")}
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>

              {isExpanded ? (
                <div className="ml-[22px] border-l border-[var(--app-border)] pl-3">
                  <div className="flex flex-col gap-0.5 py-1">
                    {workspace.projects.map((project) => {
                      const active = isSelected && project.id === projectId;
                      return (
                        <ContextMenu key={project.id}>
                          <ContextMenuTrigger asChild>
                            <button
                              type="button"
                              className={`flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] transition-colors ${active ? "bg-[var(--app-active-bg)] text-[var(--app-accent)]" : "text-[var(--app-text-secondary)] hover:bg-[var(--app-hover)] hover:text-[var(--app-text-primary)]"}`}
                              title={project.path}
                              onClick={() => { onWorkspaceChange(workspace.id); onProjectChange(project.id); }}
                            >
                              <Folder className="size-3.5 shrink-0" aria-hidden="true" />
                              <span className="min-w-0 flex-1 truncate">{projectName(project)}</span>
                            </button>
                          </ContextMenuTrigger>
                          <ContextMenuContent className="w-52">
                            <ContextMenuItem onSelect={() => onCreateCanvas({ workspaceId: workspace.id, projectId: project.id })}>
                              <Grid2X2 /> {t("createProjectCanvas")}
                            </ContextMenuItem>
                          </ContextMenuContent>
                        </ContextMenu>
                      );
                    })}
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      <button type="button" className="group mx-2 mt-2 flex w-[calc(100%-1rem)] items-center justify-center gap-2 rounded-lg border border-[var(--app-border)] bg-[var(--app-hover)] py-2 text-xs font-medium text-[var(--app-text-secondary)] transition-colors hover:border-[color-mix(in_srgb,var(--app-accent)_45%,transparent)] hover:bg-[color-mix(in_srgb,var(--app-accent)_8%,transparent)] hover:text-[var(--app-accent)]" onClick={() => setCreateOpen(true)}>
        <FolderPlus className="size-3.5 transition-transform group-hover:rotate-90" aria-hidden="true" />
        <span>{t("newWorkspace")}</span>
      </button>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t("createWorkspaceDialogTitle")}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5"><Label htmlFor="media-workspace-name">{t("name")}</Label><Input id="media-workspace-name" value={name} onChange={(event) => setName(event.target.value)} autoFocus /></div>
            <div className="space-y-1.5"><Label htmlFor="media-workspace-root">{t("rootDirectoryOptional")}</Label><div className="flex gap-2"><Input id="media-workspace-root" value={rootPath} onChange={(event) => setRootPath(event.target.value)} placeholder={t("workspaceRootPlaceholder")} /><Button type="button" variant="outline" size="icon" aria-label={t("chooseDirectory")} title={t("chooseDirectory")} onClick={() => void selectRoot()}><FolderOpen aria-hidden="true" /></Button></div></div>
          </div>
          <DialogFooter><Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>{t("cancel")}</Button><Button type="button" disabled={!name.trim() || busy} onClick={() => void createWorkspace()}>{t("create")}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
