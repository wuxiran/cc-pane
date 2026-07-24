import { useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Files, FolderOpen, GitBranch, PanelRightClose, type LucideIcon } from "lucide-react";
import ExplorerFilesSection from "@/components/sidebar/ExplorerFilesSection";
import ExplorerGitSection from "@/components/sidebar/ExplorerGitSection";
import { EmptyState } from "@/components/ui/EmptyState";
import { IconTooltipButton } from "@/components/ui/IconTooltipButton";
import { setDragging } from "@/stores/splitDragState";
import {
  MAX_RIGHT_DOCK_WIDTH,
  MIN_RIGHT_DOCK_WIDTH,
  clampRightDockWidth,
  useRightDockStore,
  type RightDockView,
} from "@/stores/useRightDockStore";
import { useWorkspacesStore } from "@/stores/useWorkspacesStore";
import type { Workspace } from "@/types";
import { getProjectName } from "@/utils/path";
import RightDockStrip from "./RightDockStrip";

interface RightDockRenderContext {
  workspace: Workspace;
  selectedProjectId: string;
}

interface RightDockViewDefinition {
  id: RightDockView;
  icon: LucideIcon;
  titleKey: "rightDock.git" | "rightDock.files";
  render: (context: RightDockRenderContext) => React.ReactNode;
}

const RIGHT_DOCK_VIEWS: readonly RightDockViewDefinition[] = [
  {
    id: "git",
    icon: GitBranch,
    titleKey: "rightDock.git",
    render: ({ workspace, selectedProjectId }) => (
      <ExplorerGitSection workspace={workspace} selectedProjectId={selectedProjectId} />
    ),
  },
  {
    id: "files",
    icon: Files,
    titleKey: "rightDock.files",
    render: ({ workspace, selectedProjectId }) => (
      <ExplorerFilesSection workspace={workspace} selectedProjectId={selectedProjectId} />
    ),
  },
];

export default function RightDock() {
  const { t } = useTranslation("sidebar");
  const visible = useRightDockStore((state) => state.visible);
  const activeView = useRightDockStore((state) => state.activeView);
  const width = useRightDockStore((state) => state.width);
  const toggleView = useRightDockStore((state) => state.toggleView);
  const setWidth = useRightDockStore((state) => state.setWidth);
  const setVisible = useRightDockStore((state) => state.setVisible);
  const workspace = useWorkspacesStore(
    (state) => state.workspaces.find((item) => item.id === state.expandedWorkspaceId) ?? null,
  );
  const selectedProjectId = useWorkspacesStore((state) => state.expandedProjectId);
  const selectedProject = workspace?.projects.find((project) => project.id === selectedProjectId) ?? null;
  const activeDefinition = RIGHT_DOCK_VIEWS.find((view) => view.id === activeView) ?? RIGHT_DOCK_VIEWS[0];
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

  const stripItems = RIGHT_DOCK_VIEWS.map((view) => ({
    id: view.id,
    icon: view.icon,
    label: t(view.titleKey),
  }));
  const projectName = selectedProject
    ? selectedProject.alias || getProjectName(selectedProject.path)
    : null;

  return (
    <div className="relative flex h-full shrink-0">
      {visible && (
        <div
          ref={panelRef}
          data-testid="right-dock-panel"
          className="relative flex h-full shrink-0 flex-col overflow-hidden"
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
            className="splitview-sash vertical absolute inset-y-0 left-0 z-20"
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

          <div className="flex h-12 shrink-0 items-center gap-2 px-3 pl-4">
            <div className="min-w-0 flex-1">
              <div className="text-xs font-semibold text-[var(--app-text-primary)]">
                {t(activeDefinition.titleKey)}
              </div>
              {projectName && (
                <div className="truncate text-[10px] text-[var(--app-text-tertiary)]" title={selectedProject?.path}>
                  {projectName}
                </div>
              )}
            </div>
            <IconTooltipButton
              label={t("rightDock.collapse")}
              side="left"
              onClick={() => setVisible(false)}
              className="h-7 w-7 shrink-0"
            >
              <PanelRightClose className="h-4 w-4" strokeWidth={1.5} />
            </IconTooltipButton>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            {workspace && selectedProjectId && selectedProject ? (
              activeDefinition.render({ workspace, selectedProjectId })
            ) : (
              <EmptyState
                icon={FolderOpen}
                title={t("rightDock.noProject")}
                description={t("rightDock.selectProject")}
                className="h-full"
              />
            )}
          </div>
        </div>
      )}
      <RightDockStrip
        activeView={activeView}
        visible={visible}
        items={stripItems}
        onToggleView={toggleView}
      />
    </div>
  );
}
