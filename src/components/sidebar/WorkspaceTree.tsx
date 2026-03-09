import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { open } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { useWorkspacesStore } from "@/stores";
import { useActivityBarStore } from "@/stores/useActivityBarStore";
import { worktreeService } from "@/services";
import WorktreeManager from "@/components/WorktreeManager";
import { useWorkspaceActions } from "./useWorkspaceActions";
import WorkspaceDialogs from "./WorkspaceDialogs";
import WorkspaceItem from "./WorkspaceItem";
import ProjectListView from "./ProjectListView";
import type { Workspace, WorkspaceProject } from "@/types";

interface WorkspaceTreeProps {
  onOpenTerminal: (path: string, workspaceName?: string, providerId?: string, workspacePath?: string, launchClaude?: boolean) => void;
}

export default function WorkspaceTree({ onOpenTerminal }: WorkspaceTreeProps) {
  const { t } = useTranslation(["sidebar", "common"]);
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const expandedWorkspaceId = useWorkspacesStore((s) => s.expandedWorkspaceId);
  const expandWorkspace = useWorkspacesStore((s) => s.expandWorkspace);
  const updateWorkspacePath = useWorkspacesStore((s) => s.updateWorkspacePath);

  // useWorkspaceActions 处理 dialog 状态 + 工作空间/项目 CRUD
  const actions = useWorkspaceActions({
    onOpenTerminal: (path, wsName, providerId) => onOpenTerminal(path, wsName, providerId),
  });

  // Worktree Manager 本地状态
  const [worktreeManagerOpen, setWorktreeManagerOpen] = useState(false);
  const [worktreeManagerProjectPath, setWorktreeManagerProjectPath] = useState("");
  const [worktreeManagerWs, setWorktreeManagerWs] = useState<Workspace | undefined>();

  const handleOpenWorktreeManager = useCallback((project: WorkspaceProject, ws: Workspace) => {
    setWorktreeManagerProjectPath(project.path);
    setWorktreeManagerWs(ws);
    setWorktreeManagerOpen(true);
  }, []);

  const handleOpenInFileBrowser = useCallback((path: string) => {
    import("@/stores/useFileBrowserStore").then(({ useFileBrowserStore }) => {
      useFileBrowserStore.getState().navigateTo(path);
    });
    useActivityBarStore.getState().toggleFilesMode();
  }, []);

  // 工作空间路径管理
  const handleSetWorkspacePath = useCallback(async (ws: Workspace) => {
    try {
      const selected = await open({ directory: true, multiple: false, title: t("selectWorkspaceRoot") });
      if (selected) {
        await updateWorkspacePath(ws.name, selected);
        toast.success(t("workspacePathSet"));
      }
    } catch (e) {
      toast.error(t("setPathFailed", { error: e }));
    }
  }, [t, updateWorkspacePath]);

  const handleClearWorkspacePath = useCallback(async (ws: Workspace) => {
    try {
      await updateWorkspacePath(ws.name, null);
      toast.success(t("workspacePathCleared"));
    } catch (e) {
      toast.error(t("clearPathFailed", { error: e }));
    }
  }, [t, updateWorkspacePath]);

  return (
    <>
      {/* Section: 工作空间 */}
      <div className="flex items-center justify-between px-3 py-3 mt-1 mb-1">
        <span className="text-[11px] font-bold uppercase tracking-wider text-[var(--app-text-tertiary)]">
          {t("workspaces")}
        </span>
      </div>

      <div className="flex flex-col gap-1">
        {workspaces.map((ws) => (
          <WorkspaceItem
            key={ws.id}
            ws={ws}
            expanded={expandedWorkspaceId === ws.id}
            onExpand={expandWorkspace}
            onOpenTerminal={onOpenTerminal}
            onRename={actions.handleRenameWorkspace}
            onDelete={actions.handleDeleteWorkspace}
            onSetAlias={actions.handleSetWorkspaceAlias}
            onImportProject={actions.handleImportProject}
            onScanImport={actions.handleScanImport}
            onGitClone={actions.handleGitClone}
            onSetPath={handleSetWorkspacePath}
            onClearPath={handleClearWorkspacePath}
            onSetProvider={actions.handleSetWorkspaceProvider}
          >
            <ProjectListView
              projects={ws.projects}
              ws={ws}
              gitBranches={actions.gitBranches}
              onOpenTerminal={onOpenTerminal}
              onRemoveProject={actions.handleRemoveProject}
              onSetProjectAlias={actions.handleSetAlias}
              onImportProject={actions.handleImportProject}
              onOpenWorktreeManager={handleOpenWorktreeManager}
              onOpenInFileBrowser={handleOpenInFileBrowser}
            />
          </WorkspaceItem>
        ))}

        {workspaces.length === 0 && (
          <div className="text-xs text-center py-4 text-[var(--app-text-tertiary)]">
            {t("noWorkspaces")}
          </div>
        )}
      </div>

      {/* 新建工作空间按钮 */}
      <button
        className="w-full mt-2 flex items-center justify-center gap-2 py-2.5 rounded-xl border border-dashed text-xs font-medium transition-all group border-[var(--app-border)] text-[var(--app-text-tertiary)] hover:border-[var(--app-accent)] hover:text-[var(--app-accent)] hover:bg-[var(--app-active-bg)]"
        onClick={actions.handleCreateWorkspace}
      >
        <Plus className="w-3.5 h-3.5 transition-transform group-hover:rotate-90" />
        {t("newWorkspace")}
      </button>

      {/* Dialogs */}
      <WorkspaceDialogs {...actions.dialogs} />

      <WorktreeManager
        open={worktreeManagerOpen}
        onOpenChange={(open) => {
          setWorktreeManagerOpen(open);
          if (!open && worktreeManagerProjectPath) {
            worktreeService.list(worktreeManagerProjectPath).catch(() => {});
          }
        }}
        projectPath={worktreeManagerProjectPath}
        onOpenWorktree={(path) => onOpenTerminal(path, worktreeManagerWs?.name, worktreeManagerWs?.providerId, worktreeManagerWs?.path)}
      />
    </>
  );
}
