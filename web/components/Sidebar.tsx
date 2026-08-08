import { useEffect, useCallback, useRef, useState } from "react";
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
import { setDragging } from "@/stores/splitDragState";
import {
  clampSidebarWidth,
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
  const loadWorkspaces = useWorkspacesStore((s) => s.load);
  const loadProviders = useProvidersStore((s) => s.loadProviders);
  const loadSshMachines = useSshMachinesStore((s) => s.load);

  const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidth);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const widthRef = useRef(sidebarWidth);

  const handleResizePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = widthRef.current;
    let rafId = 0;

    const onMove = (ev: PointerEvent) => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        const delta = ev.clientX - startX;
        const newWidth = clampSidebarWidth(startWidth + delta);
        widthRef.current = newWidth;
        if (sidebarRef.current) {
          sidebarRef.current.style.width = `${newWidth}px`;
        }
      });
    };

    const onUp = () => {
      cancelAnimationFrame(rafId);
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      setDragging(false);
      const finalWidth = widthRef.current;
      setSidebarWidth(finalWidth);
      saveSidebarWidth(finalWidth);
    };

    setDragging(true);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }, []);

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
        onPointerDown={handleResizePointerDown}
      />
    </div>
  );
}
