import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { TerminalStatusType, TerminalStatusInfo } from "@/types";
import { killedSessions } from "@/services/terminalService";

const STATUS_REFRESH_INTERVAL_MS = 15000;

interface TerminalStatusState {
  statusMap: Map<string, TerminalStatusInfo>;
  _unlisten: UnlistenFn | null;
  _idleCheckInterval: ReturnType<typeof setInterval> | null;
  _initialized: boolean;
  getStatus: (sessionId: string | null) => TerminalStatusType | null;
  removeSession: (sessionId: string) => void;
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

  refreshLiveStatuses: async () => {
    try {
      const statuses = await invoke<TerminalStatusInfo[]>("get_all_terminal_status");
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

    const unlistenFn = await getCurrentWebview().listen<TerminalStatusInfo>("terminal-status", (event) => {
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
    set({ _unlisten: unlistenFn });

    // Idle 阈值 30 秒，检查间隔 15 秒足够（无需 5 秒精度）
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
    }, STATUS_REFRESH_INTERVAL_MS);
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
