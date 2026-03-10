/**
 * Self-Chat 会话生命周期状态管理
 */
import { create } from "zustand";
import type { SelfChatSession, SelfChatStatus } from "@/types";

interface SelfChatState {
  activeSession: SelfChatSession | null;

  startSession: (appCwd: string, systemPrompt: string | null) => string;
  updatePtySessionId: (id: string, ptySessionId: string) => void;
  setStatus: (id: string, status: SelfChatStatus) => void;
  endSession: (id: string) => void;
}

export const useSelfChatStore = create<SelfChatState>((set, get) => ({
  activeSession: null,

  startSession: (appCwd, systemPrompt) => {
    const id = crypto.randomUUID();
    const session: SelfChatSession = {
      id,
      appCwd,
      ptySessionId: null,
      status: "initializing",
      systemPrompt,
    };
    set({ activeSession: session });
    return id;
  },

  updatePtySessionId: (id, ptySessionId) => {
    const s = get().activeSession;
    if (s?.id === id) {
      set({ activeSession: { ...s, ptySessionId } });
    }
  },

  setStatus: (id, status) => {
    const s = get().activeSession;
    if (s?.id === id) {
      set({ activeSession: { ...s, status } });
    }
  },

  endSession: (id) => {
    const s = get().activeSession;
    if (s?.id === id) {
      set({ activeSession: null });
    }
  },
}));
