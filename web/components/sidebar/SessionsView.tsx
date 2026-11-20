import { useState, useEffect, useCallback } from "react";
import { Plus, Terminal } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { agentChatService } from "@/services/agentChatService";
import { AGENT_CHAT_HISTORY_CHANGED_EVENT } from "@/stores/agentChatEvents";
import type { AcpChatHistoryEntry } from "@/types/agentChat";
import { openNewAgentChat } from "./agentChatResume";
import type { SessionKindFilter } from "./sessionEntries";
import { useTerminalStatusStore, usePanesStore, useWorkspacesStore } from "@/stores";
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

const FILTERS = [
  { id: "all", labelKey: "sessionFilterAll" },
  { id: "cli", labelKey: "sessionTagCli" },
  { id: "chat", labelKey: "sessionTagChat" },
] as const satisfies ReadonlyArray<{ id: SessionKindFilter; labelKey: string }>;
/** 对话历史最多并进列表这么多条（与原 Agent 会话视图一致）。 */
const MAX_CHATS = 50;

interface SessionsViewProps {
  onOpenTerminal: (opts: OpenTerminalOptions) => void;
}

export default function SessionsView({ onOpenTerminal }: SessionsViewProps) {
  const statusMap = useTerminalStatusStore((s) => s.statusMap);
  const rootPane = usePanesStore((s) => s.rootPane);

  const { t } = useTranslation("sidebar");
  const [filter, setFilter] = useState<SessionKindFilter>("all");
  const [chats, setChats] = useState<AcpChatHistoryEntry[]>([]);
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

  // Agent 对话历史：和 CLI 启动记录并在同一份列表里。
  const reloadChats = useCallback(() => {
    agentChatService
      .listHistory()
      .then((list) => setChats(list.filter((entry) => entry.acpSessionId).slice(0, MAX_CHATS)))
      .catch((error) => handleErrorSilent(error, "list acp chat history"));
  }, []);
  useEffect(() => {
    reloadChats();
    // 切回本视图时靠 focus 兜底；agent 改标题（session_info_update）时即时重拉。
    window.addEventListener("focus", reloadChats);
    window.addEventListener(AGENT_CHAT_HISTORY_CHANGED_EVENT, reloadChats);
    return () => {
      window.removeEventListener("focus", reloadChats);
      window.removeEventListener(AGENT_CHAT_HISTORY_CHANGED_EVENT, reloadChats);
    };
  }, [reloadChats]);

  const openNewChat = () => {
    const ws = useWorkspacesStore.getState();
    const workspace = ws.workspaces.find((w) => w.id === ws.expandedWorkspaceId);
    openNewAgentChat(workspace?.projects.find((project) => project.id === ws.expandedProjectId)?.path);
  };

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
      {/* 视图标题栏：标题 + 新建对话；下面一排筛选（全部 / 终端 / 对话） */}
      <div className="flex shrink-0 items-center gap-1 px-4 pt-2">
        <span className="text-[length:var(--text-caption)] font-medium text-[var(--app-text-secondary)]">
          {t("sessionsTitle")}
        </span>
        <span className="flex-1" />
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={t("newAgentChat")}
              className="rounded p-1 text-[var(--app-icon-inactive)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-icon-active)]"
              onClick={openNewChat}
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t("newAgentChat")}</TooltipContent>
        </Tooltip>
      </div>
      <div className="flex shrink-0 items-center gap-1 px-4 py-2" role="radiogroup" aria-label={t("sessionsTitle")}>
        {FILTERS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="radio"
            aria-checked={filter === item.id}
            className={`rounded-full px-2 py-0.5 text-[length:var(--text-micro)] transition-colors ${
              filter === item.id
                ? "bg-[var(--app-active-bg)] text-[var(--app-text-primary)]"
                : "text-[var(--app-text-tertiary)] hover:bg-[var(--app-hover)]"
            }`}
            onClick={() => setFilter(item.id)}
          >
            {t(item.labelKey)}
          </button>
        ))}
      </div>

      {/* relative：成为 RecentLaunches 列表的 offsetParent，scrollMargin 才能用 offsetTop 对齐 */}
      <div ref={setScrollElement} className="app-scrollbar relative flex-1 overflow-y-auto">
        {/* 活跃会话 */}
        {filter !== "chat" && activeSessions.length > 0 && (
          <div className="px-3 mb-3">
            <span className="text-[length:var(--text-micro)] font-bold uppercase tracking-wider px-1 text-[var(--app-text-tertiary)]">
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
                  <span className="text-[length:var(--text-small)] truncate">{s.title || "Terminal"}</span>
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
              chats={chats}
              filter={filter}
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
