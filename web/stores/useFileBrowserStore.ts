import { create } from "zustand";
import { persist } from "zustand/middleware";
import { normalizeNavigationPath, parentNavigationPath } from "@/utils/path";

const STORAGE_KEY = "cc-panes-file-browser";

function persistedBrowserState(value: unknown, repairLegacyDrive = false) {
  const stored = value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
  let currentPath = typeof stored.currentPath === "string" ? stored.currentPath : "";
  // Version 0 stripped the separator from drive roots before writing them.
  if (repairLegacyDrive && /^[A-Za-z]:$/.test(currentPath)) currentPath += "/";
  return {
    currentPath: normalizeNavigationPath(currentPath),
    followTerminal: typeof stored.followTerminal === "boolean" ? stored.followTerminal : true,
  };
}

interface FileBrowserState {
  currentPath: string;
  history: string[];
  historyIndex: number;
  refreshKey: number;
  followTerminal: boolean;

  navigateTo: (path: string) => void;
  goBack: () => void;
  goForward: () => void;
  goUp: () => void;
  refresh: () => void;
  setFollowTerminal: (value: boolean) => void;
  canGoBack: () => boolean;
  canGoForward: () => boolean;
}

export const useFileBrowserStore = create<FileBrowserState>()(
  persist(
    (set, get) => ({
      currentPath: "",
      history: [],
      historyIndex: -1,
      refreshKey: 0,
      followTerminal: true,

      navigateTo: (path: string) => {
        const state = get();
        const normalized = normalizeNavigationPath(path);
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
        const parent = parentNavigationPath(state.currentPath);
        if (parent === state.currentPath) return;
        get().navigateTo(parent);
      },

      refresh: () => {
        set((s) => ({ refreshKey: s.refreshKey + 1 }));
      },

      setFollowTerminal: (value) => {
        set({ followTerminal: value });
      },

      canGoBack: () => get().historyIndex > 0,
      canGoForward: () => get().historyIndex < get().history.length - 1,
    }),
    {
      name: STORAGE_KEY,
      version: 1,
      migrate: (stored, version) => persistedBrowserState(stored, version < 1),
      merge: (stored, current) => stored === undefined ? current : { ...current, ...persistedBrowserState(stored) },
      partialize: (state) => ({
        currentPath: state.currentPath,
        followTerminal: state.followTerminal,
      }),
    }
  )
);
