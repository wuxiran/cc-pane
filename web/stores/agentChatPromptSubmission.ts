import type { AcpChatPhase, AcpContentBlock, AgentChatAttachment, AgentChatItem } from "@/types/agentChat";
import type { AgentChatSessionState } from "./useAgentChatStore";

export interface SubmittedChatPrompt {
  text: string;
  attachments?: AgentChatAttachment[];
  promptBlocks: AcpContentBlock[];
}
export interface PromptSubmissionState {
  pendingPrompt: { token: number; itemId: string; prompt: SubmittedChatPrompt; phaseObserved: boolean } | null;
  /** 被 IPC 拒绝的原始请求独立保存；不冒充已发送消息，也不覆盖用户后来编辑的草稿。 */
  rejectedPrompt: SubmittedChatPrompt | null;
}
export interface PromptSubmissionActions {
  beginPrompt: (chatId: string, prompt: SubmittedChatPrompt, setupToken?: number) => number | null;
  finishPrompt: (chatId: string, token: number, error?: string) => void;
}
type PromptStore = { chats: Record<string, AgentChatSessionState> };
type SetState = (update: (state: PromptStore) => void) => void;
let promptSeq = 0;
export const emptyPromptSubmission = (): PromptSubmissionState => ({ pendingPrompt: null, rejectedPrompt: null });
export function observePromptPhase(chat: AgentChatSessionState, phase: AcpChatPhase | "turn_ended"): void {
  if (chat.pendingPrompt && phase !== "ready") chat.pendingPrompt.phaseObserved = true;
}

export function createPromptSubmissionActions(
  set: SetState,
  ensure: (state: PromptStore, chatId: string) => AgentChatSessionState,
  pushItem: (chat: AgentChatSessionState, item: AgentChatItem) => void,
  nextItemId: () => string,
): PromptSubmissionActions {
  return {
    beginPrompt(chatId, prompt, setupToken) {
      let token: number | null = null;
      set((state) => {
        const chat = ensure(state, chatId);
        const setupOwned = setupToken !== undefined && chat.setup?.pending && chat.setup.token === setupToken;
        if (chat.pendingPrompt || ((chat.setup?.pending || chat.setup?.error) && !setupOwned)
          || (chat.snapshot && chat.snapshot.phase !== "ready") || prompt.promptBlocks.length === 0) return;
        token = ++promptSeq;
        const itemId = nextItemId();
        chat.pendingPrompt = { token, itemId, prompt, phaseObserved: false };
        const labels = prompt.attachments?.map((attachment) => attachment.name) ?? [];
        pushItem(chat, {
          type: "user", id: itemId, at: Date.now(), text: prompt.text, promptBlocks: prompt.promptBlocks,
          ...(labels.length ? { attachments: prompt.attachments, attachmentLabels: labels } : {}),
        });
      });
      return token;
    },
    finishPrompt(chatId, token, error) {
      set((state) => {
        const chat = state.chats[chatId];
        const pending = chat?.pendingPrompt;
        if (!chat || pending?.token !== token) return;
        if (error !== undefined) {
          chat.items = chat.items.filter((item) => item.id !== pending.itemId);
          chat.rejectedPrompt = pending.prompt;
          pushItem(chat, { type: "notice", id: nextItemId(), at: Date.now(), text: error });
        } else {
          chat.rejectedPrompt = null;
          // IPC 成功表示后端已接收。即使 generating 事件还没到，也不能重新开放提交。
          // 已观察到完整快回合时则保留后端最终 ready，不能把它错误地改回 generating。
          if (!pending.phaseObserved && chat.snapshot?.phase === "ready") chat.snapshot.phase = "generating";
        }
        chat.pendingPrompt = null;
      });
    },
  };
}
