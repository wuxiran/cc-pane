import { create } from "zustand";
import { persist } from "zustand/middleware";
import { experimentalFeatureEnabled } from "@/lib/experimentalGate";

export type ActivityView = "explorer" | "sessions" | "files" | "ssh" | "process" | "orchestration";
export type AppViewMode =
  | "home"
  | "panes"
  | "todo"
  | "selfchat"
  | "files"
  | "providers"
  | "imageGen"
  | "videoGen"
  | "skillMarket"
  | "orchestration";

/** 受实验开关门禁的全屏模式 → 对应开关。 */
const GATED_MODES = {
  imageGen: "mediaGeneration",
  videoGen: "mediaGeneration",
  skillMarket: "skillMarket",
} as const;

type GatedMode = keyof typeof GATED_MODES;

function isGatedMode(mode: AppViewMode): mode is GatedMode {
  return mode in GATED_MODES;
}

function gatedModeEnabled(mode: GatedMode): boolean {
  return experimentalFeatureEnabled(GATED_MODES[mode]);
}

interface ActivityBarState {
  activeView: ActivityView;
  sidebarVisible: boolean;
  /** 最左图标条显隐：标题栏折叠按钮连同侧栏一起收起；图标条自身折叠面板时保持 true */
  activityBarVisible: boolean;
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
  toggleMediaMode: () => void;
  toggleImageGenMode: () => void;
  toggleVideoGenMode: () => void;
  toggleSkillMarketMode: () => void;
}

export const useActivityBarStore = create<ActivityBarState>()(
  persist(
    (set, get) => ({
      activeView: "explorer",
      sidebarVisible: true,
      activityBarVisible: true,
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

      // 标题栏折叠按钮：侧栏与最左图标条一起收/放
      toggleSidebar: () =>
        set((s) => {
          const next = !s.sidebarVisible;
          return { sidebarVisible: next, activityBarVisible: next };
        }),

      setAppViewMode: (mode: AppViewMode) =>
        set((state) => {
          // 实验功能未勾选时拒绝进入其全屏页（活动栏图标已隐藏，这里挡的是
          // 其它调用点：全局技能面板按钮、旧链路、外部 emit 等）。
          if (isGatedMode(mode) && !gatedModeEnabled(mode)) return {};
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
        set((s) =>
          s.appViewMode === "todo"
            ? {
                sidebarVisible: !s.sidebarVisible,
                orchestrationOverlayOpen: false,
              }
            : {
                appViewMode: "todo",
                sidebarVisible: true,
                orchestrationOverlayOpen: false,
              },
        ),

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

      toggleMediaMode: () =>
        set((s) => {
          const leavingMedia = s.appViewMode === "imageGen" || s.appViewMode === "videoGen";
          if (!leavingMedia && !gatedModeEnabled("imageGen")) return {};
          return {
            appViewMode: leavingMedia ? "panes" : "imageGen",
            sidebarVisible: leavingMedia,
            orchestrationOverlayOpen: false,
          };
        }),

      toggleImageGenMode: () =>
        set((s) => {
          const leavingMedia = s.appViewMode === "imageGen";
          if (!leavingMedia && !gatedModeEnabled("imageGen")) return {};
          return {
            appViewMode: leavingMedia ? "panes" : "imageGen",
            // The media workspace owns its configuration sidebar. Restore the
            // regular sidebar only when returning to the terminal surface.
            sidebarVisible: leavingMedia,
            orchestrationOverlayOpen: false,
          };
        }),

      toggleVideoGenMode: () =>
        set((s) => {
          const leavingMedia = s.appViewMode === "videoGen";
          if (!leavingMedia && !gatedModeEnabled("videoGen")) return {};
          return {
            appViewMode: leavingMedia ? "panes" : "videoGen",
            sidebarVisible: leavingMedia,
            orchestrationOverlayOpen: false,
          };
        }),

      // 技能市场是全屏页；侧栏显隐由 MainViewSwitcher 按模式决定，这里不动 sidebarVisible。
      toggleSkillMarketMode: () =>
        set((s) => {
          const leaving = s.appViewMode === "skillMarket";
          if (!leaving && !gatedModeEnabled("skillMarket")) return {};
          return {
            appViewMode: leaving ? "panes" : "skillMarket",
            orchestrationOverlayOpen: false,
          };
        }),

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
        activityBarVisible: state.activityBarVisible,
        // appViewMode 不持久化（每次启动默认回到 home 模式）
      }),
    }
  )
);
