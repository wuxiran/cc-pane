import { create } from "zustand";

interface VoiceInputState {
  activeTargetId: string | null;
  toggleRequest: { targetId: string; seq: number } | null;
  setActiveTarget: (targetId: string) => void;
  clearActiveTarget: (targetId?: string) => void;
  requestToggle: (targetId: string) => void;
}

export const useVoiceInputStore = create<VoiceInputState>((set, get) => ({
  activeTargetId: null,
  toggleRequest: null,
  setActiveTarget: (targetId) => set({ activeTargetId: targetId }),
  clearActiveTarget: (targetId) => {
    if (targetId && get().activeTargetId !== targetId) return;
    set({ activeTargetId: null });
  },
  requestToggle: (targetId) => {
    set((state) => ({
      toggleRequest: {
        targetId,
        seq: (state.toggleRequest?.seq ?? 0) + 1,
      },
    }));
  },
}));
