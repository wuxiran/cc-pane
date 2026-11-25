// 布局切换器的展示模式（纯 UI 偏好，与 layouts 数据无关）：
// - corner：经典模式，ActivityBar 左下角 Command 按钮 + 悬浮面板（LayoutBar）
// - topbar：布局条模式，终端标签上方多一层水平布局条（LayoutTopBar）
// 两种模式共用 usePanesStore 的同一份 layouts 状态，随时互切、互不丢数据。
import { create } from "zustand";
import { persist } from "zustand/middleware";

export type LayoutSwitcherMode = "corner" | "topbar";
export type LayoutBarDensity = "comfortable" | "compact";
/** 固定布局常驻区在布局条的哪一端。 */
export type PinnedLayoutSide = "left" | "right";

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
  /** 布局条上被折叠的工作空间分组（按绑定的 workspaceName）。 */
  collapsedLayoutGroups: string[];
  /** 固定的布局：只显示图标，常驻在布局条一端，不随卡片区滚动。 */
  pinnedLayoutIds: string[];
  pinnedLayoutSide: PinnedLayoutSide;
  setSwitcherMode: (mode: LayoutSwitcherMode) => void;
  setLayoutBarDensity: (density: LayoutBarDensity) => void;
  toggleWorkspaceGroup: (group: string) => void;
  toggleWorktreeGroup: (repoKey: string) => void;
  setLayoutGroupCollapsed: (group: string, collapsed: boolean) => void;
  setLayoutPinned: (layoutId: string, pinned: boolean) => void;
  setPinnedLayoutSide: (side: PinnedLayoutSide) => void;
}

export const useLayoutUiStore = create<LayoutUiState>()(
  persist(
    (set) => ({
      switcherMode: "corner",
      layoutBarDensity: "comfortable",
      collapsedWorkspaceGroups: [],
      expandedWorktreeGroups: [],
      collapsedLayoutGroups: [],
      pinnedLayoutIds: [],
      pinnedLayoutSide: "left",
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
      setLayoutGroupCollapsed: (group, collapsed) => set((state) => {
        const normalized = group.trim();
        if (!normalized || state.collapsedLayoutGroups.includes(normalized) === collapsed) return state;
        return {
          collapsedLayoutGroups: collapsed
            ? [...state.collapsedLayoutGroups, normalized]
            : state.collapsedLayoutGroups.filter((item) => item !== normalized),
        };
      }),
      setLayoutPinned: (layoutId, pinned) => set((state) => {
        if (!layoutId || state.pinnedLayoutIds.includes(layoutId) === pinned) return state;
        return {
          pinnedLayoutIds: pinned
            ? [...state.pinnedLayoutIds, layoutId]
            : state.pinnedLayoutIds.filter((id) => id !== layoutId),
        };
      }),
      setPinnedLayoutSide: (side) => set({ pinnedLayoutSide: side }),
    }),
    {
      name: LAYOUT_UI_STORAGE_KEY,
      // 手改坏的固定区方向回落 left，其余字段照旧浅合并。
      merge: (persisted, current) => {
        const next = { ...current, ...(persisted as Partial<LayoutUiState> | undefined) };
        if (next.pinnedLayoutSide !== "left" && next.pinnedLayoutSide !== "right") {
          next.pinnedLayoutSide = current.pinnedLayoutSide;
        }
        if (!Array.isArray(next.pinnedLayoutIds)) next.pinnedLayoutIds = current.pinnedLayoutIds;
        return next;
      },
    },
  ),
);
