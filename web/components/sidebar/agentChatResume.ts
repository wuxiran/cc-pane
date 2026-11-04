// 续接一条历史 Agent 对话：开新 agent-chat 标签并把 resume 意图交给 EnginePicker 领取。
// Agent 会话视图和简洁模式共用，避免两处各写一份 pendingResume 交接。
import { setPendingResume } from "@/components/agentchat/pendingResume";
import { useActivityBarStore, usePanesStore } from "@/stores";
import type { AcpChatHistoryEntry } from "@/types/agentChat";

export function resumeAgentChat(entry: AcpChatHistoryEntry): void {
  const tabId = usePanesStore.getState().openAgentChat(entry.cwd);
  if (tabId) {
    setPendingResume(tabId, {
      engineId: entry.engineId,
      cwd: entry.cwd,
      acpSessionId: entry.acpSessionId,
    });
  }
  useActivityBarStore.getState().setAppViewMode("panes");
}

/** 新开一条 Agent 对话；projectPath 为空时由 openAgentChat 落到常驻 Agent Chat 工作空间 */
export function openNewAgentChat(projectPath?: string): void {
  usePanesStore.getState().openAgentChat(projectPath || undefined);
  useActivityBarStore.getState().setAppViewMode("panes");
}
