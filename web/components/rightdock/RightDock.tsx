import { useCallback, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Files, FolderOpen, GitBranch, type LucideIcon } from "lucide-react";
import ExplorerFilesSection from "@/components/sidebar/ExplorerFilesSection";
import ExplorerGitSection from "@/components/sidebar/ExplorerGitSection";
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
import type { Workspace, WorkspaceProject } from "@/types";

interface RightDockViewDefinition {
  id: RightDockView;
  icon: LucideIcon;
  titleKey: "rightDock.git" | "rightDock.files";
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

export default function RightDock() {
  const { t } = useTranslation("sidebar");
  const visible = useRightDockStore((state) => state.visible);
  const activeView = useRightDockStore((state) => state.activeView);
  const width = useRightDockStore((state) => state.width);
  const setActiveView = useRightDockStore((state) => state.setActiveView);
  const setWidth = useRightDockStore((state) => state.setWidth);
  const setVisible = useRightDockStore((state) => state.setVisible);
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

  useEffect(() => {
    widthRef.current = width;
  }, [width]);

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
        className="splitview-sash vertical absolute inset-y-0 z-20"
        style={{ width: 10, minWidth: 10, left: -5, cursor: "col-resize" }}
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
      />

      <div className="flex h-11 shrink-0 items-center gap-2 px-2 pl-2">
        <div
          className="flex items-center gap-0.5"
          role="tablist"
          aria-label={`${t("rightDock.git")} / ${t("rightDock.files")}`}
        >
          {RIGHT_DOCK_VIEWS.map(({ id, icon: Icon, titleKey }) => {
            const selected = id === activeView;
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
        </div>
      </div>

      {workspace && selectedProject ? (
        <>
          <div
            className="min-h-0 flex-1 overflow-y-auto px-2 pb-2 pt-2"
            style={activeView === "git" ? undefined : { display: "none" }}
          >
            <ExplorerGitSection
              workspace={workspace}
              selectedProjectId={selectedProject.id}
            />
          </div>
          {activeView === "files" && (
            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2 pt-2">
              <ExplorerFilesSection
                workspace={workspace}
                selectedProjectId={selectedProject.id}
                              />
            </div>
          )}
        </>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2 pt-2">
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
