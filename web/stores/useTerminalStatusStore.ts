import { create } from "zustand";
import type { UnlistenFn } from "@tauri-apps/api/event";
import type { TerminalStatusType, TerminalStatusInfo } from "@/types";
import { killedSessions, terminalService } from "@/services/terminalService";
import { isTauriRuntime, listenWebviewIfTauri } from "@/services/runtime";

const STATUS_REFRESH_INTERVAL_MS = 15000;

interface TerminalStatusState {
  statusMap: Map<string, TerminalStatusInfo>;
  _unlisten: UnlistenFn | null;
  _idleCheckInterval: ReturnType<typeof setInterval> | null;
  _initialized: boolean;
  getStatus: (sessionId: string | null) => TerminalStatusType | null;
  removeSession: (sessionId: string) => void;
  markSessionLive: (sessionId: string) => void;
  refreshLiveStatuses: () => Promise<void>;
  init: () => Promise<void>;
  cleanup: () => void;
}

export const useTerminalStatusStore = create<TerminalStatusState>((set, get) => ({
  statusMap: new Map(),
  _unlisten: null,
  _idleCheckInterval: null,
  _initialized: false,

  getStatus: (sessionId) => {
    if (!sessionId) return null;
    return get().statusMap.get(sessionId)?.status ?? null;
  },

  removeSession: (sessionId) => {
    set((state) => {
      const newMap = new Map(state.statusMap);
      newMap.delete(sessionId);
      return { statusMap: newMap };
    });
  },

  markSessionLive: (sessionId) => {
    // 后台恢复新建会话后立即把它标记为 live，避免等下一次刷新/事件之前
    // findLiveSavedSessionId 读不到该会话而误判为非 live。
    set((state) => {
      if (state.statusMap.has(sessionId)) return state;
      const newMap = new Map(state.statusMap);
      newMap.set(sessionId, {
        sessionId,
        status: "idle",
        lastOutputAt: Date.now(),
        updatedAt: Date.now(),
      });
      return { statusMap: newMap };
    });
  },

  refreshLiveStatuses: async () => {
    try {
      const statuses = await terminalService.getAllStatus();
      if (!Array.isArray(statuses)) return;
      set({
        statusMap: new Map(
          statuses
            .filter((info) => !killedSessions.has(info.sessionId))
            .map((info) => [info.sessionId, info]),
        ),
      });
    } catch {
      // Best effort only. Live terminal events still update the map.
    }
  },

  init: async () => {
    if (get()._initialized) return;
    set({ _initialized: true });

    await get().refreshLiveStatuses();

    let unlistenFn: UnlistenFn;
    try {
      unlistenFn = await listenWebviewIfTauri<TerminalStatusInfo>("terminal-status", (event) => {
        if (killedSessions.has(event.payload.sessionId)) return;
        const current = get().statusMap.get(event.payload.sessionId);
        if (
          current &&
          current.status === event.payload.status &&
          current.updatedAt === event.payload.updatedAt &&
          current.currentToolName === event.payload.currentToolName &&
          current.currentToolUseId === event.payload.currentToolUseId &&
          current.currentToolSummary === event.payload.currentToolSummary
        ) {
          return;
        }
        set((state) => {
          const newMap = new Map(state.statusMap);
          newMap.set(event.payload.sessionId, event.payload);
          return { statusMap: newMap };
        });
      });
    } catch (error) {
      // internals 未就绪 / 监听注册失败：回滚 _initialized 以便后续可重试，
      // 且不抛出 unhandled rejection（调用方 void init() 收不到错误）。
      console.warn("[terminal-status] failed to subscribe to terminal-status:", error);
      set({ _initialized: false });
      return;
    }
    set({ _unlisten: unlistenFn });

    // Web runtime 没有 Tauri event bridge，用 HTTP 轮询兜底；桌面则事件 + 轮询校正。
    const interval = setInterval(() => {
      const now = Date.now();
      set((state) => {
        let changed = false;
        const newMap = new Map(state.statusMap);
        for (const [sessionId, info] of newMap) {
          if (info.status === "active" && now - info.lastOutputAt > 30000) {
            newMap.set(sessionId, { ...info, status: "idle" });
            changed = true;
          }
        }
        return changed ? { statusMap: newMap } : state;
      });
      void get().refreshLiveStatuses();
    }, isTauriRuntime() ? STATUS_REFRESH_INTERVAL_MS : 3000);
    set({ _idleCheckInterval: interval });
  },

  cleanup: () => {
    const state = get();
    if (state._unlisten) {
      state._unlisten();
    }
    if (state._idleCheckInterval) {
      clearInterval(state._idleCheckInterval);
    }
    set({
      _unlisten: null,
      _idleCheckInterval: null,
      _initialized: false,
    });
  },
}));
