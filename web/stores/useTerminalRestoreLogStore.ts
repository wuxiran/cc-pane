import { create } from "zustand";

const MAX_RESTORE_LOG_ENTRIES = 20;

export interface TerminalRestoreLogEntry {
  id: number;
  message: string;
}

interface TerminalRestoreLogState {
  logs: Record<string, TerminalRestoreLogEntry[]>;
  append: (
    tabId: string,
    terminalPaneId: string,
    event: string,
    details?: Record<string, unknown>,
  ) => void;
  clear: (tabId: string, terminalPaneId: string) => void;
  reset: () => void;
}

let nextRestoreLogId = 1;

export function terminalRestoreLogKey(tabId: string, terminalPaneId: string): string {
  return `${tabId}\u0000${terminalPaneId}`;
}

export const useTerminalRestoreLogStore = create<TerminalRestoreLogState>((set) => ({
  logs: {},

  append: (tabId, terminalPaneId, event, details = {}) => {
    const key = terminalRestoreLogKey(tabId, terminalPaneId);
    const message = `[layout-restore] ${event} ${JSON.stringify({
      timestamp: new Date().toISOString(),
      ...details,
    })}`;
    const entry = { id: nextRestoreLogId++, message };
    set((state) => ({
      logs: {
        ...state.logs,
        [key]: [...(state.logs[key] ?? []), entry].slice(-MAX_RESTORE_LOG_ENTRIES),
      },
    }));
  },

  clear: (tabId, terminalPaneId) => {
    const key = terminalRestoreLogKey(tabId, terminalPaneId);
    set((state) => {
      if (!state.logs[key]) return state;
      const logs = { ...state.logs };
      delete logs[key];
      return { logs };
    });
  },

  reset: () => set({ logs: {} }),
}));

export function writeTerminalRestoreLog(
  tabId: string,
  terminalPaneId: string,
  event: string,
  details: Record<string, unknown> = {},
): void {
  useTerminalRestoreLogStore.getState().append(tabId, terminalPaneId, event, details);
}
