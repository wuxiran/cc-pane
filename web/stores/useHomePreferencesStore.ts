import { create } from "zustand";
import { persist } from "zustand/middleware";

/** 首页呈现偏好与应用设置解耦：它只影响本地 UI 排布，不进入 Rust AppSettings。 */
interface HomePreferencesState {
  showDesignHighlights: boolean;
  setShowDesignHighlights: (show: boolean) => void;
  resetHomePreferences: () => void;
}

export const HOME_PREFERENCES_STORAGE_KEY = "cc-panes-home-preferences";

export const useHomePreferencesStore = create<HomePreferencesState>()(
  persist(
    (set) => ({
      showDesignHighlights: true,
      setShowDesignHighlights: (showDesignHighlights) => set({ showDesignHighlights }),
      resetHomePreferences: () => set({ showDesignHighlights: true }),
    }),
    { name: HOME_PREFERENCES_STORAGE_KEY },
  ),
);

