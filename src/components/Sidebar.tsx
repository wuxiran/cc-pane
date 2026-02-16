import { useState, useEffect, useCallback } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useWorkspacesStore, useProvidersStore, useThemeStore } from "@/stores";
import { historyService, type LaunchRecord } from "@/services";
import WindowControls from "@/components/sidebar/WindowControls";
import WorkspaceTree from "@/components/sidebar/WorkspaceTree";
import RecentLaunches from "@/components/sidebar/RecentLaunches";
import SidebarFooter from "@/components/sidebar/SidebarFooter";

interface SidebarProps {
  collapsed: boolean;
  onToggleCollapse: () => void;
  onOpenTerminal: (path: string, workspaceName?: string, providerId?: string) => void;
  onImport: () => void;
  onNew: () => void;
  onSettings: () => void;
}

export default function Sidebar({
  collapsed,
  onToggleCollapse,
  onOpenTerminal,
  onImport,
  onNew,
  onSettings,
}: SidebarProps) {
  const isDark = useThemeStore((s) => s.isDark);
  const loadWorkspaces = useWorkspacesStore((s) => s.load);
  const loadProviders = useProvidersStore((s) => s.loadProviders);

  const [launchHistory, setLaunchHistory] = useState<LaunchRecord[]>([]);

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
    loadWorkspaces();
    fetchHistory();
    loadProviders();
  }, [loadWorkspaces, fetchHistory, loadProviders]);

  return (
    <div
      className={`sidebar relative z-10 flex flex-col overflow-hidden transition-[width] duration-300 border-r backdrop-blur-2xl shadow-[5px_0_40px_rgba(0,0,0,0.05)] ${
        isDark
          ? 'bg-slate-900/40 border-white/10'
          : 'bg-white/60 border-white/40'
      }`}
      style={{
        width: collapsed ? 40 : 280,
        height: "100%",
        backgroundImage: isDark
          ? 'linear-gradient(to bottom, rgba(255,255,255,0.05), transparent)'
          : 'linear-gradient(to bottom, rgba(255,255,255,0.70), rgba(255,255,255,0.40), rgba(255,255,255,0.20))',
      }}
    >
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

      <WindowControls collapsed={collapsed} onImport={onImport} onNew={onNew} />

      {!collapsed && (
        <>
          {/* 可滚动内容区 */}
          <div className="flex-1 overflow-y-auto px-3 pb-4">
            <WorkspaceTree
              onOpenTerminal={onOpenTerminal}
            />
            <RecentLaunches
              launchHistory={launchHistory}
              onOpenTerminal={(path: string) => onOpenTerminal(path)}
              onClearHistory={clearHistory}
            />
          </div>

          <SidebarFooter collapsed={false} onSettings={onSettings} />
        </>
      )}

      {collapsed && <SidebarFooter collapsed onSettings={onSettings} />}
    </div>
  );
}
