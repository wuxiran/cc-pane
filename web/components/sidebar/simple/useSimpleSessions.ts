// 简洁模式的数据源：终端启动记录 + Agent 对话历史，各自监听更新事件重拉。
// 做法搬自 SessionsView / AgentChatSessionsView，两份列表在这里合成一种会话。
import { useCallback, useEffect, useMemo, useState } from "react";
import type { LaunchRecord } from "@/services/historyService";
import { historyService } from "@/services/historyService";
import { agentChatService } from "@/services/agentChatService";
import { AGENT_CHAT_HISTORY_CHANGED_EVENT } from "@/stores/agentChatEvents";
import type { AcpChatHistoryEntry } from "@/types/agentChat";
import { handleErrorSilent } from "@/utils/errorHandler";
import { mergeSessions, type SimpleSession } from "./simpleExplorerModel";

export const HISTORY_UPDATED_EVENT = "cc-panes:history-updated";
const HISTORY_LIMIT = 30;

export function useSimpleSessions(): { sessions: SimpleSession[]; loaded: boolean } {
  const [records, setRecords] = useState<LaunchRecord[]>([]);
  const [entries, setEntries] = useState<AcpChatHistoryEntry[]>([]);
  const [loaded, setLoaded] = useState(false);

  const fetchHistory = useCallback(async () => {
    try {
      setRecords(await historyService.list(HISTORY_LIMIT));
    } catch (error) {
      handleErrorSilent(error, "fetch history");
    } finally {
      setLoaded(true);
    }
  }, []);

  const fetchChats = useCallback(async () => {
    try {
      setEntries(await agentChatService.listHistory());
    } catch (error) {
      handleErrorSilent(error, "list acp chat history");
    }
  }, []);

  useEffect(() => {
    void fetchHistory();
    void fetchChats();
    const onHistory = () => void fetchHistory();
    const onChats = () => void fetchChats();
    const onFocus = () => {
      void fetchHistory();
      void fetchChats();
    };
    window.addEventListener(HISTORY_UPDATED_EVENT, onHistory);
    window.addEventListener(AGENT_CHAT_HISTORY_CHANGED_EVENT, onChats);
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener(HISTORY_UPDATED_EVENT, onHistory);
      window.removeEventListener(AGENT_CHAT_HISTORY_CHANGED_EVENT, onChats);
      window.removeEventListener("focus", onFocus);
    };
  }, [fetchHistory, fetchChats]);

  const sessions = useMemo(() => mergeSessions(records, entries), [records, entries]);
  return { sessions, loaded };
}
