import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Columns3, FolderOpen, Terminal } from "lucide-react";
import type { Workspace, WorkspaceProject } from "@/types";
import MobileWorkspaceBoard from "./MobileWorkspaceBoard";
import MobileLayoutBoard from "./MobileLayoutBoard";
import MobileTerminalBoard from "./MobileTerminalBoard";
import MobileWorkspaceActionSheet from "./MobileWorkspaceActionSheet";
import { getFirstWorkspaceProject, getPanels, toOpenedProject } from "./mobileUtils";
import type { MobilePrototypeProps, OpenedWorkspaceProject, ViewId } from "./types";

/**
 * 移动端原型（mode=mobile-prototype 路由）。
 *
 * 收敛策略：保留独立路由（MainApp 挂 20+ 桌面全局 hook，且 xs 断点面向窄桌面窗
 * 而非触屏手机），但子块尽量复用主 UI 真实组件——终端渲染用 panes/
 * TerminalTabContent，置顶工作空间快捷区用 home/HomePinnedWorkspaces，空态用
 * ui/EmptyState；主题全部走 --app-* token，与主 UI 同源不再漂移。
 */
export default function MobilePrototype({
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
  const { t } = useTranslation("mobile");
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
    [actionWorkspaceId, workspaces],
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
    <div className="min-h-screen bg-[var(--app-bg-deep)] text-[var(--app-text-primary)]">
      <div className="mx-auto flex min-h-screen w-full max-w-[430px] flex-col bg-[var(--app-content)] shadow-2xl sm:my-6 sm:min-h-[860px] sm:rounded-[28px] sm:border sm:border-[var(--app-border)]">
        {!terminalMode && (
          <header className="flex-none border-b border-[var(--app-border)] bg-[var(--app-panel-bg)] px-4 pb-3 pt-[max(14px,env(safe-area-inset-top))]">
            <div className="flex h-11 items-center justify-between">
              <div className="min-w-0">
                <div className="truncate text-[13px] font-medium text-[var(--app-text-tertiary)]">{t("appTitle")}</div>
                <h1 className="truncate text-[20px] font-semibold leading-6 tracking-normal">{t(`views.${view}`)}</h1>
              </div>
            </div>

            <div className="mt-3 grid grid-cols-4 gap-2">
              <Metric label={t("metrics.workspaces")} value={workspaceCount} tone="text-[var(--app-accent)]" />
              <Metric label={t("metrics.projects")} value={projectCount} tone="text-[var(--app-status-success)]" />
              <Metric label={t("metrics.layouts")} value={visibleLayouts.length} tone="text-[var(--app-tag-blue)]" />
              <Metric label={t("metrics.panes")} value={panels.length} tone="text-[var(--app-tag-amber)]" />
            </div>

            <div className="mt-3 grid grid-cols-3 rounded-md bg-[var(--app-hover)] p-1 text-[13px] font-medium">
              <SegmentButton active={view === "workspaces"} onClick={() => setView("workspaces")}>{t("views.workspaces")}</SegmentButton>
              <SegmentButton active={view === "layouts"} onClick={() => setView("layouts")}>{t("views.layouts")}</SegmentButton>
              <SegmentButton active={false} onClick={() => setView("terminal")}>{t("segment.currentTerminal")}</SegmentButton>
            </div>
          </header>
        )}

        <main className={terminalMode
          ? "flex min-h-0 flex-1 overflow-hidden px-1 pb-1 pt-[max(2px,env(safe-area-inset-top))]"
          : "min-h-0 flex-1 overflow-y-auto px-4 py-4"}
        >
          {view === "workspaces" && (
            <MobileWorkspaceBoard
              openedProject={openedProject}
              loading={workspacesLoading}
              connected={connected}
              workspaces={workspaces}
              onOpenActions={(workspace) => setActionWorkspaceId(workspace.id)}
              onOpenProject={openWorkspaceProject}
            />
          )}
          {view === "layouts" && (
            <MobileLayoutBoard
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
            <MobileTerminalBoard
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
          <MobileWorkspaceActionSheet
            workspace={actionWorkspace}
            onClose={() => setActionWorkspaceId(null)}
            onOpenWorkspace={() => {
              const firstProject = actionWorkspace.projects[0];
              if (firstProject) {
                openWorkspaceProject(actionWorkspace, firstProject);
                setActionWorkspaceId(null);
              }
            }}
            onToggleWorkspacePinned={onToggleWorkspacePinned}
            onToggleWorkspaceHidden={onToggleWorkspaceHidden}
            onOpenWorkspaceFolder={onOpenWorkspaceFolder}
            onOpenWorkspaceFileBrowser={onOpenWorkspaceFileBrowser}
            onSetWorkspaceAlias={onSetWorkspaceAlias}
            onRenameWorkspace={onRenameWorkspace}
            onDeleteWorkspace={onDeleteWorkspace}
          />
        )}
      </div>
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="min-w-0 rounded-md border border-[var(--app-home-border)] bg-[var(--app-home-surface)] px-2 py-2 text-center">
      <div className={`text-[18px] font-semibold leading-5 ${tone}`}>{value}</div>
      <div className="mt-1 truncate text-[11px] text-[var(--app-text-tertiary)]">{label}</div>
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
          ? "bg-[var(--app-panel-bg)] text-[var(--app-text-primary)] shadow-sm"
          : "text-[var(--app-text-tertiary)] hover:text-[var(--app-text-primary)]"
      }`}
    >
      {children}
    </button>
  );
}

function BottomNav({ view, setView }: { view: ViewId; setView: (view: ViewId) => void }) {
  const { t } = useTranslation("mobile");
  const items: Array<{ id: ViewId; label: string; icon: ReactNode }> = [
    { id: "workspaces", label: t("views.workspaces"), icon: <FolderOpen className="h-5 w-5" /> },
    { id: "layouts", label: t("views.layouts"), icon: <Columns3 className="h-5 w-5" /> },
    { id: "terminal", label: t("views.terminal"), icon: <Terminal className="h-5 w-5" /> },
  ];

  return (
    <nav className="flex-none border-t border-[var(--app-border)] bg-[var(--app-panel-bg)] px-2 pb-[max(8px,env(safe-area-inset-bottom))] pt-2">
      <div className="grid grid-cols-3 gap-1">
        {items.map((item) => {
          const active = view === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setView(item.id)}
              className={`flex h-12 flex-col items-center justify-center gap-0.5 rounded-md text-[11px] font-medium transition ${
                active
                  ? "bg-[color-mix(in_srgb,var(--app-accent)_12%,transparent)] text-[var(--app-accent)]"
                  : "text-[var(--app-text-tertiary)] hover:bg-[var(--app-hover)] hover:text-[var(--app-text-primary)]"
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
