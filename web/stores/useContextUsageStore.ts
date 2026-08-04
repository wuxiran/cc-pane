import { create } from "zustand";
import { usageStatsService } from "@/services/usageStatsService";
import type { ContextUsageSnapshot } from "@/types/contextUsage";

interface ContextUsageState {
  sessionId: string | null;
  snapshot: ContextUsageSnapshot | null;
  lastReady: ContextUsageSnapshot | null;
  loading: boolean;
  requestId: number;
  setSession: (sessionId: string | null) => void;
  load: (sessionId: string) => Promise<void>;
}

export const useContextUsageStore = create<ContextUsageState>((set, get) => ({
  sessionId: null,
  snapshot: null,
  lastReady: null,
  loading: false,
  requestId: 0,

  setSession: (sessionId) => {
    if (get().sessionId === sessionId) return;
    set({ sessionId, snapshot: null, lastReady: null, loading: false });
  },

  load: async (sessionId) => {
    // A slow filesystem/WSL read must not be superseded by the next interval tick.
    // Keeping one in-flight request also avoids the backend's duplicate-read guard
    // turning a successful first response into a transient error.
    if (get().sessionId === sessionId && get().loading) return;
    const requestId = get().requestId + 1;
    set({ sessionId, loading: true, requestId });
    try {
      const snapshot = await usageStatsService.queryContextUsage(sessionId);
      if (get().requestId !== requestId || get().sessionId !== sessionId) return;
      set((state) => ({
        snapshot,
        lastReady: snapshot.status === "ready" ? snapshot : state.lastReady,
        loading: false,
      }));
    } catch {
      if (get().requestId !== requestId || get().sessionId !== sessionId) return;
      set({
        snapshot: {
          status: "error",
          usedTokens: null,
          effectiveUsedTokens: null,
          windowTokens: null,
          effectiveWindowTokens: null,
          usedPercentage: null,
          remainingPercentage: null,
          model: null,
          usageSource: null,
          windowSource: null,
          agentSessionId: null,
          parserVersion: null,
          observedAt: Date.now(),
          diagnosticCode: "SOURCE_UNAVAILABLE",
        },
        loading: false,
      });
    }
  },
}));
