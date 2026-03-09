import { create } from "zustand";
import { persist } from "zustand/middleware";

const STORAGE_KEY = "cc-panes-file-browser";

interface FileBrowserState {
  currentPath: string;
  history: string[];
  historyIndex: number;
  refreshKey: number;

  navigateTo: (path: string) => void;
  goBack: () => void;
  goForward: () => void;
  goUp: () => void;
  refresh: () => void;
  canGoBack: () => boolean;
  canGoForward: () => boolean;
}

function getParentPath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash <= 0) return normalized.charAt(0) === "/" ? "/" : normalized;
  // Windows 根目录：C:/
  if (lastSlash === 2 && normalized.charAt(1) === ":") {
    return normalized.slice(0, 3);
  }
  return normalized.slice(0, lastSlash);
}

export const useFileBrowserStore = create<FileBrowserState>()(
  persist(
    (set, get) => ({
      currentPath: "",
      history: [],
      historyIndex: -1,
      refreshKey: 0,

      navigateTo: (path: string) => {
        const state = get();
        const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "") || path;
        if (normalized === state.currentPath) return;

        // 截断 forward 历史
        const newHistory = state.history.slice(0, state.historyIndex + 1);
        newHistory.push(normalized);

        set({
          currentPath: normalized,
          history: newHistory,
          historyIndex: newHistory.length - 1,
        });
      },

      goBack: () => {
        const state = get();
        if (state.historyIndex <= 0) return;
        const newIndex = state.historyIndex - 1;
        set({
          currentPath: state.history[newIndex],
          historyIndex: newIndex,
        });
      },

      goForward: () => {
        const state = get();
        if (state.historyIndex >= state.history.length - 1) return;
        const newIndex = state.historyIndex + 1;
        set({
          currentPath: state.history[newIndex],
          historyIndex: newIndex,
        });
      },

      goUp: () => {
        const state = get();
        if (!state.currentPath) return;
        const parent = getParentPath(state.currentPath);
        if (parent === state.currentPath) return;
        get().navigateTo(parent);
      },

      refresh: () => {
        set((s) => ({ refreshKey: s.refreshKey + 1 }));
      },

      canGoBack: () => get().historyIndex > 0,
      canGoForward: () => get().historyIndex < get().history.length - 1,
    }),
    {
      name: STORAGE_KEY,
      partialize: (state) => ({
        currentPath: state.currentPath,
      }),
    }
  )
);
