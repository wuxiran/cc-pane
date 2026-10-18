import { create } from "zustand";
import type { AgentChatAttachment } from "@/types/agentChat";

interface ChatDraft { text: string; attachments: AgentChatAttachment[]; sentHistory: string[]; }
interface ChatDraftStore {
  drafts: Record<string, ChatDraft>;
  setText: (chatId: string, token: number, text: string) => void;
  appendText: (chatId: string, token: number, text: string) => void;
  addAttachments: (chatId: string, token: number, attachments: AgentChatAttachment[]) => void;
  clearAttachments: (chatId: string, token: number) => void;
  removeAttachment: (chatId: string, token: number, index: number) => void;
  rememberSent: (chatId: string, token: number, text: string) => void;
}
const generations = new Map<string, number>();
let sequence = 0;
export const EMPTY_CHAT_ATTACHMENTS: AgentChatAttachment[] = [];
/** 重挂载沿用同一草稿；只有显式关闭使令牌失效，旧异步回调不能复活它。 */
export function acquireChatDraft(chatId: string): number {
  const existing = generations.get(chatId);
  if (existing !== undefined) return existing;
  const token = ++sequence;
  generations.set(chatId, token);
  return token;
}
export const isChatDraftCurrent = (chatId: string, token: number): boolean => generations.get(chatId) === token;
export const useAgentChatDraftStore = create<ChatDraftStore>((set) => {
  const update = (chatId: string, token: number, change: (draft: ChatDraft) => ChatDraft) => {
    if (!isChatDraftCurrent(chatId, token)) return;
    set((state) => ({ drafts: {
      ...state.drafts,
      [chatId]: change(state.drafts[chatId] ?? { text: "", attachments: [], sentHistory: [] }),
    } }));
  };
  return {
    drafts: {},
    setText: (id, token, text) => update(id, token, (draft) => ({ ...draft, text })),
    appendText: (id, token, text) => update(id, token, (draft) => ({ ...draft, text: draft.text ? `${draft.text} ${text}` : text })),
    addAttachments: (id, token, attachments) => update(id, token, (draft) => ({ ...draft, attachments: [...draft.attachments, ...attachments] })),
    clearAttachments: (id, token) => update(id, token, (draft) => ({ ...draft, attachments: [] })),
    removeAttachment: (id, token, index) => update(id, token, (draft) => ({ ...draft, attachments: draft.attachments.filter((_, position) => position !== index) })),
    rememberSent: (id, token, text) => update(id, token, (draft) => ({ ...draft, sentHistory: [...draft.sentHistory, text].slice(-50) })),
  };
});
export function dropAgentChatDraft(chatId: string): void {
  generations.delete(chatId);
  useAgentChatDraftStore.setState((state) => {
    const drafts = { ...state.drafts };
    delete drafts[chatId];
    return { drafts };
  });
}
