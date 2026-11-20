import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Folder, FolderOpen, FolderSync, GitBranch, MessageSquare, MessageSquareCode } from "lucide-react";
import ExplorerFilesSection from "@/components/sidebar/ExplorerFilesSection";
import ExplorerGitSection from "@/components/sidebar/ExplorerGitSection";
import SshMachinesView from "@/components/sidebar/SshMachinesView";
import OrchestratorView from "@/components/sidebar/OrchestratorView";
import AiPanelView from "@/components/aipanel/AiPanelView";
import DockChatView from "./DockChatView";
import DockRail, { type DockRailItem } from "./DockRail";
import { askDockChatToReview } from "./dockChatReview";
import {
  TOGGLE_RIGHT_DOCK_COMMAND,
  dockViewCommandId,
  openDockRailView,
  resolveDockModules,
  resolveDockRailViews,
} from "./dockRailViews";
import SshRemoteFilesView from "./SshRemoteFilesView";
import { EmptyState } from "@/components/ui/EmptyState";
import { usePanelResize } from "@/hooks/usePanelResize";
import {
  MAX_RIGHT_DOCK_WIDTH,
  MIN_RIGHT_DOCK_WIDTH,
  useRightDockStore,
} from "@/stores/useRightDockStore";
import { useWorkspacesStore } from "@/stores/useWorkspacesStore";
import { usePanesStore } from "@/stores/usePanesStore";
import {
  resolveActiveTerminalSelection,
  selectActiveTerminalKey,
} from "@/hooks/useFollowActiveTerminalContext";
import type { OpenTerminalOptions, Workspace, WorkspaceProject } from "@/types";
import { useModulePrefsStore } from "@/stores/useModulePrefsStore";
import { useAiPanelStore } from "@/stores/useAiPanelStore";
import { useOrchestratorStore } from "@/stores/useOrchestratorStore";
import { useAgentChatStore } from "@/stores/useAgentChatStore";
import { useDockChatStore } from "@/stores/useDockChatStore";
import { useSshRemoteFilesStore } from "@/stores/useSshRemoteFilesStore";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { formatKeyCombo } from "@/stores/useShortcutsStore";
import { getProjectName } from "@/utils/path";

export function resolveRightDockProject(
  workspace: Workspace | null,
  selectedProjectId: string | null,
): WorkspaceProject | null {
  if (!workspace) return null;
  return workspace.projects.find((project) => project.id === selectedProjectId)
    ?? workspace.projects[0]
    ?? null;
}

/**
 * 面板目标工作空间的纵深解析：显式选中项目所在 ws > 显式展开 ws >
 * 活跃终端派生 ws > 首个有项目的 ws > 首个 ws。
 * 防止 store 同步失效时兜底落在空工作空间上（"永不空白"约定）。
 */
export function resolveRightDockWorkspace(
  workspaces: Workspace[],
  expandedWorkspaceId: string | null,
  expandedProjectId: string | null,
  activeSelection: { workspaceId: string; projectId: string } | null,
): { workspace: Workspace | null; projectId: string | null } {
  const byProject = expandedProjectId
    ? workspaces.find((w) => w.projects.some((p) => p.id === expandedProjectId))
    : undefined;
  if (byProject) return { workspace: byProject, projectId: expandedProjectId };

  const byId = expandedWorkspaceId
    ? workspaces.find((w) => w.id === expandedWorkspaceId)
    : undefined;
  if (byId && byId.projects.length > 0) return { workspace: byId, projectId: null };

  if (activeSelection) {
    const byActive = workspaces.find((w) => w.id === activeSelection.workspaceId);
    if (byActive) return { workspace: byActive, projectId: activeSelection.projectId };
  }

  return {
    workspace: byId
      ?? workspaces.find((w) => w.projects.length > 0)
      ?? workspaces[0]
      ?? null,
    projectId: null,
  };
}

interface RightDockProps {
  onOpenTerminal: (options: OpenTerminalOptions) => void;
  /** 浮层模式（窄档 Sheet 内）：铺满宿主、隐藏常驻栏才有的拖宽手柄与左边框。 */
  overlay?: boolean;
}

export default function RightDock({ onOpenTerminal, overlay = false }: RightDockProps) {
  const { t } = useTranslation("sidebar");
  const visible = useRightDockStore((state) => state.visible);
  const activeView = useRightDockStore((state) => state.activeView);
  const width = useRightDockStore((state) => state.width);
  const setActiveView = useRightDockStore((state) => state.setActiveView);
  const setWidth = useRightDockStore((state) => state.setWidth);
  const setVisible = useRightDockStore((state) => state.setVisible);
  const modulePreferences = useModulePrefsStore((state) => state.preferences);
  const bindings = useOrchestratorStore((state) => state.bindings);
  const aiPanelUnreadCount = useAiPanelStore((state) => state.unreadPanelIds.length);
  const remoteMachineId = useSshRemoteFilesStore((state) => state.machineId);
  const workspaces = useWorkspacesStore((state) => state.workspaces);
  const expandedWorkspaceId = useWorkspacesStore((state) => state.expandedWorkspaceId);
  const expandedProjectId = useWorkspacesStore((state) => state.expandedProjectId);
  const activeTerminalKey = usePanesStore(selectActiveTerminalKey);
  const { workspace, projectId: selectedProjectId } = useMemo(
    () => resolveRightDockWorkspace(
      workspaces,
      expandedWorkspaceId,
      expandedProjectId,
      activeTerminalKey ? resolveActiveTerminalSelection(workspaces) : null,
    ),
    [workspaces, expandedWorkspaceId, expandedProjectId, activeTerminalKey],
  );
  const selectedProject = resolveRightDockProject(workspace, selectedProjectId);
  const panelRef = useRef<HTMLDivElement>(null);
  const shortcutBindings = useSettingsStore((state) => state.settings?.shortcuts.bindings);
  const shortcutOf = (commandId: string) => {
    const combo = shortcutBindings?.[commandId];
    return combo ? formatKeyCombo(combo) : undefined;
  };
  const dockModules = resolveDockModules(modulePreferences);
  const sshDocked = dockModules.some((module) => module.id === "ssh");
  const aiPanelDocked = dockModules.some((module) => module.id === "aiPanel");
  const orchestrationDocked = dockModules.some((module) => module.id === "orchestration");
  const activeDockModuleMissing = (activeView === "ssh" && !sshDocked)
    || (activeView === "aiPanel" && !aiPanelDocked)
    || (activeView === "orchestration" && !orchestrationDocked)
    || (activeView === "sshFiles" && !remoteMachineId);
  const resolvedActiveView = activeDockModuleMissing ? "git" : activeView === "sessionHistory" ? "chat" : activeView;
  // 有对话在跑而用户在看别的视图时，对话图标上挂个点。
  const dockChatIds = useDockChatStore((state) => state.chats.map((chat) => chat.id).join("\n"));
  const dockChatBusy = useAgentChatStore((state) => dockChatIds.split("\n").some((id) => {
    const chat = state.chats[id];
    return Boolean(chat && (chat.pendingPermissions.length > 0 || chat.snapshot?.phase === "generating" || chat.pendingPrompt));
  }));
  const builtinRail = {
    chat: { icon: MessageSquare, label: t("rightDock.chat"),
      badge: dockChatBusy && resolvedActiveView !== "chat" ? "amber" as const : undefined },
    files: { icon: Folder, label: t("rightDock.files") },
    git: { icon: GitBranch, label: t("rightDock.git") },
    sshFiles: { icon: FolderSync, label: t("rightDock.remoteFiles") },
  };
  const railItems: DockRailItem[] = resolveDockRailViews(dockModules, remoteMachineId).map((view, index) => {
    const shortcut = index < 9 ? shortcutOf(dockViewCommandId(index)) : undefined;
    if (view.kind === "builtin") {
      return { id: view.id, ...builtinRail[view.id], shortcut, onSelect: () => openDockRailView(view) };
    }
    const badge = view.module.badge?.({ bindings, aiPanelUnreadCount });
    return {
      id: view.id,
      icon: view.module.icon,
      label: t(view.module.titleKey as never),
      shortcut,
      onSelect: () => openDockRailView(view),
      badge: badge == null ? undefined : typeof badge === "number" ? "blue" : badge.tone,
    };
  });


  useEffect(() => {
    if (activeDockModuleMissing) setActiveView("git");
    // 旧入口（模块菜单、命令面板）仍可能把视图设成会话历史：转到对话的历史面板。
    else if (activeView === "sessionHistory") {
      setActiveView("chat");
      useDockChatStore.getState().openHistory("terminal");
    }
  }, [activeDockModuleMissing, activeView, setActiveView]);

  const handleResizePointerDown = usePanelResize({ element: panelRef, width, min: MIN_RIGHT_DOCK_WIDTH,
    max: MAX_RIGHT_DOCK_WIDTH, direction: -1, onCommit: setWidth, onCollapse: () => setVisible(false) });

  if (!visible) return null;

  return (
    <div
      ref={panelRef}
      data-testid="right-dock-panel"
      className="relative flex h-full shrink-0 flex-row"
      style={{
        width: overlay ? "100%" : width,
        background: "var(--app-sidebar-bg)",
        borderLeft: overlay ? undefined : "1px solid var(--app-border)",
        WebkitAppRegion: "no-drag",
      } as React.CSSProperties}
    >
      {!overlay && (
      <div
        role="separator"
        aria-label={t("rightDock.resize")}
        aria-orientation="vertical"
        aria-valuemin={MIN_RIGHT_DOCK_WIDTH}
        aria-valuemax={MAX_RIGHT_DOCK_WIDTH}
        aria-valuenow={width}
        tabIndex={0}
        className="group absolute inset-y-0 z-30 outline-none"
        style={{
          width: 14,
          minWidth: 14,
          left: 0,
          cursor: "col-resize",
          touchAction: "none",
        }}
        onPointerDown={handleResizePointerDown}
        onDoubleClick={() => setVisible(false)}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") {
            event.preventDefault();
            setWidth(width + 10);
          }
          if (event.key === "ArrowRight") {
            event.preventDefault();
            setWidth(width - 10);
          }
        }}
      >
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-3 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors group-hover:bg-[var(--app-accent)] group-focus-visible:bg-[var(--app-accent)]"
        />
      </div>
      )}

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {resolvedActiveView === "chat" ? (
        <DockChatView
          defaultCwd={selectedProject?.path ?? null}
          workspaces={workspaces}
          workspace={workspace}
          project={selectedProject}
          onOpenTerminal={onOpenTerminal}
        />
      ) : (
      <>
      <div className="flex h-10 shrink-0 items-center gap-2 border-b pl-3 pr-1.5 text-xs font-medium" style={{ borderColor: "var(--app-border)", color: "var(--app-text-secondary)" }}>
        <span className="min-w-0 flex-1 truncate">{railItems.find((item) => item.id === resolvedActiveView)?.label}</span>
        {resolvedActiveView === "git" && selectedProject && (
          <button
            type="button"
            data-testid="right-dock-review-with-chat"
            title={t("rightDock.reviewWithChatHint", { name: selectedProject.alias || getProjectName(selectedProject.path) })}
            onClick={() => askDockChatToReview(selectedProject.path, selectedProject.alias || getProjectName(selectedProject.path))}
            className="flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 font-normal text-[var(--app-text-secondary)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-text-primary)]"
          >
            <MessageSquareCode className="size-3.5" />
            {t("rightDock.reviewWithChat")}
          </button>
        )}
      </div>
      {resolvedActiveView === "sshFiles" ? (
        <div className="min-h-0 flex-1 overflow-hidden">
          <SshRemoteFilesView onOpenTerminal={onOpenTerminal} />
        </div>
      ) : resolvedActiveView === "orchestration" ? (
        <div className="min-h-0 flex-1 overflow-hidden">
          <OrchestratorView onOpenTerminal={onOpenTerminal} compact />
        </div>
      ) : resolvedActiveView === "aiPanel" ? (
        <div className="min-h-0 flex-1 overflow-hidden">
          <AiPanelView />
        </div>
      ) : resolvedActiveView === "ssh" ? (
        <div className="min-h-0 flex-1 overflow-hidden px-2 pb-2 pt-2">
          <SshMachinesView onOpenTerminal={onOpenTerminal} />
        </div>
      ) : workspace && selectedProject ? (
        <>
          <div
            className="app-scrollbar min-h-0 flex-1 overflow-y-auto px-2 pb-2 pt-2"
            style={resolvedActiveView === "git" ? undefined : { display: "none" }}
          >
            <ExplorerGitSection
              workspace={workspace}
              selectedProjectId={selectedProject.id}
              onAskReview={(project, name) => askDockChatToReview(project.path, name)}
            />
          </div>
          {resolvedActiveView === "files" && (
            <div className="app-scrollbar min-h-0 flex-1 overflow-y-auto px-2 pb-2 pt-2">
              <ExplorerFilesSection
                workspace={workspace}
                selectedProjectId={selectedProject.id}
                              />
            </div>
          )}
        </>
      ) : (
        <div className="app-scrollbar min-h-0 flex-1 overflow-y-auto px-2 pb-2 pt-2">
          <EmptyState
            icon={FolderOpen}
            title={t("rightDock.noProject")}
            description={t("rightDock.selectProject")}
            illustration="empty-folder"
            className="h-full"
          />
        </div>
      )}
      </>
      )}
      </div>

      <DockRail
        items={railItems}
        activeId={resolvedActiveView}
        collapseLabel={t("rightDock.collapse")}
        collapseShortcut={shortcutOf(TOGGLE_RIGHT_DOCK_COMMAND)}
        onCollapse={() => setVisible(false)}
      />
    </div>
  );
}
