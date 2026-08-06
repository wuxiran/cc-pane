import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ChevronRight,
  Columns3,
  FolderGit2,
  FolderOpen,
  MoreHorizontal,
  Pencil,
  Pin,
  Send,
  Star,
  Terminal,
  Trash2,
} from "lucide-react";
import TerminalTabContent from "@/components/panes/TerminalTabContent";
import type { TerminalViewHandle } from "@/components/panes/TerminalView";
import { collectTerminalLeaves } from "@/lib/paneSessions";
import { collectPanels } from "@/stores/paneTreeHelpers";
import { useTabViewStateStore } from "@/stores/useTabViewStateStore";
import type { LayoutEntry, PaneNode, Panel, Tab, Workspace, WorkspaceProject } from "@/types";
import { getProjectName } from "@/utils/path";

type ViewId = "workspaces" | "layouts" | "terminal";

interface OpenedWorkspaceProject {
  workspaceName: string;
  workspaceRootPath?: string;
  projectName: string;
  projectPath: string;
}

const viewTitle: Record<ViewId, string> = {
  workspaces: "工作空间",
  layouts: "布局",
  terminal: "终端",
};

interface MobilePrototypeProps {
  workspaces?: Workspace[];
  workspacesLoading?: boolean;
  terminal?: MobileTerminalState | null;
  layouts?: LayoutEntry[];
  currentLayoutId?: string;
  rootPane?: PaneNode;
  activePaneId?: string;
  onLoadWorkspaces?: () => void | Promise<void>;
  onOpenProject?: (workspace: Workspace, project: WorkspaceProject) => void;
  onSwitchLayout?: (layoutId: string) => void;
  onSelectPane?: (paneId: string) => void;
  onSelectTab?: (paneId: string, tabId: string) => void;
  onToggleWorkspacePinned?: (workspace: Workspace) => Promise<void>;
  onToggleWorkspaceHidden?: (workspace: Workspace) => Promise<void>;
  onOpenWorkspaceFolder?: (workspace: Workspace) => Promise<void>;
  onOpenWorkspaceFileBrowser?: (workspace: Workspace) => void;
  onSetWorkspaceAlias?: (workspace: Workspace, alias: string | null) => Promise<void>;
  onRenameWorkspace?: (workspace: Workspace, name: string) => Promise<void>;
  onDeleteWorkspace?: (workspace: Workspace) => Promise<void>;
}

interface MobileTerminalState {
  paneId: string;
  tab: Tab;
  onSessionCreated: (sessionId: string, terminalPaneId?: string) => void;
  onSessionExited?: (exitCode: number, terminalPaneId?: string) => void;
  onTerminalRef: (terminalPaneId: string, ref: TerminalViewHandle | null) => void;
  onReconnect?: (terminalPaneId: string) => Promise<string | null>;
  onWrite: (sessionId: string, data: string) => Promise<void>;
  onSubmit: (sessionId: string, text: string) => Promise<void>;
}

function getWorkspaceOpenPath(workspace: Workspace): string | undefined {
  return workspace.path || workspace.projects.find((project) => !project.ssh)?.path || workspace.projects[0]?.path;
}

function toOpenedProject(workspace: Workspace, project: WorkspaceProject): OpenedWorkspaceProject {
  return {
    workspaceName: workspace.name,
    workspaceRootPath: getWorkspaceOpenPath(workspace),
    projectName: project.alias ?? getProjectName(project.path),
    projectPath: project.path,
  };
}

function getFirstWorkspaceProject(workspaces: Workspace[]): { workspace: Workspace; project: WorkspaceProject } | null {
  for (const workspace of workspaces) {
    const project = workspace.projects[0];
    if (project) return { workspace, project };
  }
  return null;
}

function getActiveTerminalSessionId(tab: Tab | null | undefined): string | null {
  if (!tab) return null;
  if (tab.contentType !== "terminal" || !tab.terminalRootPane) return tab.sessionId ?? null;
  const leaves = collectTerminalLeaves(tab.terminalRootPane);
  const activeLeaf = (
    tab.activeTerminalPaneId
      ? leaves.find((leaf) => leaf.id === tab.activeTerminalPaneId)
      : null
  ) ?? leaves[0];
  return activeLeaf?.sessionId ?? tab.sessionId ?? null;
}

function getPanels(node?: PaneNode | null): Panel[] {
  return node ? collectPanels(node) : [];
}

function tabKindLabel(tab: Tab): string {
  switch (tab.contentType) {
    case "terminal":
      return tab.cliTool && tab.cliTool !== "none" ? tab.cliTool : "terminal";
    case "file-explorer":
      return "files";
    case "editor":
      return "editor";
    case "mcp-config":
      return "mcp";
    case "skill-manager":
      return "skills";
    case "memory-manager":
      return "memory";
    default:
      return tab.contentType;
  }
}

function MobilePrototype({
  workspaces: connectedWorkspaces,
  workspacesLoading = false,
  terminal,
  layouts = [],
  currentLayoutId,
  rootPane,
  activePaneId,
  onLoadWorkspaces,
  onOpenProject,
  onSwitchLayout,
  onSelectPane,
  onSelectTab,
  onToggleWorkspacePinned,
  onToggleWorkspaceHidden,
  onOpenWorkspaceFolder,
  onOpenWorkspaceFileBrowser,
  onSetWorkspaceAlias,
  onRenameWorkspace,
  onDeleteWorkspace,
}: MobilePrototypeProps) {
  const [view, setView] = useState<ViewId>("workspaces");
  const [actionWorkspaceId, setActionWorkspaceId] = useState<string | null>(null);
  const connected = connectedWorkspaces !== undefined;
  const workspaces = connectedWorkspaces ?? [];
  const [openedProject, setOpenedProject] = useState<OpenedWorkspaceProject | null>(() => {
    const first = getFirstWorkspaceProject(workspaces);
    return first ? toOpenedProject(first.workspace, first.project) : null;
  });

  useEffect(() => {
    void onLoadWorkspaces?.();
  }, [onLoadWorkspaces]);

  useEffect(() => {
    const first = getFirstWorkspaceProject(workspaces);
    setOpenedProject((current) => {
      if (!first) return null;
      if (workspaces.some((workspace) =>
        workspace.projects.some((project) => project.path === current?.projectPath)
      )) {
        return current;
      }
      return toOpenedProject(first.workspace, first.project);
    });
  }, [workspaces]);

  const actionWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === actionWorkspaceId) ?? null,
    [actionWorkspaceId],
  );
  const terminalMode = view === "terminal";
  const workspaceCount = workspaces.length;
  const projectCount = workspaces.reduce((total, workspace) => total + workspace.projects.length, 0);
  const currentLayout = useMemo(
    () => layouts.find((layout) => layout.id === currentLayoutId) ?? layouts.find((layout) => layout.kind !== "starred") ?? layouts[0] ?? null,
    [currentLayoutId, layouts],
  );
  const visibleLayouts = useMemo(
    () => layouts.filter((layout) => layout.kind !== "starred"),
    [layouts],
  );
  const panels = useMemo(
    () => getPanels(rootPane ?? currentLayout?.rootPane).filter((panel) => panel.tabs.length > 0),
    [currentLayout?.rootPane, rootPane],
  );
  const activePanel = panels.find((panel) => panel.id === activePaneId) ?? panels[0] ?? null;
  const activeTabCount = activePanel?.tabs.length ?? 0;

  const openWorkspaceProject = (workspace: Workspace, project: WorkspaceProject) => {
    setOpenedProject(toOpenedProject(workspace, project));
    onOpenProject?.(workspace, project);
    setView("terminal");
  };

  return (
    <div className="min-h-screen bg-[#eef2f7] text-slate-950 dark:bg-[#0b111a] dark:text-slate-100">
      <div className="mx-auto flex min-h-screen w-full max-w-[430px] flex-col bg-[#f8fafc] shadow-2xl shadow-slate-950/10 dark:bg-[#0f172a] sm:my-6 sm:min-h-[860px] sm:rounded-[28px] sm:border sm:border-slate-200 dark:sm:border-slate-800">
        {!terminalMode && (
          <header className="flex-none border-b border-slate-200 bg-white px-4 pb-3 pt-[max(14px,env(safe-area-inset-top))] dark:border-slate-800 dark:bg-slate-950">
            <div className="flex h-11 items-center justify-between">
              <div className="min-w-0">
                <div className="truncate text-[13px] font-medium text-slate-500 dark:text-slate-400">CC-Panes Mobile</div>
                <h1 className="truncate text-[20px] font-semibold leading-6 tracking-normal">{viewTitle[view]}</h1>
              </div>
            </div>

            <div className="mt-3 grid grid-cols-4 gap-2">
              <Metric label="工作空间" value={workspaceCount} tone="text-indigo-600 dark:text-indigo-300" />
              <Metric label="项目" value={projectCount} tone="text-sky-600 dark:text-sky-300" />
              <Metric label="布局" value={visibleLayouts.length} tone="text-blue-600 dark:text-blue-300" />
              <Metric label="Pane" value={panels.length} tone="text-amber-600 dark:text-amber-300" />
            </div>

            <div className="mt-3 grid grid-cols-3 rounded-md bg-slate-100 p-1 text-[13px] font-medium dark:bg-slate-900">
              <SegmentButton active={view === "workspaces"} onClick={() => setView("workspaces")}>工作空间</SegmentButton>
              <SegmentButton active={view === "layouts"} onClick={() => setView("layouts")}>布局</SegmentButton>
              <SegmentButton active={false} onClick={() => setView("terminal")}>当前终端</SegmentButton>
            </div>
          </header>
        )}

        <main className={terminalMode
          ? "flex min-h-0 flex-1 overflow-hidden px-1 pb-1 pt-[max(2px,env(safe-area-inset-top))]"
          : "min-h-0 flex-1 overflow-y-auto px-4 py-4"}
        >
          {view === "workspaces" && (
            <WorkspaceBoard
              openedProject={openedProject}
              loading={workspacesLoading}
              connected={connected}
              workspaces={workspaces}
              onOpenActions={(workspace) => setActionWorkspaceId(workspace.id)}
              onOpenProject={openWorkspaceProject}
            />
          )}
          {view === "layouts" && (
            <LayoutBoard
              layouts={visibleLayouts}
              currentLayoutId={currentLayoutId}
              panels={panels}
              activePaneId={activePaneId}
              activeTabCount={activeTabCount}
              onSwitchLayout={(layoutId) => {
                onSwitchLayout?.(layoutId);
                setView("terminal");
              }}
              onSelectPane={(paneId) => {
                onSelectPane?.(paneId);
                setView("terminal");
              }}
              onSelectTab={(paneId, tabId) => {
                onSelectTab?.(paneId, tabId);
                setView("terminal");
              }}
            />
          )}
          {view === "terminal" && (
            <TerminalBoard
              terminal={terminal ?? null}
              openedProject={openedProject}
              layouts={visibleLayouts}
              currentLayoutId={currentLayoutId}
              panels={panels}
              activePaneId={activePaneId}
              onSwitchLayout={onSwitchLayout}
              onSelectPane={onSelectPane}
              onSelectTab={onSelectTab}
            />
          )}
        </main>

        <BottomNav view={view} setView={setView} />

        {actionWorkspace && (
          <WorkspaceActionSheet
            workspace={actionWorkspace}
            onClose={() => setActionWorkspaceId(null)}
            onOpenWorkspace={() => {
              const firstProject = actionWorkspace.projects[0];
              if (firstProject) {
                openWorkspaceProject(actionWorkspace, firstProject);
                setActionWorkspaceId(null);
              }
            }}
            onTogglePinned={onToggleWorkspacePinned}
            onToggleHidden={onToggleWorkspaceHidden}
            onOpenFolder={onOpenWorkspaceFolder}
            onOpenFileBrowser={onOpenWorkspaceFileBrowser}
            onSetAlias={onSetWorkspaceAlias}
            onRename={onRenameWorkspace}
            onDelete={onDeleteWorkspace}
          />
        )}
      </div>
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="min-w-0 rounded-md border border-slate-200 bg-slate-50 px-2 py-2 text-center dark:border-slate-800 dark:bg-slate-900">
      <div className={`text-[18px] font-semibold leading-5 ${tone}`}>{value}</div>
      <div className="mt-1 truncate text-[11px] text-slate-500 dark:text-slate-400">{label}</div>
    </div>
  );
}

function SegmentButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`h-9 rounded-[5px] px-2 transition ${
        active
          ? "bg-white text-slate-950 shadow-sm dark:bg-slate-800 dark:text-white"
          : "text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100"
      }`}
    >
      {children}
    </button>
  );
}

function WorkspaceBoard({
  openedProject,
  loading,
  connected,
  workspaces,
  onOpenActions,
  onOpenProject,
}: {
  openedProject: OpenedWorkspaceProject | null;
  loading: boolean;
  connected: boolean;
  workspaces: Workspace[];
  onOpenActions: (workspace: Workspace) => void;
  onOpenProject: (workspace: Workspace, project: WorkspaceProject) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-[15px] font-semibold">工作空间</h2>
        <span className="text-[12px] text-slate-500 dark:text-slate-400">
          {loading ? "正在读取" : connected ? "后端工作空间" : "未连接后端"}
        </span>
      </div>

      {workspaces.map((workspace) => {
        const visibleProjects = workspace.projects;
        return (
          <section key={workspace.id} className="rounded-md border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-950">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2">
                  <div className="grid h-9 w-9 flex-none place-items-center rounded-md border border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200">
                    <FolderOpen className="h-4 w-4" />
                  </div>
                  <div className="min-w-0">
                    <h3 className="truncate text-[14px] font-semibold">{workspace.alias ?? workspace.name}</h3>
                    <p className="mt-0.5 truncate text-[12px] text-slate-500 dark:text-slate-400">{workspace.path ?? workspace.name}</p>
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {workspace.pinned && <Pill icon={<Pin className="h-3 w-3" />} label="已置顶" />}
                  {workspace.hidden && <Pill icon={<FolderGit2 className="h-3 w-3" />} label="已隐藏" />}
                  <Pill icon={<FolderGit2 className="h-3 w-3" />} label={`${visibleProjects.length} 个项目`} />
                </div>
              </div>
              <div className="flex flex-none items-center gap-1">
                <button
                  type="button"
                  onClick={() => onOpenActions(workspace)}
                  className="grid h-9 w-9 place-items-center rounded-md border border-slate-200 text-slate-600 dark:border-slate-800 dark:text-slate-300"
                  aria-label="工作空间操作菜单"
                >
                  <MoreHorizontal className="h-4 w-4" />
                </button>
              </div>
            </div>

            <div className="mt-3 space-y-2">
              {visibleProjects.map((project) => {
                const projectName = project.alias ?? getProjectName(project.path);
                const selected = openedProject?.projectPath === project.path;
                return (
                  <button
                    key={project.id}
                    type="button"
                    onClick={() => onOpenProject(workspace, project)}
                    className={`w-full rounded-md border p-2 text-left transition active:scale-[0.99] ${
                      selected
                        ? "border-blue-300 bg-blue-50/70 dark:border-blue-800 dark:bg-blue-950/30"
                        : "border-slate-200 bg-slate-50 hover:border-slate-300 dark:border-slate-800 dark:bg-slate-900 dark:hover:border-slate-700"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <Terminal className="h-4 w-4 flex-none text-slate-500 dark:text-slate-400" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px] font-semibold text-slate-900 dark:text-slate-100">{projectName}</div>
                        <div className="mt-0.5 truncate text-[11px] text-slate-500 dark:text-slate-400">{project.path}</div>
                      </div>
                      <ChevronRight className="h-4 w-4 flex-none text-slate-400" />
                    </div>
                    <div className="mt-2 flex items-center justify-between gap-2 border-t border-slate-200 pt-2 text-[11px] text-slate-500 dark:border-slate-800 dark:text-slate-400">
                      <span className="truncate">点按打开项目终端</span>
                      {project.launchProfileId && <span className="flex-none">有运行配置</span>}
                    </div>
                  </button>
                );
              })}
            </div>
          </section>
        );
      })}

      {workspaces.length === 0 && (
        <div className="rounded-md border border-dashed border-slate-300 bg-white px-4 py-10 text-center text-[13px] text-slate-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-400">
          当前后端没有返回工作空间
        </div>
      )}
    </div>
  );
}

function LayoutBoard({
  layouts,
  currentLayoutId,
  panels,
  activePaneId,
  activeTabCount,
  onSwitchLayout,
  onSelectPane,
  onSelectTab,
}: {
  layouts: LayoutEntry[];
  currentLayoutId?: string;
  panels: Panel[];
  activePaneId?: string;
  activeTabCount: number;
  onSwitchLayout: (layoutId: string) => void;
  onSelectPane: (paneId: string) => void;
  onSelectTab: (paneId: string, tabId: string) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-[15px] font-semibold">布局</h2>
        <span className="text-[12px] text-slate-500 dark:text-slate-400">
          {panels.length} Pane / {activeTabCount} Tab
        </span>
      </div>

      <section className="rounded-md border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-950">
        <div className="mb-2 text-[12px] font-semibold text-slate-500 dark:text-slate-400">当前布局</div>
        <div className="grid grid-cols-2 gap-2">
          {layouts.map((layout) => {
            const active = layout.id === currentLayoutId;
            const panelCount = getPanels(layout.rootPane).length;
            return (
              <button
                key={layout.id}
                type="button"
                onClick={() => onSwitchLayout(layout.id)}
                className={`min-w-0 rounded-md border px-3 py-2 text-left transition active:scale-[0.99] ${
                  active
                    ? "border-blue-300 bg-blue-50 text-blue-900 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-100"
                    : "border-slate-200 bg-slate-50 text-slate-800 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200"
                }`}
              >
                <div className="flex min-w-0 items-center gap-2">
                  <Columns3 className="h-4 w-4 flex-none" />
                  <span className="truncate text-[13px] font-semibold">{layout.name}</span>
                </div>
                <div className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">{panelCount} Pane</div>
              </button>
            );
          })}
        </div>
        {layouts.length === 0 && (
          <div className="rounded-md border border-dashed border-slate-300 px-3 py-6 text-center text-[12px] text-slate-500 dark:border-slate-700 dark:text-slate-400">
            暂无可同步布局
          </div>
        )}
      </section>

      <section className="rounded-md border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-950">
        <div className="mb-2 text-[12px] font-semibold text-slate-500 dark:text-slate-400">Pane / Tab</div>
        <div className="space-y-2">
          {panels.map((panel, panelIndex) => {
            const activePane = panel.id === activePaneId;
            return (
              <div
                key={panel.id}
                className={`rounded-md border p-2 ${
                  activePane
                    ? "border-blue-300 bg-blue-50/70 dark:border-blue-800 dark:bg-blue-950/30"
                    : "border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900"
                }`}
              >
                <button
                  type="button"
                  onClick={() => onSelectPane(panel.id)}
                  className="flex w-full items-center justify-between gap-2 text-left"
                >
                  <span className="min-w-0 truncate text-[13px] font-semibold">Pane {panelIndex + 1}</span>
                  <span className="flex-none text-[11px] text-slate-500 dark:text-slate-400">{panel.tabs.length} Tab</span>
                </button>
                <div className="mt-2 flex gap-1.5 overflow-x-auto pb-1">
                  {panel.tabs.map((tab) => {
                    const activeTab = tab.id === panel.activeTabId;
                    return (
                      <button
                        key={tab.id}
                        type="button"
                        onClick={() => onSelectTab(panel.id, tab.id)}
                        className={`max-w-[150px] flex-none rounded-md border px-2 py-1.5 text-left ${
                          activeTab
                            ? "border-blue-300 bg-white text-blue-900 dark:border-blue-700 dark:bg-slate-950 dark:text-blue-100"
                            : "border-slate-200 bg-white text-slate-700 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-300"
                        }`}
                      >
                        <div className="truncate text-[12px] font-semibold">{tab.title}</div>
                        <div className="mt-0.5 truncate text-[10px] uppercase text-slate-400">{tabKindLabel(tab)}</div>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
        {panels.length === 0 && (
          <div className="rounded-md border border-dashed border-slate-300 px-3 py-6 text-center text-[12px] text-slate-500 dark:border-slate-700 dark:text-slate-400">
            当前布局没有可选择的 Pane
          </div>
        )}
      </section>
    </div>
  );
}

function WorkspaceActionSheet({
  workspace,
  onClose,
  onOpenWorkspace,
  onTogglePinned,
  onToggleHidden,
  onOpenFolder,
  onOpenFileBrowser,
  onSetAlias,
  onRename,
  onDelete,
}: {
  workspace: Workspace;
  onClose: () => void;
  onOpenWorkspace: () => void;
  onTogglePinned?: (workspace: Workspace) => Promise<void>;
  onToggleHidden?: (workspace: Workspace) => Promise<void>;
  onOpenFolder?: (workspace: Workspace) => Promise<void>;
  onOpenFileBrowser?: (workspace: Workspace) => void;
  onSetAlias?: (workspace: Workspace, alias: string | null) => Promise<void>;
  onRename?: (workspace: Workspace, name: string) => Promise<void>;
  onDelete?: (workspace: Workspace) => Promise<void>;
}) {
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const workspacePath = getWorkspaceOpenPath(workspace);
  const hasProject = workspace.projects.length > 0;

  const runAction = async (actionId: string, action: () => void | Promise<void>, closeAfter = false) => {
    setBusyAction(actionId);
    setError(null);
    try {
      await action();
      if (closeAfter) onClose();
    } catch (caught) {
      console.error(`Mobile workspace action failed: ${actionId}`, caught);
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusyAction(null);
    }
  };

  const promptForValue = (
    title: string,
    currentValue: string,
    onSubmit: (value: string | null) => Promise<void>,
  ) => {
    const next = window.prompt(title, currentValue);
    if (next === null) return;
    void runAction(title, () => onSubmit(next.trim() || null), true);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center">
      <button
        type="button"
        aria-label="关闭工作空间操作"
        className="absolute inset-0 bg-slate-950/45"
        onClick={onClose}
      />
      <section
        role="dialog"
        aria-modal="true"
        aria-label="工作空间操作"
        className="relative z-10 max-h-[82dvh] w-full max-w-[430px] overflow-y-auto rounded-t-2xl border border-slate-200 bg-white p-4 shadow-2xl dark:border-slate-800 dark:bg-slate-950"
      >
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-slate-300 dark:bg-slate-700" />
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[12px] font-medium text-slate-500 dark:text-slate-400">工作空间操作</div>
            <h2 className="mt-1 truncate text-[18px] font-semibold">{workspace.alias ?? workspace.name}</h2>
            <p className="mt-1 truncate text-[12px] text-slate-500 dark:text-slate-400">{workspace.path ?? workspace.name}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="grid h-9 w-9 flex-none place-items-center rounded-md border border-slate-200 text-slate-600 dark:border-slate-800 dark:text-slate-300"
            aria-label="关闭"
          >
            <ChevronRight className="h-4 w-4 rotate-90" />
          </button>
        </div>

        <ActionGroup title="常用">
          <ActionRow
            icon={<Star className="h-4 w-4" />}
            label={workspace.pinned ? "取消置顶" : "显示在常用"}
            detail={workspace.pinned ? "从常用工作空间中移除" : "把工作空间加入常用列表"}
            busy={busyAction === "toggle-pinned"}
            onClick={onTogglePinned ? () => void runAction("toggle-pinned", () => onTogglePinned(workspace), true) : undefined}
          />
          <ActionRow
            icon={<Terminal className="h-4 w-4" />}
            label="打开终端"
            detail={hasProject ? "打开第一个可用项目" : "当前工作空间没有项目"}
            disabled={!hasProject}
            onClick={hasProject ? () => {
              onOpenWorkspace();
              onClose();
            } : undefined}
          />
        </ActionGroup>

        <ActionGroup title="工作空间">
          <ActionRow
            icon={<FolderOpen className="h-4 w-4" />}
            label="打开文件夹"
            detail={workspacePath ? "在系统文件管理器中打开路径" : "当前工作空间没有可打开路径"}
            disabled={!workspacePath}
            busy={busyAction === "open-folder"}
            onClick={workspacePath && onOpenFolder ? () => void runAction("open-folder", () => onOpenFolder(workspace), true) : undefined}
          />
          <ActionRow
            icon={<FolderOpen className="h-4 w-4" />}
            label="在文件浏览器中打开"
            detail={workspacePath ? "切到应用内文件浏览器查看路径" : "当前工作空间没有可打开路径"}
            disabled={!workspacePath}
            onClick={workspacePath && onOpenFileBrowser ? () => {
              onOpenFileBrowser(workspace);
              onClose();
            } : undefined}
          />
        </ActionGroup>

        <ActionGroup title="设置">
          <ActionRow
            icon={<Pin className="h-4 w-4" />}
            label={workspace.hidden ? "显示工作空间" : "隐藏工作空间"}
            detail={workspace.hidden ? "恢复到工作空间列表" : "从常规列表隐藏"}
            busy={busyAction === "toggle-hidden"}
            onClick={onToggleHidden ? () => void runAction("toggle-hidden", () => onToggleHidden(workspace), true) : undefined}
          />
          <ActionRow
            icon={<Pencil className="h-4 w-4" />}
            label="设置别名"
            detail="修改侧栏显示名称"
            busy={busyAction === "设置别名"}
            onClick={onSetAlias ? () => promptForValue("设置别名", workspace.alias ?? "", (alias) => onSetAlias(workspace, alias)) : undefined}
          />
          <ActionRow
            icon={<Pencil className="h-4 w-4" />}
            label="重命名"
            detail="修改工作空间名称"
            busy={busyAction === "重命名"}
            onClick={onRename ? () => promptForValue("重命名", workspace.name, async (name) => {
              if (!name) return;
              await onRename(workspace, name);
            }) : undefined}
          />
        </ActionGroup>

        <ActionGroup title="删除">
          <ActionRow
            icon={<Trash2 className="h-4 w-4" />}
            label="删除工作空间"
            detail="从工作空间列表中移除"
            destructive
            busy={busyAction === "delete-workspace"}
            onClick={onDelete ? () => {
              if (!window.confirm(`删除工作空间 ${workspace.alias ?? workspace.name}？`)) return;
              void runAction("delete-workspace", () => onDelete(workspace), true);
            } : undefined}
          />
        </ActionGroup>

        {error && (
          <div className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-200">
            {error}
          </div>
        )}
      </section>
    </div>
  );
}

function ActionGroup({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="mt-4">
      <div className="mb-2">
        <h3 className="text-[13px] font-semibold text-slate-900 dark:text-slate-100">{title}</h3>
      </div>
      <div className="overflow-hidden rounded-md border border-slate-200 dark:border-slate-800">
        {children}
      </div>
    </div>
  );
}

function ActionRow({
  icon,
  label,
  detail,
  destructive,
  disabled,
  busy,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  detail: string;
  destructive?: boolean;
  disabled?: boolean;
  busy?: boolean;
  onClick?: () => void;
}) {
  const content = (
    <>
      <span className={`grid h-8 w-8 flex-none place-items-center rounded-md ${destructive ? "bg-red-50 text-red-600 dark:bg-red-950/30 dark:text-red-300" : "bg-slate-100 text-slate-600 dark:bg-slate-900 dark:text-slate-300"}`}>
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className={`block truncate text-[13px] font-semibold ${disabled ? "text-slate-400 dark:text-slate-600" : destructive ? "text-red-600 dark:text-red-300" : "text-slate-900 dark:text-slate-100"}`}>{busy ? "处理中..." : label}</span>
        <span className="mt-0.5 block truncate text-[11px] text-slate-500 dark:text-slate-400">{detail}</span>
      </span>
      <ChevronRight className="h-4 w-4 flex-none text-slate-400" />
    </>
  );

  if (onClick) {
    return (
      <button type="button" onClick={onClick} disabled={disabled || busy} className="flex w-full items-center gap-2 border-b border-slate-200 px-3 py-2.5 text-left last:border-b-0 active:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-70 dark:border-slate-800 dark:active:bg-slate-900">
        {content}
      </button>
    );
  }

  return (
    <div className={`flex items-center gap-2 border-b border-slate-200 px-3 py-2.5 last:border-b-0 dark:border-slate-800 ${disabled ? "opacity-70" : ""}`}>
      {content}
    </div>
  );
}

function TerminalBoard({
  terminal,
  openedProject,
  layouts,
  currentLayoutId,
  panels,
  activePaneId,
  onSwitchLayout,
  onSelectPane,
  onSelectTab,
}: {
  terminal: MobileTerminalState | null;
  openedProject: OpenedWorkspaceProject | null;
  layouts: LayoutEntry[];
  currentLayoutId?: string;
  panels: Panel[];
  activePaneId?: string;
  onSwitchLayout?: (layoutId: string) => void;
  onSelectPane?: (paneId: string) => void;
  onSelectTab?: (paneId: string, tabId: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [sendError, setSendError] = useState<string | null>(null);
  const composingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const activeSessionId = getActiveTerminalSessionId(terminal?.tab);
  const canSend = Boolean(terminal && activeSessionId);

  // 可见性写侧：移动原型是单终端全屏视图，展示中的 tab 恒 primary/active。
  // 没有这条写侧的话，可见性单源里查不到条目，终端会被当成后台标签降档。
  const mobileTerminalTabId =
    terminal?.tab.contentType === "terminal" && terminal.tab.projectPath ? terminal.tab.id : null;
  useEffect(() => {
    if (!mobileTerminalTabId) return;
    useTabViewStateStore.getState().reportView(mobileTerminalTabId, "primary", "active");
    return () => {
      useTabViewStateStore.getState().removeView(mobileTerminalTabId, "primary");
    };
  }, [mobileTerminalTabId]);

  const writeShortcut = async (text: string) => {
    if (!terminal || !activeSessionId) return;
    setSendError(null);
    try {
      await terminal.onWrite(activeSessionId, text);
    } catch (error) {
      console.error("Failed to write mobile terminal shortcut:", error);
      setSendError("写入终端失败");
    }
  };

  const submitDraft = async () => {
    if (!terminal || !activeSessionId) return;
    const el = inputRef.current;
    const text = (el?.value ?? draft).trim();
    if (!text) return;
    if (el) el.value = ""; // 非受控：直接清 DOM
    setDraft(""); // 同步镜像（驱动发送按钮 disabled）
    setSendError(null);
    try {
      await terminal.onSubmit(activeSessionId, text);
    } catch (error) {
      console.error("Failed to submit mobile terminal input:", error);
      if (el) el.value = text; // 失败回填
      setDraft(text);
      setSendError("发送失败");
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1">
      <section className="flex-none rounded-md border border-slate-200 bg-white p-1.5 dark:border-slate-800 dark:bg-slate-950">
        <div className="flex gap-1.5 overflow-x-auto pb-1">
          {layouts.map((layout) => {
            const active = layout.id === currentLayoutId;
            return (
              <button
                key={layout.id}
                type="button"
                onClick={() => onSwitchLayout?.(layout.id)}
                className={`h-8 max-w-[150px] flex-none rounded-md border px-2 text-[12px] font-semibold ${
                  active
                    ? "border-blue-300 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-950/50 dark:text-blue-200"
                    : "border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300"
                }`}
              >
                <span className="block truncate">{layout.name}</span>
              </button>
            );
          })}
          {layouts.length === 0 && (
            <div className="flex h-8 items-center px-2 text-[12px] text-slate-500 dark:text-slate-400">暂无布局</div>
          )}
        </div>
        <div className="flex gap-1.5 overflow-x-auto">
          {panels.map((panel, panelIndex) => {
            const activePane = panel.id === activePaneId;
            const activeTab = panel.tabs.find((tab) => tab.id === panel.activeTabId) ?? panel.tabs[0];
            return (
              <button
                key={panel.id}
                type="button"
                onClick={() => {
                  onSelectPane?.(panel.id);
                  if (activeTab) onSelectTab?.(panel.id, activeTab.id);
                }}
                className={`h-8 max-w-[170px] flex-none rounded-md border px-2 text-left text-[11px] ${
                  activePane
                    ? "border-blue-300 bg-white text-blue-800 dark:border-blue-800 dark:bg-slate-900 dark:text-blue-100"
                    : "border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300"
                }`}
              >
                <span className="block truncate">
                  Pane {panelIndex + 1}{activeTab ? ` / ${activeTab.title}` : ""}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="min-h-0 flex-1 overflow-hidden rounded-md border border-slate-900 bg-[#07111f] text-[12px] leading-5 text-slate-100 shadow-inner">
        {terminal?.tab.contentType === "terminal" && terminal.tab.projectPath ? (
          <TerminalTabContent
            tab={terminal.tab}
            layoutActive
            onSessionCreated={terminal.onSessionCreated}
            onSessionExited={terminal.onSessionExited}
            onTerminalRef={terminal.onTerminalRef}
            onReconnect={terminal.onReconnect}
          />
        ) : (
          <div className="flex h-full min-h-[68dvh] flex-col items-center justify-center px-6 text-center">
            <Terminal className="mb-4 h-10 w-10 text-slate-500" />
            <h3 className="text-[15px] font-semibold text-slate-100">还没有打开真实终端</h3>
            <p className="mt-2 max-w-[280px] text-[12px] leading-5 text-slate-400">
              从工作空间点按项目后，会进入现有 pane 的真实终端会话。
              {openedProject ? ` 当前选择：${openedProject.workspaceName} / ${openedProject.projectName}` : ""}
            </p>
          </div>
        )}
      </section>

      <section className="rounded-md border border-slate-200 bg-white p-2 dark:border-slate-800 dark:bg-slate-950">
        <div className="flex items-center gap-2">
          <CommandChip label="/" disabled={!canSend} onClick={() => void writeShortcut("/")} />
          <CommandChip label="%" disabled={!canSend} onClick={() => void writeShortcut("%")} />
          <input
            ref={inputRef}
            defaultValue=""
            onChange={(event) => {
              // 非受控输入：onChange 只更新镜像 state（驱动发送按钮），不回写 value。
              // 去掉 value prop 后 React 不再程序化设置 node.value，iOS 粘贴后不会被重置成英文键盘/收起键盘。
              // 合成进行中跳过镜像更新，避免打断 iOS IME 合成。
              if (composingRef.current) return;
              setDraft(event.target.value);
            }}
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onCompositionEnd={(event) => {
              composingRef.current = false;
              // 合成结束，提交最终文本（含刚合成出的字符，如 #）。
              setDraft(event.currentTarget.value);
            }}
            onKeyDown={(event) => {
              // 合成中按 Enter 是输入法在选词，不应触发发送。
              if (event.key === "Enter" && !composingRef.current && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void submitDraft();
              }
            }}
            disabled={!canSend}
            placeholder={canSend ? "输入命令或消息..." : "等待终端会话..."}
            className="h-10 min-w-0 flex-1 rounded-md border border-slate-200 bg-slate-50 px-3 text-[13px] text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-blue-400 focus:ring-2 focus:ring-blue-100 disabled:cursor-not-allowed disabled:text-slate-400 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-100 dark:focus:border-blue-700 dark:focus:ring-blue-950"
          />
          <button
            type="button"
            aria-label="发送到终端"
            disabled={!canSend || !draft.trim()}
            onClick={() => void submitDraft()}
            className="grid h-10 w-10 flex-none place-items-center rounded-md bg-blue-600 text-white active:scale-[0.98] disabled:cursor-not-allowed disabled:bg-slate-300 disabled:text-slate-500 dark:disabled:bg-slate-800 dark:disabled:text-slate-500"
          >
            <Send className="h-4 w-4" />
          </button>
        </div>
        {sendError && <div className="mt-1 px-1 text-[11px] text-red-600 dark:text-red-300">{sendError}</div>}
      </section>
    </div>
  );
}

function BottomNav({ view, setView }: { view: ViewId; setView: (view: ViewId) => void }) {
  const items: Array<{ id: ViewId; label: string; icon: ReactNode }> = [
    { id: "workspaces", label: "工作空间", icon: <FolderOpen className="h-5 w-5" /> },
    { id: "layouts", label: "布局", icon: <Columns3 className="h-5 w-5" /> },
    { id: "terminal", label: "终端", icon: <Terminal className="h-5 w-5" /> },
  ];

  return (
    <nav className="flex-none border-t border-slate-200 bg-white px-2 pb-[max(8px,env(safe-area-inset-bottom))] pt-2 dark:border-slate-800 dark:bg-slate-950">
      <div className="grid grid-cols-3 gap-1">
        {items.map((item, index) => {
          const active = view === item.id;
          return (
            <button
              key={`${item.label}-${index}`}
              type="button"
              onClick={() => setView(item.id)}
              className={`flex h-12 flex-col items-center justify-center gap-0.5 rounded-md text-[11px] font-medium transition ${
                active
                  ? "bg-blue-50 text-blue-700 dark:bg-blue-950/50 dark:text-blue-200"
                  : "text-slate-500 hover:bg-slate-50 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-900 dark:hover:text-slate-100"
              }`}
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

function CommandChip({
  label,
  disabled,
  onClick,
}: {
  label: string;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={`输入 ${label}`}
      disabled={disabled}
      onClick={onClick}
      className="grid h-10 w-10 flex-none place-items-center rounded-md border border-slate-200 bg-slate-50 font-mono text-[18px] font-semibold text-slate-700 active:scale-[0.98] disabled:cursor-not-allowed disabled:text-slate-300 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200 dark:disabled:text-slate-600"
    >
      {label}
    </button>
  );
}

function Pill({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-full bg-slate-100 px-2 py-1 text-slate-600 dark:bg-slate-900 dark:text-slate-300">
      {icon}
      <span className="truncate">{label}</span>
    </span>
  );
}

export default MobilePrototype;
