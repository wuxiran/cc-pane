// 侧栏会话卡里 Agent 对话（ACP chat）标签的数据派生：把 chat store 的会话态 +
// chat 历史（list_acp_chat_history）压成卡片要的最小摘要。纯函数，只读不写 chat store。
import type { AgentChatSessionState } from "@/stores/useAgentChatStore";
import { chatEngineTrail } from "@/stores/useAgentChatStoreHandoff";
import type { AcpChatHistoryEntry } from "@/types/agentChat";
import type { TerminalStatusType } from "@/types";
import { engineSequence, normalizeEpochMs } from "./sessionCardModel";

/** 一个 chat 标签在侧栏卡片上需要的全部信息（key = tabId = chatId）。 */
export interface AgentChatRowSummary {
  /** 用过的引擎序列（最近的在后）：历史条目的 engines（上下文交接时追加）+ 标签内实时轨迹。 */
  engines: string[];
  /** chat 历史里的标题（agent 起的 / 用户改的） */
  title: string | null;
  /** 第一条用户消息 */
  firstPrompt: string | null;
  status: TerminalStatusType | null;
  lastActivityAt: number | null;
}

export type AgentChatRowIndex = ReadonlyMap<string, AgentChatRowSummary>;

/** chat 阶段 + 待处理请求 → 终端同款状态，复用 statusPresentation 的形状/颜色。 */
export function chatStatus(chat: AgentChatSessionState | undefined): TerminalStatusType | null {
  const snapshot = chat?.snapshot;
  if (!snapshot) return null;
  if (snapshot.phase === "failed") return "error";
  if (snapshot.phase === "exited") return "exited";
  if (snapshot.phase === "starting") return "initializing";
  if ((chat.pendingPermissions?.length ?? 0) > 0 || (chat.pendingElicitations?.length ?? 0) > 0) {
    return "waitingInput";
  }
  if (snapshot.phase === "generating" || chat.pendingPrompt) return "thinking";
  return "idle";
}

/**
 * 历史条目的引擎序列。另一条线正在给历史条目加「用过的引擎序列」字段；
 * 字段名定下来之前只认 engineId，接入点就在这里（返回值已是数组）。
 */
export function chatHistoryEngines(entry: AcpChatHistoryEntry | undefined): string[] {
  // 旧 meta 没有 engines 字段，按单个 engineId 处理。
  return engineSequence(entry?.engines?.length ? entry.engines : [entry?.engineId]);
}

function firstUserText(chat: AgentChatSessionState | undefined): string | null {
  for (const item of chat?.items ?? []) {
    if (item.type === "user" && item.text.trim()) return item.text;
  }
  return null;
}

function lastItemAt(chat: AgentChatSessionState | undefined): number | null {
  const items = chat?.items ?? [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const at = (items[index] as { at?: number }).at;
    if (typeof at === "number" && at > 0) return at;
  }
  return null;
}

/** 流式输出期间 at 每块都在变：按 30s 取整，避免整棵侧栏树随 token 重渲。 */
const ACTIVITY_BUCKET_MS = 30_000;

export function summarizeAgentChat(
  tabEngineId: string | undefined,
  chat: AgentChatSessionState | undefined,
  history: AcpChatHistoryEntry | undefined,
): AgentChatRowSummary {
  const lastAt = lastItemAt(chat) ?? normalizeEpochMs(history?.updatedAt);
  return {
    engines: engineSequence([
      ...chatHistoryEngines(history),
      // 标签内的交接轨迹比落盘的历史更新（切换引擎后历史 meta 要等下次保存才追上）
      ...chatEngineTrail(chat),
      chat?.snapshot?.engineId ?? (history ? null : tabEngineId),
    ]),
    title: history?.title?.trim() || null,
    firstPrompt: firstUserText(chat),
    status: chatStatus(chat),
    lastActivityAt: lastAt == null ? null : Math.floor(lastAt / ACTIVITY_BUCKET_MS) * ACTIVITY_BUCKET_MS,
  };
}

/** chat 标签 → 摘要。chats 来自 chat store（key = tabId），history 按 acpSessionId 关联。 */
export function buildAgentChatRowIndex(
  tabs: readonly { id: string; agentEngineId?: string }[],
  chats: Readonly<Record<string, AgentChatSessionState>>,
  history: readonly AcpChatHistoryEntry[],
): Map<string, AgentChatRowSummary> {
  const byAcpSession = new Map(history.map((entry) => [entry.acpSessionId, entry]));
  const index = new Map<string, AgentChatRowSummary>();
  for (const tab of tabs) {
    const chat = chats[tab.id];
    const acpSessionId = chat?.snapshot?.acpSessionId ?? chat?.transcriptSessionId ?? undefined;
    index.set(tab.id, summarizeAgentChat(tab.agentEngineId, chat, acpSessionId ? byAcpSession.get(acpSessionId) : undefined));
  }
  return index;
}
