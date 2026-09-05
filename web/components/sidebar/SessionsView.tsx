import { useState, useEffect, useCallback } from "react";
import { Terminal } from "lucide-react";
import { useTerminalStatusStore, usePanesStore } from "@/stores";
import { historyService, type LaunchRecord } from "@/services";
import RecentLaunches from "@/components/sidebar/RecentLaunches";
import { Skeleton } from "@/components/ui/skeleton";
import { useDelayedLoading } from "@/hooks/useDelayedLoading";
import { focusTab } from "@/hooks/useFocusTab";
import { asTabId } from "@/types/ids";
import { handleErrorSilent } from "@/utils";
import { isBusyStatus } from "@/types";

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
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const showHistorySkeleton = useDelayedLoading(!historyLoaded);
  // 滚动容器：RecentLaunches 的虚拟化以它为视口。
  // 用 callback ref + state 而非 useRef——子组件 layout effect 早于父级 ref 挂载，
  // state 交接能保证元素就绪后触发重渲染，虚拟化器才能订阅到滚动容器。
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);

  const fetchHistory = useCallback(async () => {
    try {
      const list = await historyService.list(30);
      setLaunchHistory(list);
    } catch (e) {
      handleErrorSilent(e, "fetch history");
    } finally {
      setHistoryLoaded(true);
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

      {/* relative：成为 RecentLaunches 列表的 offsetParent，scrollMargin 才能用 offsetTop 对齐 */}
      <div ref={setScrollElement} className="app-scrollbar relative flex-1 overflow-y-auto">
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
                  className="w-full flex items-center gap-[var(--density-gap)] px-[var(--density-pad-x)] py-[var(--density-pad-y)] rounded-lg transition-colors text-left hover:bg-[var(--app-hover)] text-[var(--app-text-secondary)]"
                  onClick={() => focusTab(asTabId(s.tabId))}
                >
                  <div className="relative shrink-0">
                    <Terminal className="w-3.5 h-3.5" />
                    <div className={`absolute -bottom-0.5 -right-0.5 w-1.5 h-1.5 rounded-full ${
                      isBusyStatus(s.status) ? "bg-[var(--app-status-success)]" : "bg-[var(--app-text-tertiary)]"
                    }`} />
                  </div>
                  <span className="text-[12px] truncate">{s.title || "Terminal"}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* 最近启动历史：加载超过 300ms 才显示骨架，避免快加载闪空态 */}
        <div className="px-3 pb-4">
          {historyLoaded ? (
            <RecentLaunches
              launchHistory={launchHistory}
              onOpenTerminal={onOpenTerminal}
              onClearHistory={clearHistory}
              onDeleteRecord={deleteRecord}
              scrollElement={scrollElement}
            />
          ) : showHistorySkeleton ? (
            <RecentLaunchesSkeleton />
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** 启动历史骨架：组标题 + 会话行，尺寸贴近 RecentLaunches 真实布局 */
function RecentLaunchesSkeleton() {
  return (
    <div aria-busy="true" aria-hidden="true" data-testid="recent-launches-skeleton">
      <div className="flex items-center justify-between px-3 py-3 mt-4 mb-1">
        <Skeleton className="h-3 w-24" />
      </div>
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="flex items-center justify-between px-3 pl-7 py-2 mb-0.5">
          <div className="flex items-center gap-2">
            <Skeleton className="size-3.5 shrink-0 rounded-full" />
            <div className="space-y-1">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-2.5 w-16" />
            </div>
          </div>
          <Skeleton className="h-2.5 w-10 shrink-0" />
        </div>
      ))}
    </div>
  );
}
