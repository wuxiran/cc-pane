import { create } from "zustand";
import { persist } from "zustand/middleware";

/** 状态栏可收起的次级项 id（「更多」菜单里的自定义勾选按它持久化）。 */
export type StatusbarItemId =
  | "system-resources"
  | "usage-stats"
  | "music"
  | "web-lock"
  | "pin"
  | "mini-mode"
  | "ccchan"
  | "language";

interface StatusbarPrefsState {
  /** 宽档也收进「更多」的次级项（默认空 = 全部行内展示，与旧行为一致）。 */
  tuckedItems: StatusbarItemId[];
  toggleTucked: (id: StatusbarItemId) => void;
}

/** 状态栏减负偏好：用户把低频项收进「更多」菜单（批 6 可发现性）。 */
export const useStatusbarPrefsStore = create<StatusbarPrefsState>()(
  persist(
    (set) => ({
      tuckedItems: [],
      toggleTucked: (id) =>
        set((state) => ({
          tuckedItems: state.tuckedItems.includes(id)
            ? state.tuckedItems.filter((item) => item !== id)
            : [...state.tuckedItems, id],
        })),
    }),
    { name: "cc-panes-statusbar-prefs" },
  ),
);
