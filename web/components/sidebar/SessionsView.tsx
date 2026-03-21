import { useState, useEffect, useCallback } from "react";
import { Terminal } from "lucide-react";
import { useTerminalStatusStore, usePanesStore } from "@/stores";
import { historyService, type LaunchRecord } from "@/services";
import RecentLaunches from "@/components/sidebar/RecentLaunches";
import { handleErrorSilent } from "@/utils";
import ProcessMonitorSection from "@/components/sidebar/ProcessMonitorSection";

import type { PaneNode, Panel as PanelType, OpenTerminalOptions } from "@/types";

/** 递归收集所有 Panel 节点 */
function getAllPanels(pane: PaneNode): PanelType[] {
  if (pane.type === "panel") return [pane];
  return pane.children.flatMap(getAllPanels);
}

interface SessionsViewProps {
  onOpenTerminal: (opts: OpenTerminalOptions) => void;
}

export default function SessionsView({ onOpenTerminal }: SessionsViewProps) {
  const statusMap = useTerminalStatusStore((s) => s.statusMap);
  const rootPane = usePanesStore((s) => s.rootPane);

  const [launchHistory, setLaunchHistory] = useState<LaunchRecord[]>([]);

  const fetchHistory = useCallback(async () => {
    try {
      const list = await historyService.list(30);
      setLaunchHistory(list);
    } catch (e) {
      handleErrorSilent(e, "fetch history");
    }
  }, []);

  async function clearHistory() {
    try {
      await historyService.clear();
      setLaunchHistory([]);
    } catch (e) {
      handleErrorSilent(e, "clear history");
    }
  }

  async function deleteRecord(id: number) {
    try {
      await historyService.delete(id);
      window.dispatchEvent(new Event('cc-panes:history-updated'));
    } catch (e) {
      handleErrorSilent(e, "delete record");
    }
  }

  useEffect(() => {
    fetchHistory();
    const handler = () => { fetchHistory(); };
    window.addEventListener('cc-panes:history-updated', handler);
    return () => { window.removeEventListener('cc-panes:history-updated', handler); };
  }, [fetchHistory]);

  // 收集活跃终端会话
  const allPanels = getAllPanels(rootPane);
  const activeSessions = allPanels.flatMap((panel) =>
    panel.tabs
      .filter((tab) => tab.sessionId && tab.contentType === "terminal")
      .map((tab) => ({
        tabId: tab.id,
        paneId: panel.id,
        title: tab.title,
        sessionId: tab.sessionId!,
        status: statusMap.get(tab.sessionId!)?.status ?? "idle",
      }))
  );

  return (
    <div className="flex flex-col h-full">
      {/* 视图标题栏 */}
      <div className="flex items-center justify-between px-4 py-2 shrink-0">
        <span
          className="text-[11px] font-bold tracking-wider"
          style={{ color: "var(--app-text-secondary)" }}
        >
          SESSIONS
        </span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* 系统进程监控 */}
        <ProcessMonitorSection />

        {/* 活跃会话 */}
        {activeSessions.length > 0 && (
          <div className="px-3 mb-3">
            <span className="text-[10px] font-bold uppercase tracking-wider px-1 text-[var(--app-text-tertiary)]">
              Active ({activeSessions.length})
            </span>
            <div className="mt-1 space-y-0.5">
              {activeSessions.map((s) => (
                <button
                  key={s.tabId}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg transition-colors text-left hover:bg-[var(--app-hover)] text-[var(--app-text-secondary)]"
                  onClick={() => {
                    usePanesStore.getState().setActivePane(s.paneId);
                    usePanesStore.getState().selectTab(s.paneId, s.tabId);
                  }}
                >
                  <div className="relative shrink-0">
                    <Terminal className="w-3.5 h-3.5" />
                    <div className={`absolute -bottom-0.5 -right-0.5 w-1.5 h-1.5 rounded-full ${
                      s.status === "active" ? "bg-emerald-500" : "bg-slate-400"
                    }`} />
                  </div>
                  <span className="text-[12px] truncate">{s.title || "Terminal"}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* 最近启动历史 — 零修改 */}
        <div className="px-3 pb-4">
          <RecentLaunches
            launchHistory={launchHistory}
            onOpenTerminal={(path: string, resumeId?: string, workspacePath?: string, launchCwd?: string, workspaceName?: string, providerId?: string) => {
              const effectiveCwd = launchCwd ?? workspacePath;
              onOpenTerminal({ path, workspaceName, providerId, workspacePath: effectiveCwd, cliTool: "claude", resumeId });
            }}
            onClearHistory={clearHistory}
            onDeleteRecord={deleteRecord}
          />
        </div>
      </div>
    </div>
  );
}
