import { create } from "zustand";
import { registerSessionScopedResource } from "@/lib/tabLifecycle/sessionScopedResources";
import { usageStatsService } from "@/services/usageStatsService";
import type { SessionCostSnapshot } from "@/types/sessionCost";

/** 与 useContextUsageStore 同一条理由：reclaim 类 kill 保留标签，不能只靠退出事件回收。 */
export const MAX_SESSION_COST_ENTRIES = 64;

export interface SessionCostEntry {
  snapshot: SessionCostSnapshot | null;
  loading: boolean;
  requestId: number;
}

interface SessionCostState {
  sessions: Map<string, SessionCostEntry>;
  loadSession: (sessionId: string) => Promise<void>;
  dropSession: (sessionId: string) => void;
}

// Monotonic across drop/recreate: an old in-flight response must never match a new request.
let nextRequestId = 0;

/**
 * 费用是累计值，读取偶尔失败时上一次的数仍然有效，不值得闪一下。
 * 但 /clear、resume 换了 agent 会话时必须清零（status 是 waiting，不会走到这里）。
 */
function nextSnapshot(
  previous: SessionCostSnapshot | null,
  incoming: SessionCostSnapshot | null,
): SessionCostSnapshot | null {
  const isTransientFailure = incoming === null
    || (incoming.status === "error" && incoming.diagnosticCode === "SOURCE_UNAVAILABLE");
  if (isTransientFailure && previous?.status === "ready") return previous;
  return incoming;
}

export const useSessionCostStore = create<SessionCostState>((set, get) => ({
  sessions: new Map(),

  dropSession: (sessionId) => {
    set((state) => {
      if (!state.sessions.has(sessionId)) return {};
      const sessions = new Map(state.sessions);
      sessions.delete(sessionId);
      return { sessions };
    });
  },

  loadSession: async (sessionId) => {
    const previous = get().sessions.get(sessionId);
    // 同一会话可能同时显示在多个分屏里，只发一个请求。
    if (previous?.loading) return;
    const requestId = ++nextRequestId;
    set((state) => {
      const sessions = new Map(state.sessions);
      // 重新插入到末尾，淘汰时先淘汰最久没轮询的。
      sessions.delete(sessionId);
      sessions.set(sessionId, { snapshot: previous?.snapshot ?? null, loading: true, requestId });
      for (const key of sessions.keys()) {
        if (sessions.size <= MAX_SESSION_COST_ENTRIES) break;
        sessions.delete(key);
      }
      return { sessions };
    });
    let incoming: SessionCostSnapshot | null = null;
    try {
      incoming = await usageStatsService.querySessionCost(sessionId);
    } catch {
      incoming = null;
    }
    const current = get().sessions.get(sessionId);
    if (current?.requestId !== requestId) return;
    set((state) => ({
      sessions: new Map(state.sessions).set(sessionId, {
        snapshot: nextSnapshot(current.snapshot, incoming),
        loading: false,
        requestId,
      }),
    }));
  },
}));

registerSessionScopedResource({
  name: "sessionCost",
  dispose: (sessionId) => {
    useSessionCostStore.getState().dropSession(sessionId);
  },
});
