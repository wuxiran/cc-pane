import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ActivityView = "explorer" | "search" | "sessions" | "files";
export type AppViewMode = "panes" | "todo" | "selfchat" | "files";

interface ActivityBarState {
  activeView: ActivityView;
  sidebarVisible: boolean;
  appViewMode: AppViewMode;

  toggleView: (view: ActivityView) => void;
  setSidebarVisible: (visible: boolean) => void;
  toggleSidebar: () => void;
  setAppViewMode: (mode: AppViewMode) => void;
  toggleTodoMode: () => void;
  toggleSelfChatMode: () => void;
  toggleFilesMode: () => void;
}

export const useActivityBarStore = create<ActivityBarState>()(
  persist(
    (set, get) => ({
      activeView: "explorer",
      sidebarVisible: true,
      appViewMode: "panes",

      toggleView: (view: ActivityView) => {
        const state = get();
        // 如果当前在非 panes/files 模式（todo/selfchat）→ 退回 panes 并切到该 view
        if (state.appViewMode !== "panes" && state.appViewMode !== "files") {
          set({ appViewMode: "panes", activeView: view, sidebarVisible: true });
          return;
        }
        // 如果切到 files 视图 → 进入 files appViewMode
        if (view === "files") {
          if (state.appViewMode === "files" && state.activeView === "files") {
            // 再次点击 → 退回 panes
            set({ appViewMode: "panes", activeView: "explorer", sidebarVisible: true });
          } else {
            set({ appViewMode: "files", activeView: "files", sidebarVisible: true });
          }
          return;
        }
        // 如果从 files 模式切到其他视图 → 退回 panes
        if (state.appViewMode === "files") {
          set({ appViewMode: "panes", activeView: view, sidebarVisible: true });
          return;
        }
        if (state.activeView === view) {
          // 点击当前视图 → 折叠/展开
          set({ sidebarVisible: !state.sidebarVisible });
        } else {
          // 切换到新视图 → 展开
          set({ activeView: view, sidebarVisible: true });
        }
      },

      setSidebarVisible: (visible: boolean) => set({ sidebarVisible: visible }),

      toggleSidebar: () => set((s) => ({ sidebarVisible: !s.sidebarVisible })),

      setAppViewMode: (mode: AppViewMode) => set({ appViewMode: mode }),

      toggleTodoMode: () =>
        set((s) => ({
          appViewMode: s.appViewMode === "todo" ? "panes" : "todo",
        })),

      toggleSelfChatMode: () =>
        set((s) => ({
          appViewMode: s.appViewMode === "selfchat" ? "panes" : "selfchat",
        })),

      toggleFilesMode: () =>
        set((s) => {
          if (s.appViewMode === "files") {
            return { appViewMode: "panes", activeView: "explorer", sidebarVisible: true };
          }
          return { appViewMode: "files", activeView: "files" as ActivityView, sidebarVisible: true };
        }),
    }),
    {
      name: "cc-panes-activity-bar",
      partialize: (state) => ({
        activeView: state.activeView,
        sidebarVisible: state.sidebarVisible,
        // appViewMode 不持久化（每次启动默认回到 panes 模式）
      }),
    }
  )
);
