import type { AcpElicitationDraft, AcpElicitationRequest } from "@/types/agentChat";
import type { AgentChatSessionState } from "./useAgentChatStore";

export interface PendingChatElicitation extends AcpElicitationRequest {
  responding: boolean;
  error: string | null;
  values: AcpElicitationDraft;
}

export interface ElicitationState {
  pendingElicitations: PendingChatElicitation[];
}

export interface ElicitationActions {
  enqueueElicitation: (chatId: string, request: AcpElicitationRequest) => void;
  setElicitationValues: (chatId: string, requestKey: string, values: AcpElicitationDraft) => void;
  beginElicitationResponse: (chatId: string, requestKey: string) => boolean;
  finishElicitationResponse: (chatId: string, requestKey: string, error?: string) => void;
}

type ElicitationStore = { chats: Record<string, AgentChatSessionState> };
type SetState = (update: (state: ElicitationStore) => void) => void;

/** Keep question drafts and response admission independent of transcript rendering. */
export function createElicitationActions(
  set: SetState,
  ensure: (state: ElicitationStore, chatId: string) => AgentChatSessionState,
): ElicitationActions {
  return {
    enqueueElicitation: (chatId, request) => set((state) => {
      const chat = ensure(state, chatId);
      if (!chat.pendingElicitations.some((item) => item.requestKey === request.requestKey)) {
        chat.pendingElicitations.push({ ...request, responding: false, error: null, values: {} });
      }
    }),

    setElicitationValues: (chatId, requestKey, values) => set((state) => {
      const request = state.chats[chatId]?.pendingElicitations.find((item) => item.requestKey === requestKey);
      if (request && !request.responding) request.values = values;
    }),

    beginElicitationResponse: (chatId, requestKey) => {
      let started = false;
      set((state) => {
        const request = state.chats[chatId]?.pendingElicitations.find((item) => item.requestKey === requestKey);
        if (!request || request.responding) return;
        request.responding = true;
        request.error = null;
        started = true;
      });
      return started;
    },

    finishElicitationResponse: (chatId, requestKey, error) => set((state) => {
      const chat = state.chats[chatId];
      if (!chat) return;
      const request = chat.pendingElicitations.find((item) => item.requestKey === requestKey);
      if (!request) return;
      if (error !== undefined) {
        request.responding = false;
        request.error = error;
      } else chat.pendingElicitations = chat.pendingElicitations.filter((item) => item.requestKey !== requestKey);
    }),
  };
}
