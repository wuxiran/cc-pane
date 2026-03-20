/**
 * Self-Chat 会话生命周期状态管理
 */
import { create } from "zustand";
import type { SelfChatSession, SelfChatStatus } from "@/types";

interface SelfChatState {
  activeSession: SelfChatSession | null;
  /** 当前 SelfChat 会话是否为 onboarding 模式 */
  isOnboarding: boolean;

  startSession: (appCwd: string, systemPrompt: string | null) => string;
  updatePtySessionId: (id: string, ptySessionId: string) => void;
  setStatus: (id: string, status: SelfChatStatus) => void;
  endSession: (id: string) => void;
  setOnboarding: (value: boolean) => void;
}

export const useSelfChatStore = create<SelfChatState>((set, get) => ({
  activeSession: null,
  isOnboarding: false,

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
      set({ activeSession: null, isOnboarding: false });
    }
  },

  setOnboarding: (value) => set({ isOnboarding: value }),
}));
