import { create } from "zustand";
import { persist } from "zustand/middleware";

export type SshFileViewMode = "tree" | "list";
export type SshFileSortKey = "name" | "size" | "modified";
export type SshFileSortDirection = "asc" | "desc";

export const SSH_REMOTE_FILE_PREFERENCES_STORAGE_KEY =
  "cc-panes-ssh-remote-file-preferences";

interface SshRemoteFilePreferencesState {
  viewMode: SshFileViewMode;
  sortKey: SshFileSortKey;
  sortDirection: SshFileSortDirection;
  bookmarks: Record<string, string[]>;
  setViewMode: (viewMode: SshFileViewMode) => void;
  setSort: (sortKey: SshFileSortKey) => void;
  toggleBookmark: (machineId: string, path: string) => void;
}

export const useSshRemoteFilePreferencesStore =
  create<SshRemoteFilePreferencesState>()(
    persist(
      (set) => ({
        viewMode: "tree",
        sortKey: "name",
        sortDirection: "asc",
        bookmarks: {},
        setViewMode: (viewMode) => set({ viewMode }),
        setSort: (sortKey) => set((state) => ({
          sortKey,
          sortDirection: state.sortKey === sortKey && state.sortDirection === "asc"
            ? "desc"
            : "asc",
        })),
        toggleBookmark: (machineId, path) => set((state) => {
          const current = state.bookmarks[machineId] ?? [];
          return {
            bookmarks: {
              ...state.bookmarks,
              [machineId]: current.includes(path)
                ? current.filter((bookmark) => bookmark !== path)
                : [...current, path],
            },
          };
        }),
      }),
      {
        name: SSH_REMOTE_FILE_PREFERENCES_STORAGE_KEY,
        version: 1,
        migrate: (persistedState, version) => {
          const state = persistedState as Partial<SshRemoteFilePreferencesState>;
          return {
            viewMode: version < 1 ? "tree" : state.viewMode ?? "tree",
            sortKey: state.sortKey ?? "name",
            sortDirection: state.sortDirection ?? "asc",
            bookmarks: state.bookmarks ?? {},
          };
        },
        partialize: (state) => ({
          viewMode: state.viewMode,
          sortKey: state.sortKey,
          sortDirection: state.sortDirection,
          bookmarks: state.bookmarks,
        }),
      },
    ),
  );
