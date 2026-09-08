import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { isTauriRuntime, waitForTauri } from "@/utils";
import { useWorkspacesStore, useProvidersStore, useSshMachinesStore } from "@/stores";
import type { ActivityView } from "@/stores/useActivityBarStore";
import { historyService } from "@/services";
import ExplorerView from "@/components/sidebar/ExplorerView";
import WorkspaceEnvironmentPanel from "@/components/sidebar/WorkspaceEnvironmentPanel";
import SessionsView from "@/components/sidebar/SessionsView";
import OrchestratorView from "@/components/sidebar/OrchestratorView";
import FileBrowserView from "@/components/sidebar/FileBrowserView";
import SshMachinesView from "@/components/sidebar/SshMachinesView";
import { usePanelResize } from "@/hooks/usePanelResize";
import { useActivityBarStore } from "@/stores/useActivityBarStore";
import {
  clampSidebarWidth,
  MIN_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  loadSidebarWidth,
  saveSidebarWidth,
} from "@/lib/sidebarWidth";

async function waitForRuntimeReady(): Promise<boolean> {
  return isTauriRuntime() ? waitForTauri() : true;
}

import type { OpenTerminalOptions } from "@/types";

interface SidebarProps {
  activeView: ActivityView;
  onOpenTerminal: (opts: OpenTerminalOptions) => void;
}

export default function Sidebar({
  activeView,
  onOpenTerminal,
}: SidebarProps) {
  const { t } = useTranslation("sidebar");
  const loadWorkspaces = useWorkspacesStore((s) => s.load);
  const loadProviders = useProvidersStore((s) => s.loadProviders);
  const loadSshMachines = useSshMachinesStore((s) => s.load);

  const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidth);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const saveWidth = (width: number) => { const value = clampSidebarWidth(width); setSidebarWidth(value); saveSidebarWidth(value); };
  const collapse = () => useActivityBarStore.getState().setSidebarVisible(false);
  const handleResizePointerDown = usePanelResize({ element: sidebarRef, width: sidebarWidth,
    min: MIN_SIDEBAR_WIDTH, max: MAX_SIDEBAR_WIDTH, onCommit: saveWidth, onCollapse: collapse });

  useEffect(() => {
    waitForRuntimeReady().then(async (ready) => {
      if (!ready) return;
      await loadWorkspaces();
      historyService.list(1).catch(() => {}); // warm up
      loadProviders();
      loadSshMachines().catch(() => {});
    });
  }, [loadProviders, loadSshMachines, loadWorkspaces]);

  return (
    <div
      ref={sidebarRef}
      className="sidebar @container/sidebar shape-surface relative z-10 flex flex-row overflow-hidden"
      style={{
        width: sidebarWidth,
        height: "100%",
        background: "var(--app-sidebar-bg)",
        borderRight: "1px solid var(--app-border)",
        backdropFilter: `blur(var(--app-glass-blur))`,
        WebkitBackdropFilter: `blur(var(--app-glass-blur))`,
        WebkitAppRegion: "no-drag",
      } as React.CSSProperties}
    >
      {/* 侧边栏主体内容 */}
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        {/* 视图内容 — 条件渲染 */}
        {activeView === "explorer" && (
          <ExplorerView onOpenTerminal={onOpenTerminal} />
        )}
        {activeView === "sessions" && (
          <SessionsView onOpenTerminal={onOpenTerminal} />
        )}
        {activeView === "files" && (
          <FileBrowserView />
        )}
        {/* activeView === "process" 已禁用（macOS 卡顿排查）
        {activeView === "process" && (
          <ProcessView />
        )}
        */}
        {activeView === "ssh" && (
          <SshMachinesView onOpenTerminal={onOpenTerminal} />
        )}
        {activeView === "orchestration" && (
          <OrchestratorView onOpenTerminal={onOpenTerminal} />
        )}
      </div>

      <WorkspaceEnvironmentPanel />

      {/* 右边界 resize sash */}
      <div
        className="splitview-sash vertical"
        role="separator" aria-label={t("resizeSidebar")} aria-orientation="vertical" tabIndex={0}
        aria-valuemin={MIN_SIDEBAR_WIDTH} aria-valuemax={MAX_SIDEBAR_WIDTH} aria-valuenow={sidebarWidth}
        style={{ width: 12, right: 0, cursor: "col-resize", touchAction: "none" }}
        onDoubleClick={collapse}
        onKeyDown={e => { if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); saveWidth(sidebarWidth + (e.key === "ArrowRight" ? 10 : -10)); } }}
        onPointerDown={handleResizePointerDown}
      />
    </div>
  );
}
