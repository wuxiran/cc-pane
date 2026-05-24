import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ActivityView = "explorer" | "sessions" | "files" | "ssh" | "process" | "orchestration";
export type AppViewMode = "home" | "panes" | "todo" | "selfchat" | "files" | "providers" | "orchestration";

interface ActivityBarState {
  activeView: ActivityView;
  sidebarVisible: boolean;
  appViewMode: AppViewMode;
  orchestrationOverlayOpen: boolean;

  toggleView: (view: ActivityView) => void;
  setSidebarVisible: (visible: boolean) => void;
  toggleSidebar: () => void;
  setAppViewMode: (mode: AppViewMode) => void;
  openOrchestrationOverlay: () => void;
  closeOrchestrationOverlay: () => void;
  toggleOrchestrationOverlay: () => void;
  toggleTodoMode: () => void;
  toggleSelfChatMode: () => void;
  toggleFilesMode: () => void;
  toggleHomeMode: () => void;
  toggleProvidersMode: () => void;
}

export const useActivityBarStore = create<ActivityBarState>()(
  persist(
    (set, get) => ({
      activeView: "explorer",
      sidebarVisible: true,
      appViewMode: "home",
      orchestrationOverlayOpen: false,

      toggleView: (view: ActivityView) => {
        const state = get();
        if (view === "orchestration") {
          set({
            activeView: "orchestration",
            sidebarVisible: false,
            orchestrationOverlayOpen: !state.orchestrationOverlayOpen,
          });
          return;
        }
        // 如果当前在非 panes/files 模式（home/todo/selfchat）→ 退回 panes 并切到该 view
        if (state.appViewMode !== "panes" && state.appViewMode !== "files") {
          set({ appViewMode: "panes", activeView: view, sidebarVisible: true, orchestrationOverlayOpen: false });
          return;
        }
        // 如果切到 files 视图 → 进入 files appViewMode
        if (view === "files") {
          if (state.appViewMode === "files" && state.activeView === "files") {
            // 再次点击 → 退回 panes
            set({ appViewMode: "panes", activeView: "explorer", sidebarVisible: true, orchestrationOverlayOpen: false });
          } else {
            set({ appViewMode: "files", activeView: "files", sidebarVisible: true, orchestrationOverlayOpen: false });
          }
          return;
        }
        // 如果从 files 模式切到其他视图 → 退回 panes
        if (state.appViewMode === "files") {
          set({ appViewMode: "panes", activeView: view, sidebarVisible: true, orchestrationOverlayOpen: false });
          return;
        }
        if (state.activeView === view) {
          // 点击当前视图 → 折叠/展开
          set({ sidebarVisible: !state.sidebarVisible, orchestrationOverlayOpen: false });
        } else {
          // 切换到新视图 → 展开
          set({ activeView: view, sidebarVisible: true, orchestrationOverlayOpen: false });
        }
      },

      setSidebarVisible: (visible: boolean) => set({ sidebarVisible: visible }),

      toggleSidebar: () => set((s) => ({ sidebarVisible: !s.sidebarVisible })),

      setAppViewMode: (mode: AppViewMode) =>
        set((state) => {
          if (mode === "orchestration") {
            return {
              appViewMode: state.appViewMode === "orchestration" ? "panes" : state.appViewMode,
              activeView: "orchestration",
              sidebarVisible: false,
              orchestrationOverlayOpen: true,
            };
          }
          return { appViewMode: mode, orchestrationOverlayOpen: false };
        }),

      openOrchestrationOverlay: () =>
        set({
          activeView: "orchestration",
          sidebarVisible: false,
          orchestrationOverlayOpen: true,
        }),

      closeOrchestrationOverlay: () =>
        set((state) => ({
          appViewMode: state.appViewMode === "orchestration" ? "panes" : state.appViewMode,
          sidebarVisible: state.activeView === "orchestration" ? false : state.sidebarVisible,
          orchestrationOverlayOpen: false,
        })),

      toggleOrchestrationOverlay: () =>
        set((state) => ({
          activeView: "orchestration",
          sidebarVisible: false,
          orchestrationOverlayOpen: !state.orchestrationOverlayOpen,
        })),

      toggleTodoMode: () =>
        set((s) => ({
          appViewMode: s.appViewMode === "todo" ? "panes" : "todo",
          orchestrationOverlayOpen: false,
        })),

      toggleSelfChatMode: () =>
        set((s) => ({
          appViewMode: s.appViewMode === "selfchat" ? "panes" : "selfchat",
          orchestrationOverlayOpen: false,
        })),

      toggleHomeMode: () =>
        set((s) => ({
          appViewMode: s.appViewMode === "home" ? "panes" : "home",
          orchestrationOverlayOpen: false,
        })),

      toggleProvidersMode: () =>
        set((s) => ({
          appViewMode: s.appViewMode === "providers" ? "panes" : "providers",
          orchestrationOverlayOpen: false,
        })),

      toggleFilesMode: () =>
        set((s) => {
          if (s.appViewMode === "files") {
            return { appViewMode: "panes", activeView: "explorer", sidebarVisible: true, orchestrationOverlayOpen: false };
          }
          return { appViewMode: "files", activeView: "files" as ActivityView, sidebarVisible: true, orchestrationOverlayOpen: false };
        }),
    }),
    {
      name: "cc-panes-activity-bar",
      partialize: (state) => ({
        activeView: state.activeView,
        sidebarVisible: state.sidebarVisible,
        // appViewMode 不持久化（每次启动默认回到 home 模式）
      }),
    }
  )
);
