import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useWorkspacesStore, useProvidersStore, useThemeStore } from "@/stores";
import { historyService, type LaunchRecord } from "@/services";
import { waitForTauri } from "@/utils";
import WorkspaceTree from "@/components/sidebar/WorkspaceTree";
import RecentLaunches from "@/components/sidebar/RecentLaunches";
import SidebarFooter from "@/components/sidebar/SidebarFooter";
import SplitView from "@/components/panes/SplitView";
import { setDragging } from "@/stores/splitDragState";

const SIDEBAR_SIZES_KEY = "cc-panes-sidebar-sizes";
const DEFAULT_SIZES = [60, 40];

const SIDEBAR_WIDTH_KEY = "cc-panes-sidebar-width";
const DEFAULT_WIDTH = 280;
const MIN_WIDTH = 200;
const MAX_WIDTH = 500;

function loadSidebarSizes(): number[] {
  try {
    const raw = localStorage.getItem(SIDEBAR_SIZES_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length === 2) return parsed;
    }
  } catch { /* ignore */ }
  return DEFAULT_SIZES;
}

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
  collapsed: boolean;
  onToggleCollapse: () => void;
  onOpenTerminal: (path: string, workspaceName?: string, providerId?: string, workspacePath?: string, launchClaude?: boolean) => void;
  onSettings: () => void;
}

export default function Sidebar({
  collapsed,
  onToggleCollapse,
  onOpenTerminal,
  onSettings,
}: SidebarProps) {
  const isDark = useThemeStore((s) => s.isDark);
  const loadWorkspaces = useWorkspacesStore((s) => s.load);
  const loadProviders = useProvidersStore((s) => s.loadProviders);

  const [launchHistory, setLaunchHistory] = useState<LaunchRecord[]>([]);
  const [sidebarSizes, setSidebarSizes] = useState(loadSidebarSizes);
  const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidth);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const widthRef = useRef(sidebarWidth);

  const handleSidebarDragEnd = useCallback((sizes: number[]) => {
    setSidebarSizes(sizes);
    localStorage.setItem(SIDEBAR_SIZES_KEY, JSON.stringify(sizes));
  }, []);

  const splitKeys = useMemo(() => ["workspace-tree", "recent-launches"], []);

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

  const fetchHistory = useCallback(async () => {
    try {
      const list = await historyService.list(10);
      setLaunchHistory(list);
    } catch (e) {
      console.error("Failed to fetch history:", e);
    }
  }, []);

  async function clearHistory() {
    try {
      await historyService.clear();
      setLaunchHistory([]);
    } catch (e) {
      console.error("Failed to clear history:", e);
    }
  }

  useEffect(() => {
    waitForTauri().then((ready) => {
      if (!ready) return;
      loadWorkspaces();
      fetchHistory();
      loadProviders();
    });
  }, [loadWorkspaces, fetchHistory, loadProviders]);

  return (
    <div
      ref={sidebarRef}
      className={`sidebar relative z-10 flex flex-row overflow-hidden backdrop-blur-2xl shadow-[5px_0_40px_rgba(0,0,0,0.05)] ${
        collapsed ? 'transition-[width] duration-300 border-r' : ''
      } ${
        isDark
          ? 'bg-slate-900/40 border-white/10'
          : 'bg-white/60 border-white/40'
      }`}
      style={{
        width: collapsed ? 40 : sidebarWidth,
        height: "100%",
        backgroundImage: isDark
          ? 'linear-gradient(to bottom, rgba(255,255,255,0.05), transparent)'
          : 'linear-gradient(to bottom, rgba(255,255,255,0.70), rgba(255,255,255,0.40), rgba(255,255,255,0.20))',
      }}
    >
      {/* 侧边栏主体内容 */}
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">

      {/* 折叠按钮 */}
      <div
        className="absolute -right-3 top-1/2 -translate-y-1/2 w-6 h-6 rounded-full flex items-center justify-center cursor-pointer z-10 transition-all hover:text-white"
        style={{
          background: "var(--app-glass-bg-heavy)",
          border: "1px solid var(--app-glass-border)",
          color: "var(--app-text-secondary)",
          backdropFilter: "blur(12px)",
        }}
        onClick={onToggleCollapse}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLElement).style.background = "var(--app-accent)";
          (e.currentTarget as HTMLElement).style.borderColor = "var(--app-accent)";
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLElement).style.background = "var(--app-glass-bg-heavy)";
          (e.currentTarget as HTMLElement).style.borderColor = "var(--app-glass-border)";
        }}
      >
        {collapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
      </div>

      {/* 顶部间距（替代原 WindowControls 占位） */}
      <div className="pt-2" />

      {!collapsed && (
        <>
          {/* 可滚动内容区：SplitView 分配两个独立滚动区域 */}
          <div className="flex-1 overflow-hidden">
            <SplitView
              vertical
              sizes={sidebarSizes}
              minSize={60}
              onDragEnd={handleSidebarDragEnd}
              keys={splitKeys}
            >
              {[
                <div key="workspace-tree" className="h-full overflow-y-auto px-3 pb-2">
                  <WorkspaceTree onOpenTerminal={onOpenTerminal} />
                </div>,
                <div key="recent-launches" className="h-full overflow-y-auto px-3 pb-4">
                  <RecentLaunches
                    launchHistory={launchHistory}
                    onOpenTerminal={(path: string) => onOpenTerminal(path)}
                    onClearHistory={clearHistory}
                  />
                </div>,
              ]}
            </SplitView>
          </div>

          <SidebarFooter collapsed={false} onSettings={onSettings} />
        </>
      )}

      {collapsed && <SidebarFooter collapsed onSettings={onSettings} />}

      </div>{/* 侧边栏主体内容结束 */}

      {/* 右边界 resize sash */}
      {!collapsed && (
        <div
          className="splitview-sash vertical"
          onPointerDown={handleResizePointerDown}
        />
      )}
    </div>
  );
}
