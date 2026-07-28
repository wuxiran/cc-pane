import { Fragment, useState, useCallback, useEffect, useMemo, type ReactNode } from "react";
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
import { Plus, FolderGit2, FolderTree, ListFilter } from "lucide-react";
import { IconTooltipButton } from "@/components/ui/IconTooltipButton";
import WorkspaceCreateGroupDialog from "./WorkspaceCreateGroupDialog";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/EmptyState";
import { useWorkspacesStore } from "@/stores";
import { useActivityBarStore } from "@/stores/useActivityBarStore";
import { useDialogStore } from "@/stores/useDialogStore";
import { useLayoutUiStore } from "@/stores/useLayoutUiStore";
import {
  filterWorkspaces,
  normalizedWorkspaceGroup,
  UNGROUPED_WORKSPACE_FILTER,
} from "@/stores/useWorkspacesStore";
import { isTauriRuntime } from "@/services/runtime";
import WorktreeManager from "@/components/WorktreeManager";
import { useWorkspaceActions } from "./useWorkspaceActions";
import WorkspaceDialogs from "./WorkspaceDialogs";
import WorkspaceItem from "./WorkspaceItem";
import WorkspaceFilterBar from "./WorkspaceFilterBar";
import WorkspaceGroupHeader from "./WorkspaceGroupHeader";
import ProjectListView from "./ProjectListView";
import type { Workspace, WorkspaceProject, OpenTerminalOptions } from "@/types";

interface WorkspaceTreeProps {
  onOpenTerminal: (opts: OpenTerminalOptions) => void;
  /** Explorer 分区模式：由外层提供分区头（替换内置的「工作空间」分组头），拿到计数与新建入口 */
  renderSectionHeader?: (ctx: {
    count: number;
    filterActive: boolean;
    filterOpen: boolean;
    onCreateWorkspace: () => void;
    onToggleFilter: () => void;
  }) => ReactNode;
  /** Explorer 分区模式：折叠时隐藏树主体（Dialogs 保持挂载） */
  collapsed?: boolean;
}

interface WorkspacePartition {
  defaults: Workspace[];
  groups: Array<{ group: string; workspaces: Workspace[] }>;
  ungrouped: Workspace[];
}

function partitionWorkspaces(workspaces: Workspace[]): WorkspacePartition {
  const defaults: Workspace[] = [];
  const ungrouped: Workspace[] = [];
  const groupMap = new Map<string, Workspace[]>();

  for (const workspace of workspaces) {
    if (workspace.isDefault) {
      defaults.push(workspace);
      continue;
    }
    const group = normalizedWorkspaceGroup(workspace);
    if (!group) {
      ungrouped.push(workspace);
      continue;
    }
    const members = groupMap.get(group) ?? [];
    members.push(workspace);
    groupMap.set(group, members);
  }

  return {
    defaults,
    groups: [...groupMap].map(([group, members]) => ({ group, workspaces: members })),
    ungrouped,
  };
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
  // 默认工作空间恒置顶，不参与拖拽排序
  if (activeWorkspace.isDefault || overWorkspace.isDefault) {
    return null;
  }
  if (!!activeWorkspace.pinned !== !!overWorkspace.pinned) {
    return null;
  }
  const activeGroup = activeWorkspace.group?.trim() || null;
  const overGroup = overWorkspace.group?.trim() || null;
  if (activeGroup !== overGroup) {
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
  } = useSortable({ id: ws.id, disabled: !!ws.isDefault });

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
        dragHandleProps={ws.isDefault ? undefined : {
          ...attributes,
          ...listeners,
        }}
      />
    </div>
  );
}

export default function WorkspaceTree({ onOpenTerminal, renderSectionHeader, collapsed = false }: WorkspaceTreeProps) {
  const { t } = useTranslation(["sidebar", "common"]);
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const loading = useWorkspacesStore((s) => s.loading);
  const workspaceFilter = useWorkspacesStore((s) => s.workspaceFilter);
  const clearWorkspaceFilter = useWorkspacesStore((s) => s.clearWorkspaceFilter);
  const expandedWorkspaceId = useWorkspacesStore((s) => s.expandedWorkspaceId);
  const expandWorkspace = useWorkspacesStore((s) => s.expandWorkspace);
  const updateWorkspacePath = useWorkspacesStore((s) => s.updateWorkspacePath);
  const reorderWorkspaces = useWorkspacesStore((s) => s.reorder);
  const collapsedWorkspaceGroups = useLayoutUiStore((s) => s.collapsedWorkspaceGroups);
  const toggleWorkspaceGroup = useLayoutUiStore((s) => s.toggleWorkspaceGroup);
  const openWorkspaceEnvironment = useDialogStore((s) => s.openWorkspaceEnvironment);
  const [filterOpen, setFilterOpen] = useState(false);
  const [createGroupOpen, setCreateGroupOpen] = useState(false);
  const visibleWorkspaces = useMemo(
    () => filterWorkspaces(workspaces, workspaceFilter),
    [workspaces, workspaceFilter],
  );
  const partition = useMemo(
    () => partitionWorkspaces(visibleWorkspaces),
    [visibleWorkspaces],
  );
  const ungroupedCollapsed = collapsedWorkspaceGroups.includes(UNGROUPED_WORKSPACE_FILTER);
  const filterActive = workspaceFilter.query.trim() !== ""
    || workspaceFilter.colors.length > 0
    || workspaceFilter.group != null;

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

  // 树外入口（功能提示 / 命令面板）请求打开 Worktree 管理：按路径回找项目所属工作空间。
  // 消费后立刻清空，避免下次挂载重复弹出。
  const worktreeManagerRequestPath = useDialogStore((s) => s.worktreeManagerRequestPath);
  useEffect(() => {
    if (!worktreeManagerRequestPath) return;
    useDialogStore.getState().clearWorktreeManagerRequest();
    for (const ws of workspaces) {
      const project = ws.projects.find((p) => p.path === worktreeManagerRequestPath);
      if (project) {
        handleOpenWorktreeManager(project, ws);
        return;
      }
    }
  }, [handleOpenWorktreeManager, workspaces, worktreeManagerRequestPath]);

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
      const selected = isTauriRuntime()
        ? await open({ directory: true, multiple: false, title: t("selectWorkspaceRoot") })
        : window.prompt(t("selectWorkspaceRoot"), ws.path ?? "");
      if (selected) {
        await updateWorkspacePath(ws.name, String(selected));
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

  const renderWorkspace = (ws: Workspace) => (
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
        worktreeCache={actions.worktreeCache}
        projectPathStatus={actions.projectPathStatus}
        onOpenTerminal={onOpenTerminal}
        onRemoveProject={actions.handleRemoveProject}
        onCleanupMissingProjects={actions.handleCleanupMissingProjects}
        onSetProjectAlias={actions.handleSetAlias}
        onImportProject={actions.handleImportProject}
        onMigrateProject={actions.handleMigrateProject}
        onOpenWorktreeManager={handleOpenWorktreeManager}
        onOpenInFileBrowser={handleOpenInFileBrowser}
      />
    </SortableWorkspaceItem>
  );

  // 分组成员统一缩进一格 + 左侧竖向引导线，避免与顶层（未分组）工作空间混成一片
  const renderGroupMembers = (members: Workspace[]) => (
    <div className="relative flex flex-col gap-1 pl-3">
      <span
        aria-hidden="true"
        className="absolute left-[15px] top-0.5 bottom-0.5 w-px bg-[var(--app-border)]"
      />
      {members.map(renderWorkspace)}
    </div>
  );

  return (
    <>
      {/* Section: 工作空间（Explorer 分区模式下由外层渲染分区头） */}
      {renderSectionHeader ? (
        renderSectionHeader({
          count: workspaces.length,
          filterActive,
          filterOpen,
          onCreateWorkspace: actions.handleCreateWorkspace,
          onToggleFilter: () => setFilterOpen((open) => !open),
        })
      ) : (
      <div className="flex items-center justify-between px-3 pt-2 pb-1.5 group/section">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--app-text-secondary)] transition-colors">
            {t("workspaces")}
          </span>
          <span
            className="text-[11px] font-medium tabular-nums leading-none px-1.5 py-0.5 rounded text-[var(--app-text-tertiary)] transition-colors"
            style={{ background: "color-mix(in srgb, var(--app-text-primary) 8%, transparent)" }}
          >
            {workspaces.length}
          </span>
        </div>
        <div className="flex items-center gap-0.5">
          <IconTooltipButton
            label={t("workspaceFilterToggle")}
            onClick={() => setFilterOpen((open) => !open)}
            className={`size-5 p-0 ${filterActive ? "text-[var(--app-accent)]" : filterOpen ? "text-[var(--app-text-secondary)]" : "text-[var(--app-text-tertiary)] opacity-0 group-hover/section:opacity-100"}`}
          >
            <ListFilter className="size-3.5" />
          </IconTooltipButton>
          <IconTooltipButton
            label={t("workspaceNewGroup")}
            onClick={() => setCreateGroupOpen(true)}
            className="size-5 p-0 text-[var(--app-text-tertiary)] opacity-0 group-hover/section:opacity-100 hover:text-[var(--app-accent)]"
          >
            <FolderTree className="size-3.5" />
          </IconTooltipButton>
          <IconTooltipButton
            label={t("newWorkspace")}
            onClick={actions.handleCreateWorkspace}
            className="size-5 p-0 text-[var(--app-text-tertiary)] opacity-0 group-hover/section:opacity-100 hover:text-[var(--app-accent)]"
          >
            <Plus className="size-3.5" />
          </IconTooltipButton>
        </div>
      </div>
      )}

      {!collapsed && (
      <>
      {filterOpen ? <WorkspaceFilterBar /> : null}
      <DndContext
        collisionDetection={closestCenter}
        onDragEnd={(event: DragEndEvent) => void handleDragEnd(event)}
        sensors={sensors}
      >
        <SortableContext
          items={visibleWorkspaces.map((workspace) => workspace.id)}
          strategy={verticalListSortingStrategy}
        >
          <div className="flex flex-col gap-1">
            {loading && workspaces.length === 0 ? (
              Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="flex items-center gap-2 px-3 py-2">
                  <Skeleton className="h-4 w-4 rounded" />
                  <Skeleton className="h-4 flex-1" />
                </div>
              ))
            ) : (
              <>
            {partition.defaults.map(renderWorkspace)}
            {partition.groups.map(({ group, workspaces: members }) => {
              const groupCollapsed = collapsedWorkspaceGroups.includes(group);
              return (
                <Fragment key={group}>
                  <WorkspaceGroupHeader
                    group={group}
                    count={members.length}
                    collapsed={groupCollapsed}
                    onToggle={() => toggleWorkspaceGroup(group)}
                  />
                  {!groupCollapsed ? renderGroupMembers(members) : null}
                </Fragment>
              );
            })}
            {/* 存在分组时，未分组项必须有自己的头——否则视觉上会被吸进上一个分组 */}
            {partition.groups.length > 0 && partition.ungrouped.length > 0 ? (
              <>
                <WorkspaceGroupHeader
                  group={t("ungrouped")}
                  count={partition.ungrouped.length}
                  collapsed={ungroupedCollapsed}
                  onToggle={() => toggleWorkspaceGroup(UNGROUPED_WORKSPACE_FILTER)}
                />
                {!ungroupedCollapsed ? renderGroupMembers(partition.ungrouped) : null}
              </>
            ) : (
              partition.ungrouped.map(renderWorkspace)
            )}

            {workspaces.length === 0 && (
              <EmptyState
                icon={FolderGit2}
                title={t("noWorkspaces")}
                action={{ label: t("newWorkspace"), onClick: actions.handleCreateWorkspace }}
                className="py-8"
              />
            )}
            {workspaces.length > 0 && visibleWorkspaces.length === 0 ? (
              <EmptyState
                icon={ListFilter}
                title={t("noWorkspaceMatches")}
                action={{ label: t("clearWorkspaceFilters"), onClick: clearWorkspaceFilter }}
                className="py-8"
              />
            ) : null}
              </>
            )}
          </div>
        </SortableContext>
      </DndContext>

      {/* 新建工作空间按钮 */}
      <button
        className="group w-full mt-3 flex items-center justify-center gap-2 py-2 rounded-lg text-xs font-medium transition-colors duration-[var(--dur-fast)] border border-[var(--app-border)] bg-[var(--app-hover)] text-[var(--app-text-secondary)] hover:border-[color-mix(in_srgb,var(--app-accent)_45%,transparent)] hover:text-[var(--app-accent)] hover:bg-[color-mix(in_srgb,var(--app-accent)_8%,transparent)]"
        onClick={actions.handleCreateWorkspace}
      >
        <Plus className="w-3.5 h-3.5 transition-transform duration-[var(--dur-fast)] group-hover:rotate-90" />
        {t("newWorkspace")}
      </button>
      </>
      )}

      {/* Dialogs */}
      <WorkspaceDialogs {...actions.dialogs} />
      <WorkspaceCreateGroupDialog open={createGroupOpen} setOpen={setCreateGroupOpen} />

      <WorktreeManager
        open={worktreeManagerOpen}
        onOpenChange={(open) => {
          setWorktreeManagerOpen(open);
          // 关闭时让缓存失效，下次展开重新探测——否则侧边栏的 worktree 分组保持陈旧
          if (!open && worktreeManagerProjectPath) {
            actions.invalidateWorktrees(worktreeManagerProjectPath);
          }
        }}
        projectPath={worktreeManagerProjectPath}
        onWorktreeRemoved={actions.handleWorktreeRemoved}
        onWorktreesChanged={() => {
          if (worktreeManagerProjectPath) {
            actions.invalidateWorktrees(worktreeManagerProjectPath);
          }
        }}
        onOpenWorktree={(path) => onOpenTerminal({ path, workspaceName: worktreeManagerWs?.name, workspacePath: worktreeManagerWs?.path })}
      />
    </>
  );
}
