// 侧栏会话卡的 Agent 对话数据源：chat store（只读订阅）+ chat 历史（list_acp_chat_history）。
// 订阅用「摘要序列化成字符串」做选择器：流式输出每块都会改 chat store，但摘要
// （标题/首条消息/状态/30s 取整的时间）不变时字符串相等，侧栏树不重渲。
import { useEffect, useMemo, useState } from "react";
import { agentChatService } from "@/services/agentChatService";
import { AGENT_CHAT_HISTORY_CHANGED_EVENT } from "@/stores/agentChatEvents";
import { useAgentChatStore } from "@/stores/useAgentChatStore";
import type { AcpChatHistoryEntry } from "@/types/agentChat";
import { handleErrorSilent } from "@/utils";
import { buildAgentChatRowIndex, type AgentChatRowIndex, type AgentChatRowSummary } from "./agentChatRows";

export function useAgentChatRowIndex(
  tabs: readonly { id: string; agentEngineId?: string }[],
): AgentChatRowIndex {
  const [history, setHistory] = useState<AcpChatHistoryEntry[]>([]);
  const hasTabs = tabs.length > 0;
  // 新会话拿到 acpSessionId 后历史里才有它的条目：用 id 集合做依赖补拉一次
  const sessionKey = useAgentChatStore((state) =>
    tabs.map((tab) => state.chats[tab.id]?.snapshot?.acpSessionId ?? "").join("|"),
  );

  useEffect(() => {
    if (!hasTabs) return;
    let cancelled = false;
    const load = () => {
      agentChatService.listHistory()
        .then((entries) => { if (!cancelled) setHistory(Array.isArray(entries) ? entries : []); })
        .catch((error) => handleErrorSilent(error, "useAgentChatRowIndex.listHistory"));
    };
    load();
    window.addEventListener(AGENT_CHAT_HISTORY_CHANGED_EVENT, load);
    return () => {
      cancelled = true;
      window.removeEventListener(AGENT_CHAT_HISTORY_CHANGED_EVENT, load);
    };
  }, [hasTabs, sessionKey]);

  const serialized = useAgentChatStore((state) =>
    hasTabs ? JSON.stringify([...buildAgentChatRowIndex(tabs, state.chats, history)]) : "[]",
  );

  return useMemo(
    () => new Map(JSON.parse(serialized) as [string, AgentChatRowSummary][]),
    [serialized],
  );
}
