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
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { toast } from "sonner";
import { Plus, FolderGit2, FolderTree, ListFilter, TerminalSquare, CalendarClock } from "lucide-react";
import { IconTooltipButton } from "@/components/ui/IconTooltipButton";
import { navigateToSettings } from "@/components/settings/settingsNavigation";
import WorkspaceCreateGroupDialog from "./WorkspaceCreateGroupDialog";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/EmptyState";
import { usePanesStore, useWorkspacesStore } from "@/stores";
import { useActivityBarStore } from "@/stores/useActivityBarStore";
import { useDialogStore } from "@/stores/useDialogStore";
import { useLayoutUiStore } from "@/stores/useLayoutUiStore";
import { useExplorerSectionsStore } from "@/stores/useExplorerSectionsStore";
import { useTerminalStatusStore } from "@/stores/useTerminalStatusStore";
import { deriveWorkspaceTerminals } from "./workspaceTerminals";
import WorkspaceTerminalList from "./WorkspaceTerminalList";
import { useFirstPromptIndex } from "@/hooks/useFirstPromptIndex";
import { useCliTools } from "@/hooks/useCliTools";
import { filterWorkspaces, UNGROUPED_WORKSPACE_FILTER } from "@/stores/useWorkspacesStore";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { partitionWorkspaces } from "./workspaceDnd";
import { useWorkspaceDragDrop } from "./useWorkspaceDragDrop";
import { isTauriRuntime } from "@/services/runtime";
import WorktreeManager from "@/components/WorktreeManager";
import { useWorkspaceActions } from "./useWorkspaceActions";
import WorkspaceDialogs from "./WorkspaceDialogs";
import WorkspaceItem from "./WorkspaceItem";
import WorkspaceFilterBar from "./WorkspaceFilterBar";
import WorkspaceGroupDropZone from "./WorkspaceGroupDropZone";
import ProjectListView from "./ProjectListView";
import {
  sidebarSectionCountClass,
  sidebarSectionHeaderClass,
  sidebarSectionTitleClass,
} from "./sidebarStyles";
import type { Workspace, WorkspaceProject, OpenTerminalOptions } from "@/types";
import { getAvailableSidebarCliToolIds } from "./launchMenu";

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
  /** 头部计数徽章覆盖值（终端模式显示终端数而非项目数） */
  countOverride?: number;
  /** 已安装或显式配置的 CLI；undefined 表示环境探测尚未完成。 */
  availableCliToolIds?: ReadonlySet<string>;
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
  const { tools: cliTools, loading: cliToolsLoading } = useCliTools();
  const cliLauncherOverrides = useSettingsStore((s) => s.settings?.cliLaunchers.overrides);
  const availableCliToolIds = useMemo(
    () => getAvailableSidebarCliToolIds(
      cliToolsLoading ? undefined : cliTools,
      cliLauncherOverrides,
    ),
    [cliLauncherOverrides, cliTools, cliToolsLoading],
  );
  const collapsedWorkspaceGroups = useLayoutUiStore((s) => s.collapsedWorkspaceGroups);
  const toggleWorkspaceGroup = useLayoutUiStore((s) => s.toggleWorkspaceGroup);
  const openWorkspaceEnvironment = useDialogStore((s) => s.openWorkspaceEnvironment);
  const [filterOpen, setFilterOpen] = useState(false);
  const [createGroupOpen, setCreateGroupOpen] = useState(false);
  const treeMode = useExplorerSectionsStore((s) => s.workspaceTreeMode);
  const setTreeMode = useExplorerSectionsStore((s) => s.setWorkspaceTreeMode);
  // 终端模式的数据派生：只在该模式下订阅 panes/status，项目模式零开销
  const layouts = usePanesStore((s) => (treeMode === "terminals" ? s.layouts : null));
  const rootPane = usePanesStore((s) => (treeMode === "terminals" ? s.rootPane : null));
  const currentLayoutId = usePanesStore((s) => s.currentLayoutId);
  const statusMap = useTerminalStatusStore((s) => s.statusMap);
  const firstPrompts = useFirstPromptIndex(treeMode === "terminals");
  const workspaceTerminals = useMemo(() => {
    if (treeMode !== "terminals" || !layouts || !rootPane) return null;
    return deriveWorkspaceTerminals(
      { layouts, rootPane, currentLayoutId },
      workspaces,
      statusMap,
      firstPrompts,
    );
  }, [treeMode, layouts, rootPane, currentLayoutId, workspaces, statusMap, firstPrompts]);
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

  const { draggingId, handleDragStart, handleDragEnd, handleDragCancel } = useWorkspaceDragDrop();
  const dragging = draggingId !== null;

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

  const renderWorkspace = (ws: Workspace) => {
    const terminalRows = workspaceTerminals?.get(ws.id) ?? [];
    return (
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
        countOverride={treeMode === "terminals" ? terminalRows.length : undefined}
        availableCliToolIds={availableCliToolIds}
      >
        {treeMode === "terminals" ? (
          <WorkspaceTerminalList workspaceName={ws.name} rows={terminalRows} />
        ) : (
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
            availableCliToolIds={availableCliToolIds}
          />
        )}
      </SortableWorkspaceItem>
    );
  };

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
      <div className={sidebarSectionHeaderClass}>
        <div className="flex items-center gap-2">
          <span className={sidebarSectionTitleClass}>
            {t("workspaces")}
          </span>
          <span
            className={sidebarSectionCountClass}
            style={{ background: "color-mix(in srgb, var(--app-text-primary) 8%, transparent)" }}
          >
            {workspaces.length}
          </span>
        </div>
        <div className="flex items-center gap-0.5">
          {/* 树模式切换：项目列表 / 运行中的终端（常驻，不做 hover 才显示） */}
          <IconTooltipButton
            label={t("treeModeProjects")}
            aria-pressed={treeMode === "projects"}
            onClick={() => setTreeMode("projects")}
            className="size-5 p-0"
            style={
              treeMode === "projects"
                ? { color: "var(--app-accent)", background: "color-mix(in srgb, var(--app-accent) 12%, transparent)" }
                : { color: "var(--app-text-tertiary)" }
            }
          >
            <FolderGit2 className="size-3.5" />
          </IconTooltipButton>
          <IconTooltipButton
            label={t("treeModeTerminals")}
            aria-pressed={treeMode === "terminals"}
            onClick={() => setTreeMode("terminals")}
            className="size-5 p-0"
            style={
              treeMode === "terminals"
                ? { color: "var(--app-accent)", background: "color-mix(in srgb, var(--app-accent) 12%, transparent)" }
                : { color: "var(--app-text-tertiary)" }
            }
          >
            <TerminalSquare className="size-3.5" />
          </IconTooltipButton>
          <IconTooltipButton label={t("agentChatsAutomations")} onClick={() => navigateToSettings({ paneId: "automations" })} className="size-5 p-0 text-[var(--app-text-tertiary)] hover:text-[var(--app-accent)]">
            <CalendarClock className="size-3.5" />
          </IconTooltipButton>
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
        onDragStart={handleDragStart}
        onDragEnd={(event: DragEndEvent) => void handleDragEnd(event)}
        onDragCancel={handleDragCancel}
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
                  <WorkspaceGroupDropZone
                    group={group}
                    groupKey={group}
                    count={members.length}
                    collapsed={groupCollapsed}
                    onToggle={() => toggleWorkspaceGroup(group)}
                    dragging={dragging}
                  />
                  {!groupCollapsed ? renderGroupMembers(members) : null}
                </Fragment>
              );
            })}
            {/* 存在分组时，未分组项必须有自己的头——否则视觉上会被吸进上一个分组。
                拖拽中即使未分组段为空也要渲染头，否则「把某组最后一个成员拖回
                未分组」没有落点。 */}
            {partition.groups.length > 0 && (partition.ungrouped.length > 0 || dragging) ? (
              <>
                <WorkspaceGroupDropZone
                  group={t("ungrouped")}
                  groupKey={UNGROUPED_WORKSPACE_FILTER}
                  count={partition.ungrouped.length}
                  collapsed={ungroupedCollapsed}
                  onToggle={() => toggleWorkspaceGroup(UNGROUPED_WORKSPACE_FILTER)}
                  dragging={dragging}
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
