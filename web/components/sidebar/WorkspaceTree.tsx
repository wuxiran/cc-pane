import { useState, useCallback, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { open } from "@tauri-apps/plugin-dialog";
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { useWorkspacesStore } from "@/stores";
import { useActivityBarStore } from "@/stores/useActivityBarStore";
import { useDialogStore } from "@/stores/useDialogStore";
import { worktreeService } from "@/services";
import WorktreeManager from "@/components/WorktreeManager";
import { useWorkspaceActions } from "./useWorkspaceActions";
import WorkspaceDialogs from "./WorkspaceDialogs";
import WorkspaceItem from "./WorkspaceItem";
import ProjectListView from "./ProjectListView";
import type { Workspace, WorkspaceProject, OpenTerminalOptions } from "@/types";

interface WorkspaceTreeProps {
  onOpenTerminal: (opts: OpenTerminalOptions) => void;
}

export function getReorderedWorkspaceNames(
  workspaces: Workspace[],
  activeId: string,
  overId: string,
): string[] | null {
  const oldIndex = workspaces.findIndex((workspace) => workspace.id === activeId);
  const newIndex = workspaces.findIndex((workspace) => workspace.id === overId);
  if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) {
    return null;
  }

  const activeWorkspace = workspaces[oldIndex];
  const overWorkspace = workspaces[newIndex];
  if (!!activeWorkspace.pinned !== !!overWorkspace.pinned) {
    return null;
  }

  return arrayMove(workspaces, oldIndex, newIndex).map((workspace) => workspace.name);
}

interface SortableWorkspaceItemProps {
  ws: Workspace;
  expanded: boolean;
  onExpand: (wsId: string) => void;
  onOpenTerminal: (opts: OpenTerminalOptions) => void;
  onRename: (ws: Workspace) => void;
  onDelete: (ws: Workspace) => void;
  onSetAlias: (ws: Workspace) => void;
  onImportProject: (ws: Workspace) => void;
  onScanImport: (ws: Workspace) => void;
  onGitClone: (ws: Workspace) => void;
  onSetPath: (ws: Workspace) => void;
  onClearPath: (ws: Workspace) => void;
  onOpenEnvironment: (ws: Workspace) => void;
  onOpenInFileBrowser?: (path: string) => void;
  children: ReactNode;
}

function SortableWorkspaceItem(props: SortableWorkspaceItemProps) {
  const { ws } = props;
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: ws.id });

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.65 : undefined,
      }}
    >
      <WorkspaceItem
        {...props}
        dragHandleProps={{
          ...attributes,
          ...listeners,
        }}
      />
    </div>
  );
}

export default function WorkspaceTree({ onOpenTerminal }: WorkspaceTreeProps) {
  const { t } = useTranslation(["sidebar", "common"]);
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const expandedWorkspaceId = useWorkspacesStore((s) => s.expandedWorkspaceId);
  const expandWorkspace = useWorkspacesStore((s) => s.expandWorkspace);
  const updateWorkspacePath = useWorkspacesStore((s) => s.updateWorkspacePath);
  const reorderWorkspaces = useWorkspacesStore((s) => s.reorder);
  const openWorkspaceEnvironment = useDialogStore((s) => s.openWorkspaceEnvironment);

  // useWorkspaceActions 处理 dialog 状态 + 工作空间/项目 CRUD
  const actions = useWorkspaceActions({
    onOpenTerminal: (opts) => onOpenTerminal(opts),
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

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  );

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

  const handleDragEnd = useCallback(async ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const orderedNames = getReorderedWorkspaceNames(
      useWorkspacesStore.getState().workspaces,
      String(active.id),
      String(over.id),
    );
    if (!orderedNames) return;

    try {
      await reorderWorkspaces(orderedNames);
    } catch (e) {
      toast.error(t("reorderFailed", { error: e }));
    }
  }, [reorderWorkspaces, t]);

  return (
    <>
      {/* Section: 工作空间 */}
      <div className="flex items-center justify-between px-3 py-3 mt-1 mb-1">
        <span className="text-[11px] font-bold uppercase tracking-wider text-[var(--app-text-tertiary)]">
          {t("workspaces")}
        </span>
      </div>

      <DndContext
        collisionDetection={closestCenter}
        onDragEnd={(event: DragEndEvent) => void handleDragEnd(event)}
        sensors={sensors}
      >
        <SortableContext
          items={workspaces.map((workspace) => workspace.id)}
          strategy={verticalListSortingStrategy}
        >
          <div className="flex flex-col gap-1">
            {workspaces.map((ws) => (
              <SortableWorkspaceItem
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
                onOpenEnvironment={(workspace) => openWorkspaceEnvironment(workspace.id)}
                onOpenInFileBrowser={handleOpenInFileBrowser}
              >
                <ProjectListView
                  projects={ws.projects}
                  ws={ws}
                  gitBranches={actions.gitBranches}
                  onOpenTerminal={onOpenTerminal}
                  onRemoveProject={actions.handleRemoveProject}
                  onSetProjectAlias={actions.handleSetAlias}
                  onImportProject={actions.handleImportProject}
                  onMigrateProject={actions.handleMigrateProject}
                  onOpenWorktreeManager={handleOpenWorktreeManager}
                  onOpenInFileBrowser={handleOpenInFileBrowser}
                />
              </SortableWorkspaceItem>
            ))}

            {workspaces.length === 0 && (
              <div className="py-4 text-center text-xs text-[var(--app-text-tertiary)]">
                {t("noWorkspaces")}
              </div>
            )}
          </div>
        </SortableContext>
      </DndContext>

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
        onOpenWorktree={(path) => onOpenTerminal({ path, workspaceName: worktreeManagerWs?.name, workspacePath: worktreeManagerWs?.path })}
      />
    </>
  );
}
