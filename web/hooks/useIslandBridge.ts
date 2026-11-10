// 主窗口 → 灵动岛的事件桥。
//
// 为什么放主窗口而不是后端：岛要的会话名、CLI、窗格位置、ACP 待批队列、额度都只活在
// 主窗口的 store 里（terminal-status 之外的数据后端没有现成的聚合）。桥只订阅这些
// store，变化时按微任务合批推一次快照（不用定时器：主窗口隐藏到托盘时 WebView 的
// 定时器会被节流，事件与微任务不受影响），内容不变就不发。没有任何轮询。
//
// 反向：岛请求快照 / 回应审批走 emitTo("main")；定位会话由后端先唤起主窗口再转发。
import { useEffect } from "react";
import { emitTo } from "@tauri-apps/api/event";
import { IslandSessionTracker } from "@/lib/island/islandSessionTracker";
import { collectChatSources, collectTerminalSources, pickQuota } from "@/lib/island/collectIslandSources";
import { navigateToIslandTarget } from "@/lib/island/islandNavigation";
import { isTauriRuntime, listenIfTauri } from "@/services/runtime";
import { usePanesStore } from "@/stores";
import { respondChatPermission } from "@/stores/agentChatPermissionResponse";
import { useAgentChatStore } from "@/stores/useAgentChatStore";
import { useDockChatStore } from "@/stores/useDockChatStore";
import { useNotificationStore } from "@/stores/useNotificationStore";
import { useSessionCostStore } from "@/stores/useSessionCostStore";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { useTerminalStatusStore } from "@/stores/useTerminalStatusStore";
import {
  ISLAND_NAVIGATE_EVENT,
  ISLAND_REQUEST_STATE_EVENT,
  ISLAND_RESPOND_PERMISSION_EVENT,
  ISLAND_STATE_EVENT,
  ISLAND_WINDOW_LABEL,
  type IslandNavigateTarget,
  type IslandPermissionResponse,
  type IslandSnapshot,
} from "@/types/island";

const SUMMARY_KINDS = new Set(["turn_end", "session_exited"]);
const SUMMARY_WINDOW_MS = 2 * 60_000;

/** 最近的完成类通知正文，按会话取最新一条，作「刚完成」摘要。 */
function recentSummaries(now: number): Map<string, string> {
  const summaries = new Map<string, string>();
  for (const notification of useNotificationStore.getState().notifications) {
    if (!notification.sessionId || !notification.body) continue;
    if (!SUMMARY_KINDS.has(notification.kind) || now - notification.timestamp > SUMMARY_WINDOW_MS) continue;
    if (!summaries.has(notification.sessionId)) summaries.set(notification.sessionId, notification.body);
  }
  return summaries;
}

function chatName(chatId: string): string | null {
  const tab = usePanesStore.getState().findTabAcrossLayouts(chatId)?.tab;
  if (tab?.title) return tab.title;
  return useDockChatStore.getState().chats.find((chat) => chat.id === chatId)?.title || null;
}

export function buildIslandSnapshot(tracker: IslandSessionTracker, now: number): IslandSnapshot {
  const panes = usePanesStore.getState();
  const sources = [
    ...collectTerminalSources(
      useTerminalStatusStore.getState().statusMap,
      (sessionId) => panes.findTabBySessionAcrossLayouts(sessionId),
      recentSummaries(now),
    ),
    ...collectChatSources(useAgentChatStore.getState().chats, chatName),
  ];
  return {
    sessions: tracker.update(sources, now),
    quota: pickQuota(useSessionCostStore.getState().sessions, now),
  };
}

type Emit = (snapshot: IslandSnapshot) => void;

const emitToIsland: Emit = (snapshot) => {
  void emitTo(ISLAND_WINDOW_LABEL, ISLAND_STATE_EVENT, snapshot).catch(() => {});
};

/** 启动事件桥，返回停止函数。导出供测试直接驱动。 */
export function startIslandBridge(emit: Emit = emitToIsland): () => void {
  const tracker = new IslandSessionTracker();
  let disposed = false;
  let scheduled = false;
  let lastPayload = "";

  const publish = (force: boolean) => {
    const snapshot = buildIslandSnapshot(tracker, Date.now());
    const payload = JSON.stringify(snapshot);
    if (!force && payload === lastPayload) return;
    lastPayload = payload;
    emit(snapshot);
  };
  const schedule = () => {
    if (scheduled || disposed) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (!disposed) publish(false);
    });
  };

  const unsubscribers = [
    useTerminalStatusStore.subscribe(schedule),
    useAgentChatStore.subscribe(schedule),
    usePanesStore.subscribe(schedule),
    useSessionCostStore.subscribe(schedule),
    useNotificationStore.subscribe(schedule),
    useDockChatStore.subscribe(schedule),
  ];
  const listeners = [
    listenIfTauri(ISLAND_REQUEST_STATE_EVENT, () => publish(true)),
    listenIfTauri<IslandPermissionResponse>(ISLAND_RESPOND_PERMISSION_EVENT, ({ payload }) => {
      if (!payload?.chatId || !payload.requestKey) return;
      void respondChatPermission(payload.chatId, payload.requestKey, payload.optionId ?? null);
    }),
    listenIfTauri<IslandNavigateTarget>(ISLAND_NAVIGATE_EVENT, ({ payload }) => {
      if (!payload?.id) return;
      tracker.dismiss(payload.id);
      void navigateToIslandTarget(payload).finally(schedule);
    }),
  ];
  publish(true);

  return () => {
    disposed = true;
    for (const unsubscribe of unsubscribers) unsubscribe();
    for (const pending of listeners) void pending.then((unlisten) => unlisten()).catch(() => {});
  };
}

/** App 级挂载一次；只在设置里开启灵动岛时运行。 */
export function useIslandBridge(): void {
  const enabled = useSettingsStore((state) => state.settings?.island?.enabled === true);
  useEffect(() => {
    if (!enabled || !isTauriRuntime()) return undefined;
    return startIslandBridge();
  }, [enabled]);
}
