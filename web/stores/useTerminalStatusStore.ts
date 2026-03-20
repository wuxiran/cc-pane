import { create } from "zustand";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { TerminalStatusType, TerminalStatusInfo } from "@/types";
import { killedSessions } from "@/services/terminalService";

interface TerminalStatusState {
  statusMap: Map<string, TerminalStatusInfo>;
  _unlisten: UnlistenFn | null;
  _idleCheckInterval: ReturnType<typeof setInterval> | null;
  _initialized: boolean;
  getStatus: (sessionId: string | null) => TerminalStatusType | null;
  removeSession: (sessionId: string) => void;
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

  init: async () => {
    if (get()._initialized) return;
    set({ _initialized: true });

    const unlistenFn = await getCurrentWebview().listen<TerminalStatusInfo>("terminal-status", (event) => {
      if (killedSessions.has(event.payload.sessionId)) return;
      const current = get().statusMap.get(event.payload.sessionId);
      if (current && current.status === event.payload.status) return;
      set((state) => {
        const newMap = new Map(state.statusMap);
        newMap.set(event.payload.sessionId, event.payload);
        return { statusMap: newMap };
      });
    });
    set({ _unlisten: unlistenFn });

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
    }, 5000);
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
