import { create } from "zustand";
import { usageStatsService } from "@/services/usageStatsService";
import type { ContextUsageSnapshot } from "@/types/contextUsage";

interface ContextUsageState {
  sessionId: string | null;
  snapshot: ContextUsageSnapshot | null;
  lastReady: ContextUsageSnapshot | null;
  loading: boolean;
  requestId: number;
  sessions: Map<string, ContextUsageEntry>;
  setSession: (sessionId: string | null) => void;
  load: (sessionId: string) => Promise<void>;
  loadSession: (sessionId: string) => Promise<void>;
}

export interface ContextUsageEntry {
  snapshot: ContextUsageSnapshot | null;
  lastReady: ContextUsageSnapshot | null;
  loading: boolean;
  requestId: number;
}

function emptyEntry(): ContextUsageEntry {
  return {
    snapshot: null,
    lastReady: null,
    loading: false,
    requestId: 0,
  };
}

function errorSnapshot(): ContextUsageSnapshot {
  return {
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
  };
}

export const useContextUsageStore = create<ContextUsageState>((set, get) => ({
  sessionId: null,
  snapshot: null,
  lastReady: null,
  loading: false,
  requestId: 0,
  sessions: new Map(),

  setSession: (sessionId) => {
    if (get().sessionId === sessionId) return;
    const entry = sessionId ? get().sessions.get(sessionId) : undefined;
    set({
      sessionId,
      snapshot: entry?.snapshot ?? null,
      lastReady: entry?.lastReady ?? null,
      loading: entry?.loading ?? false,
      requestId: entry?.requestId ?? 0,
    });
  },

  load: async (sessionId) => {
    get().setSession(sessionId);
    await get().loadSession(sessionId);
  },

  loadSession: async (sessionId) => {
    // Grid layouts can render the same session in more than one status surface.
    // Cache and de-duplicate requests per PTY instead of letting the active
    // terminal overwrite every other terminal's usage snapshot.
    const previous = get().sessions.get(sessionId) ?? emptyEntry();
    if (previous.loading) return;
    const requestId = previous.requestId + 1;
    set((state) => {
      const sessions = new Map(state.sessions);
      sessions.set(sessionId, { ...previous, loading: true, requestId });
      return state.sessionId === sessionId
        ? { sessions, loading: true, requestId }
        : { sessions };
    });
    try {
      const snapshot = await usageStatsService.queryContextUsage(sessionId);
      const current = get().sessions.get(sessionId);
      if (current?.requestId !== requestId) return;
      set((state) => ({
        sessions: new Map(state.sessions).set(sessionId, {
          snapshot,
          lastReady: snapshot.status === "ready" ? snapshot : current.lastReady,
          loading: false,
          requestId,
        }),
        ...(state.sessionId === sessionId
          ? {
              snapshot,
              lastReady: snapshot.status === "ready" ? snapshot : current.lastReady,
              loading: false,
              requestId,
            }
          : {}),
      }));
    } catch {
      const current = get().sessions.get(sessionId);
      if (current?.requestId !== requestId) return;
      const snapshot = errorSnapshot();
      set((state) => {
        const sessions = new Map(state.sessions);
        sessions.set(sessionId, {
          snapshot,
          lastReady: current.lastReady,
          loading: false,
          requestId,
        });
        return state.sessionId === sessionId
          ? {
              sessions,
              snapshot,
              lastReady: current.lastReady,
              loading: false,
              requestId,
            }
          : { sessions };
      });
    }
  },
}));
