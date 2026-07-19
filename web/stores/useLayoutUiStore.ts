// 布局切换器的展示模式（纯 UI 偏好，与 layouts 数据无关）：
// - corner：经典模式，ActivityBar 左下角 Command 按钮 + 悬浮面板（LayoutBar）
// - topbar：布局条模式，终端标签上方多一层水平布局条（LayoutTopBar）
// 两种模式共用 usePanesStore 的同一份 layouts 状态，随时互切、互不丢数据。
import { create } from "zustand";
import { persist } from "zustand/middleware";

export type LayoutSwitcherMode = "corner" | "topbar";

interface LayoutUiState {
  switcherMode: LayoutSwitcherMode;
  setSwitcherMode: (mode: LayoutSwitcherMode) => void;
}

export const useLayoutUiStore = create<LayoutUiState>()(
  persist(
    (set) => ({
      switcherMode: "corner",
      setSwitcherMode: (mode) => set({ switcherMode: mode }),
    }),
    { name: "cc-panes-layout-ui" },
  ),
);
