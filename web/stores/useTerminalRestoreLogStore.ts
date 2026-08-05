import { create } from "zustand";

const MAX_RESTORE_LOG_ENTRIES = 20;

export interface TerminalRestoreLogEntry {
  id: number;
  /** ISO 串，与写入日志文件的 timestamp 同源 */
  timestamp: string;
  /** 原始事件名（如 `identity.blocked`），渲染层据此翻译 */
  event: string;
  /** 事件附带的结构化字段，渲染层内插关键项、其余留给「原始详情」 */
  details: Record<string, unknown>;
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
    const entry: TerminalRestoreLogEntry = {
      id: nextRestoreLogId++,
      timestamp: new Date().toISOString(),
      event,
      details,
    };
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
