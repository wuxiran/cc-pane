// 布局切换器的展示模式（纯 UI 偏好，与 layouts 数据无关）：
// - corner：经典模式，ActivityBar 左下角 Command 按钮 + 悬浮面板（LayoutBar）
// - topbar：布局条模式，终端标签上方多一层水平布局条（LayoutTopBar）
// 两种模式共用 usePanesStore 的同一份 layouts 状态，随时互切、互不丢数据。
import { create } from "zustand";
import { persist } from "zustand/middleware";

export type LayoutSwitcherMode = "corner" | "topbar";
export type LayoutBarDensity = "comfortable" | "compact";

export const LAYOUT_UI_STORAGE_KEY = "cc-panes-layout-ui";

interface LayoutUiState {
  switcherMode: LayoutSwitcherMode;
  layoutBarDensity: LayoutBarDensity;
  collapsedWorkspaceGroups: string[];
  /**
   * 已展开的 worktree 分组（按 repoKey）。
   * 存「展开」而非「折叠」：默认必须是收起，用 collapsed 语义就得预先塞入所有 key。
   * 键用 repoKey 而非 project.id——项目移除再导入时 id 会变，展开状态不该丢。
   */
  expandedWorktreeGroups: string[];
  setSwitcherMode: (mode: LayoutSwitcherMode) => void;
  setLayoutBarDensity: (density: LayoutBarDensity) => void;
  toggleWorkspaceGroup: (group: string) => void;
  toggleWorktreeGroup: (repoKey: string) => void;
}

export const useLayoutUiStore = create<LayoutUiState>()(
  persist(
    (set) => ({
      switcherMode: "corner",
      layoutBarDensity: "comfortable",
      collapsedWorkspaceGroups: [],
      expandedWorktreeGroups: [],
      setSwitcherMode: (mode) => set({ switcherMode: mode }),
      setLayoutBarDensity: (density) => set({ layoutBarDensity: density }),
      toggleWorkspaceGroup: (group) => set((state) => {
        const normalized = group.trim();
        if (!normalized) return state;
        return {
          collapsedWorkspaceGroups: state.collapsedWorkspaceGroups.includes(normalized)
            ? state.collapsedWorkspaceGroups.filter((item) => item !== normalized)
            : [...state.collapsedWorkspaceGroups, normalized],
        };
      }),
      toggleWorktreeGroup: (repoKey) => set((state) => {
        const normalized = repoKey.trim();
        if (!normalized) return state;
        return {
          expandedWorktreeGroups: state.expandedWorktreeGroups.includes(normalized)
            ? state.expandedWorktreeGroups.filter((item) => item !== normalized)
            : [...state.expandedWorktreeGroups, normalized],
        };
      }),
    }),
    { name: LAYOUT_UI_STORAGE_KEY },
  ),
);
