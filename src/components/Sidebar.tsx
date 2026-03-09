import { useEffect, useCallback, useRef, useState } from "react";
import { useWorkspacesStore, useProvidersStore } from "@/stores";
import type { ActivityView } from "@/stores/useActivityBarStore";
import { historyService, localHistoryService } from "@/services";
import { waitForTauri } from "@/utils";
import ExplorerView from "@/components/sidebar/ExplorerView";
import SessionsView from "@/components/sidebar/SessionsView";
import SearchView from "@/components/sidebar/SearchView";
import FileBrowserView from "@/components/sidebar/FileBrowserView";
import { setDragging } from "@/stores/splitDragState";

const SIDEBAR_WIDTH_KEY = "cc-panes-sidebar-width";
const DEFAULT_WIDTH = 280;
const MIN_WIDTH = 200;
const MAX_WIDTH = 500;

function loadSidebarWidth(): number {
  try {
    const raw = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    if (raw) {
      const parsed = Number(raw);
      if (parsed >= MIN_WIDTH && parsed <= MAX_WIDTH) return parsed;
    }
  } catch { /* ignore */ }
  return DEFAULT_WIDTH;
}

interface SidebarProps {
  activeView: ActivityView;
  onOpenTerminal: (path: string, workspaceName?: string, providerId?: string, workspacePath?: string, launchClaude?: boolean, resumeId?: string) => void;
}

export default function Sidebar({
  activeView,
  onOpenTerminal,
}: SidebarProps) {
  const loadWorkspaces = useWorkspacesStore((s) => s.load);
  const loadProviders = useProvidersStore((s) => s.loadProviders);

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
        const newWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + delta));
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
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(finalWidth));
    };

    setDragging(true);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }, []);

  useEffect(() => {
    waitForTauri().then(async (ready) => {
      if (!ready) return;
      await loadWorkspaces();
      historyService.list(1).catch(() => {}); // warm up
      loadProviders();
      // 应用启动时为所有工作空间项目恢复 history watcher（幂等）
      const allWorkspaces = useWorkspacesStore.getState().workspaces;
      for (const ws of allWorkspaces) {
        for (const project of ws.projects) {
          localHistoryService.initProjectHistory(project.path).catch(console.error);
        }
      }
    });
  }, [loadWorkspaces, loadProviders]);

  return (
    <div
      ref={sidebarRef}
      className="sidebar relative z-10 flex flex-row overflow-hidden"
      style={{
        width: sidebarWidth,
        height: "100%",
        background: "var(--app-sidebar-bg)",
        borderRight: "1px solid var(--app-border)",
        backdropFilter: `blur(var(--app-glass-blur))`,
        WebkitBackdropFilter: `blur(var(--app-glass-blur))`,
      }}
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
        {activeView === "search" && (
          <SearchView />
        )}
        {activeView === "files" && (
          <FileBrowserView />
        )}
      </div>

      {/* 右边界 resize sash */}
      <div
        className="splitview-sash vertical"
        onPointerDown={handleResizePointerDown}
      />
    </div>
  );
}
