import { create } from "zustand";

interface BrowserWebviewOverlayState {
  blockers: Set<string>;
  setBlocked: (sourceId: string, blocked: boolean) => void;
}

export const useBrowserWebviewOverlayStore = create<BrowserWebviewOverlayState>((set) => ({
  blockers: new Set(),
  setBlocked: (sourceId, blocked) => {
    set((state) => {
      const alreadyBlocked = state.blockers.has(sourceId);
      if (alreadyBlocked === blocked) return state;

      const blockers = new Set(state.blockers);
      if (blocked) blockers.add(sourceId);
      else blockers.delete(sourceId);
      return { blockers };
    });
  },
}));
