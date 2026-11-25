// 换引擎「上下文交接」的 store 切片（从 useAgentChatStore 拆出，行数棘轮）。
//
// 同一 chatId 上用新引擎重开会话时，前端 store 里的旧条目不会被清空：新会话
// ready 时 setSnapshot 只把 transcriptStart 推到末尾，旧条目自然成为只读前缀。
// 这里负责把交接分隔线插在前缀与新会话的边界上，并保存一份待发送的交接上下文：
// 切换后用户发出的第一条消息把它作为前置 text block 发给新引擎，成功后清除。
import type { AgentChatItem } from "@/types/agentChat";
import type { AgentChatSessionState } from "./useAgentChatStore";

export type HandoffNotice = Extract<AgentChatItem, { type: "notice" }> & {
  handoff: NonNullable<Extract<AgentChatItem, { type: "notice" }>["handoff"]>;
};

export interface PendingHandoffContext {
  /** 与分隔线 id 相同，用于只清除自己那一次交接。 */
  id: string;
  text: string;
}

export interface HandoffState {
  /** 待随下一条用户消息发出的交接上下文；null = 无。 */
  pendingHandoff: PendingHandoffContext | null;
  /** 本标签内记录的引擎序列（只在发生过交接时非空，见 chatEngineTrail）。 */
  engineTrail: string[];
}

export interface HandoffActions {
  recordHandoff: (chatId: string, handoff: { notice: HandoffNotice; context: string | null; engineTrail: string[] }) => void;
  clearPendingHandoff: (chatId: string, id: string) => void;
}

type HandoffStore = { chats: Record<string, AgentChatSessionState> };
type SetState = (update: (state: HandoffStore) => void) => void;

export const emptyHandoff = (): HandoffState => ({ pendingHandoff: null, engineTrail: [] });

export function createHandoffActions(
  set: SetState,
  ensure: (state: HandoffStore, chatId: string) => AgentChatSessionState,
): HandoffActions {
  return {
    recordHandoff(chatId, { notice, context, engineTrail }) {
      set((state) => {
        const chat = ensure(state, chatId);
        if (chat.items.some((item) => item.id === notice.id)) return;
        // 分隔线放进只读前缀的末尾：新会话正文（若已有）仍在其后。
        const at = Math.min(chat.transcriptStart, chat.items.length);
        chat.items.splice(at, 0, notice);
        chat.transcriptStart = at + 1;
        chat.pendingHandoff = context ? { id: notice.id, text: context } : null;
        chat.engineTrail = engineTrail;
      });
    },
    clearPendingHandoff(chatId, id) {
      set((state) => {
        const chat = state.chats[chatId];
        if (chat?.pendingHandoff?.id === id) chat.pendingHandoff = null;
      });
    },
  };
}

/** 本对话用过的引擎序列：标签内记录优先，其次从（恢复出的）交接分隔线推出，最后退回当前引擎。 */
export function chatEngineTrail(chat: Pick<AgentChatSessionState, "engineTrail" | "items" | "snapshot"> | undefined): string[] {
  if (!chat) return [];
  if (chat.engineTrail.length > 0) return chat.engineTrail;
  const trail: string[] = [];
  const push = (engineId?: string) => {
    if (engineId && trail[trail.length - 1] !== engineId) trail.push(engineId);
  };
  for (const item of chat.items) {
    if (item.type !== "notice" || !item.handoff) continue;
    push(item.handoff.fromEngineId);
    push(item.handoff.toEngineId);
  }
  if (chat.snapshot?.engineId) push(chat.snapshot.engineId);
  return trail;
}
