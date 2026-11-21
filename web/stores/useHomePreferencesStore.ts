import { create } from "zustand";
import { persist } from "zustand/middleware";

/** 首页呈现偏好与应用设置解耦：它只影响本地 UI 排布，不进入 Rust AppSettings。 */
interface HomePreferencesState {
  showDesignHighlights: boolean;
  setShowDesignHighlights: (show: boolean) => void;
  /** 首页「快速上手」卡被用户手动关闭。 */
  quickStartDismissed: boolean;
  setQuickStartDismissed: (dismissed: boolean) => void;
  resetHomePreferences: () => void;
}

export const HOME_PREFERENCES_STORAGE_KEY = "cc-panes-home-preferences";

export const useHomePreferencesStore = create<HomePreferencesState>()(
  persist(
    (set) => ({
      showDesignHighlights: true,
      setShowDesignHighlights: (showDesignHighlights) => set({ showDesignHighlights }),
      quickStartDismissed: false,
      setQuickStartDismissed: (quickStartDismissed) => set({ quickStartDismissed }),
      resetHomePreferences: () => set({ showDesignHighlights: true, quickStartDismissed: false }),
    }),
    { name: HOME_PREFERENCES_STORAGE_KEY },
  ),
);

