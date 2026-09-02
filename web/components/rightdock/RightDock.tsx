import { useCallback, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Files, FolderOpen, FolderSync, GitBranch, type LucideIcon } from "lucide-react";
import ExplorerFilesSection from "@/components/sidebar/ExplorerFilesSection";
import ExplorerGitSection from "@/components/sidebar/ExplorerGitSection";
import SshMachinesView from "@/components/sidebar/SshMachinesView";
import OrchestratorView from "@/components/sidebar/OrchestratorView";
import AiPanelView from "@/components/aipanel/AiPanelView";
import SessionHistoryView from "./SessionHistoryView";
import SshRemoteFilesView from "./SshRemoteFilesView";
import { EmptyState } from "@/components/ui/EmptyState";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { setDragging } from "@/stores/splitDragState";
import {
  MAX_RIGHT_DOCK_WIDTH,
  MIN_RIGHT_DOCK_WIDTH,
  clampRightDockWidth,
  useRightDockStore,
  type RightDockView,
} from "@/stores/useRightDockStore";
import { useWorkspacesStore } from "@/stores/useWorkspacesStore";
import { usePanesStore } from "@/stores/usePanesStore";
import {
  resolveActiveTerminalSelection,
  selectActiveTerminalKey,
} from "@/hooks/useFollowActiveTerminalContext";
import type { OpenTerminalOptions, Workspace, WorkspaceProject } from "@/types";
import { MODULE_CONSUMERS } from "@/modules/registry";
import { useModulePrefsStore } from "@/stores/useModulePrefsStore";
import { useAiPanelStore } from "@/stores/useAiPanelStore";
import { useOrchestratorStore } from "@/stores/useOrchestratorStore";
import { useSshRemoteFilesStore } from "@/stores/useSshRemoteFilesStore";

interface RightDockViewDefinition {
  id: RightDockView;
  icon: LucideIcon;
  titleKey: "rightDock.git" | "rightDock.files" | "rightDock.orchestration";
}

const RIGHT_DOCK_VIEWS: readonly RightDockViewDefinition[] = [
  {
    id: "files",
    icon: Files,
    titleKey: "rightDock.files",
  },
  {
    id: "git",
    icon: GitBranch,
    titleKey: "rightDock.git",
  },
];

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
}

export default function RightDock({ onOpenTerminal }: RightDockProps) {
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
  const widthRef = useRef(width);
  const dockModules = MODULE_CONSUMERS.rightDock.filter((module) => {
    const preference = modulePreferences[module.id];
    const fixedRightDock = module.id === "orchestration";
    return (fixedRightDock || preference.enabled)
      && (fixedRightDock || preference.position === "rightDock")
      && module.surfaces.includes("rightDock");
  });
  const sshDocked = dockModules.some((module) => module.id === "ssh");
  const aiPanelDocked = dockModules.some((module) => module.id === "aiPanel");
  const orchestrationDocked = dockModules.some((module) => module.id === "orchestration");
  const activeDockModuleMissing = (activeView === "ssh" && !sshDocked)
    || (activeView === "aiPanel" && !aiPanelDocked)
    || (activeView === "orchestration" && !orchestrationDocked)
    || (activeView === "sshFiles" && !remoteMachineId);
  const resolvedActiveView = activeDockModuleMissing ? "git" : activeView;

  useEffect(() => {
    widthRef.current = width;
  }, [width]);

  useEffect(() => {
    if (activeDockModuleMissing) setActiveView("git");
  }, [activeDockModuleMissing, setActiveView]);

  const handleResizePointerDown = useCallback((event: React.PointerEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = widthRef.current;
    let animationFrame = 0;

    const handlePointerMove = (moveEvent: PointerEvent) => {
      cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(() => {
        const nextWidth = clampRightDockWidth(startWidth + startX - moveEvent.clientX);
        widthRef.current = nextWidth;
        if (panelRef.current) panelRef.current.style.width = `${nextWidth}px`;
      });
    };

    const handlePointerUp = () => {
      cancelAnimationFrame(animationFrame);
      document.removeEventListener("pointermove", handlePointerMove);
      document.removeEventListener("pointerup", handlePointerUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setDragging(false);
      setWidth(widthRef.current);
    };

    setDragging(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("pointermove", handlePointerMove);
    document.addEventListener("pointerup", handlePointerUp);
  }, [setWidth]);

  if (!visible) return null;

  return (
    <div
      ref={panelRef}
      data-testid="right-dock-panel"
      className="relative flex h-full shrink-0 flex-col"
      style={{
        width,
        background: "var(--app-sidebar-bg)",
        borderLeft: "1px solid var(--app-border)",
        backdropFilter: "blur(var(--app-glass-blur))",
        WebkitBackdropFilter: "blur(var(--app-glass-blur))",
        WebkitAppRegion: "no-drag",
      } as React.CSSProperties}
    >
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
          left: -7,
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

      <div className="flex h-11 shrink-0 items-center gap-2 px-2 pl-2">
        <div
          className="flex items-center gap-0.5"
          role="tablist"
          aria-label={[
            t("rightDock.git"),
            t("rightDock.files"),
            ...dockModules.map((module) => t(module.titleKey as never)),
          ].join(" / ")}
        >
          {RIGHT_DOCK_VIEWS.map(({ id, icon: Icon, titleKey }) => {
            const selected = id === resolvedActiveView;
            return (
              <Tooltip key={id}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    aria-label={t(titleKey)}
                    onClick={() => setActiveView(id)}
                    className={`relative flex h-[36px] w-[38px] items-center justify-center transition-colors duration-[var(--dur-fast)] ${
                      selected ? "" : "hover:text-[var(--app-text-primary)]"
                    }`}
                    style={{
                      color: selected ? "var(--app-text-primary)" : "var(--app-text-tertiary)",
                    }}
                  >
                    <Icon className="h-[19px] w-[19px]" strokeWidth={1.6} />
                    {selected && (
                      <span
                        aria-hidden
                        className="absolute inset-x-2 bottom-0 h-[2px] rounded-full"
                        style={{ background: "var(--app-text-primary)" }}
                      />
                    )}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">{t(titleKey)}</TooltipContent>
              </Tooltip>
            );
          })}
          {remoteMachineId && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  role="tab"
                  aria-selected={resolvedActiveView === "sshFiles"}
                  aria-label={t("rightDock.remoteFiles")}
                  onClick={() => setActiveView("sshFiles")}
                  className="relative flex h-[36px] w-[38px] items-center justify-center transition-colors duration-[var(--dur-fast)]"
                  style={{
                    color: resolvedActiveView === "sshFiles"
                      ? "var(--app-text-primary)"
                      : "var(--app-text-tertiary)",
                  }}
                >
                  <FolderSync className="h-[19px] w-[19px]" strokeWidth={1.6} />
                  {resolvedActiveView === "sshFiles" && (
                    <span aria-hidden className="absolute inset-x-2 bottom-0 h-[2px] rounded-full" style={{ background: "var(--app-text-primary)" }} />
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{t("rightDock.remoteFiles")}</TooltipContent>
            </Tooltip>
          )}
          {dockModules.map((module) => {
            const Icon = module.icon;
            const selected = module.id === resolvedActiveView;
            const label = t(module.titleKey as never);
            const badge = module.badge?.({ bindings, aiPanelUnreadCount });
            const badgeTone = typeof badge === "number" ? "blue" : badge?.tone;
            return (
              <Tooltip key={module.id}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    role="tab"
                    data-module-id={module.id}
                    aria-selected={selected}
                    aria-label={label}
                    onClick={() => module.open("rightDock")}
                    className={`relative flex h-[36px] w-[38px] items-center justify-center transition-colors duration-[var(--dur-fast)] ${
                      selected ? "" : "hover:text-[var(--app-text-primary)]"
                    }`}
                    style={{
                      color: selected ? "var(--app-text-primary)" : "var(--app-text-tertiary)",
                    }}
                  >
                    <Icon className="h-[19px] w-[19px]" strokeWidth={1.6} />
                    {badge != null && (
                      <span
                        data-testid={`right-dock-module-badge-${module.id}`}
                        aria-hidden="true"
                        className={`absolute right-1.5 top-1.5 size-1.5 rounded-full ${
                          badgeTone === "red"
                            ? "bg-[var(--app-status-danger)]"
                            : badgeTone === "amber"
                              ? "bg-[var(--app-status-warning)]"
                              : "bg-[var(--app-accent)]"
                        }`}
                      />
                    )}
                    {selected && (
                      <span
                        aria-hidden
                        className="absolute inset-x-2 bottom-0 h-[2px] rounded-full"
                        style={{ background: "var(--app-text-primary)" }}
                      />
                    )}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">{label}</TooltipContent>
              </Tooltip>
            );
          })}
        </div>
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
      ) : resolvedActiveView === "sessionHistory" ? (
        <div className="min-h-0 flex-1 overflow-hidden">
          <SessionHistoryView
            workspaces={workspaces}
            workspace={workspace}
            project={selectedProject}
            onOpenTerminal={onOpenTerminal}
          />
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
            className="h-full"
          />
        </div>
      )}
    </div>
  );
}
