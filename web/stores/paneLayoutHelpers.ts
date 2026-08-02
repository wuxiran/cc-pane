// 布局层辅助（在 PanesState / PanesDraft 之上操作 layouts 与工作副本）。
//
// 从 usePanesStore.ts 拆出：该文件已触到行数棘轮上限（web/test/lineRatchet.test.ts）。
// 这一组的共同点是「只认 layouts + 工作副本（rootPane/activePaneId/currentLayoutId）」，
// 不碰具体窗格树的增删改，自成一层。
import type {
  LayoutDraft,
  PaneNodeDraft,
  PanesDraft,
  PanesState,
} from "./panesStoreTypes";
import type { LayoutEntry, PaneNode } from "@/types";

/** 遍历全部**普通**布局的树（跳过星标布局——它只是镜像，不是真实布局） */
export function eachLayoutTree(
  state: PanesState,
  fn: (layout: LayoutEntry, tree: PaneNode) => void,
): void;
export function eachLayoutTree(
  state: PanesDraft,
  fn: (layout: LayoutDraft, tree: PaneNodeDraft) => void,
): void;
export function eachLayoutTree(
  state: PanesState | PanesDraft,
  fn: (layout: LayoutEntry | LayoutDraft, tree: PaneNode | PaneNodeDraft) => void,
): void {
  for (const layout of state.layouts) {
    if (isStarredLayout(layout)) continue;
    const tree = layoutTree(state, layout.id);
    if (tree) {
      fn(layout, tree);
    }
  }
}

export function isStarredLayout(layout: Pick<LayoutEntry, "kind">): boolean {
  return layout.kind === "starred";
}

export function isNormalLayout(layout: Pick<LayoutEntry, "kind">): boolean {
  return !isStarredLayout(layout);
}

export function firstNormalLayout(layouts: LayoutEntry[]): LayoutEntry | undefined {
  return layouts.find(isNormalLayout);
}

export function activeLayout(
  state: PanesState | PanesDraft,
): LayoutEntry | LayoutDraft | undefined {
  return state.layouts.find((layout) => layout.id === state.currentLayoutId);
}

export function activateFirstNormalLayout(state: PanesDraft): boolean {
  const current = activeLayout(state);
  if (current && isNormalLayout(current)) return true;
  const normal = firstNormalLayout(state.layouts);
  if (!normal) return false;
  state.currentLayoutId = normal.id;
  state.rootPane = normal.rootPane;
  state.activePaneId = normal.activePaneId;
  return true;
}

export function nextLayoutName(layouts: Array<Pick<LayoutEntry, "name">>): string {
  const used = new Set(layouts.map((layout) => layout.name.trim()));
  let index = layouts.length + 1;
  while (used.has(`布局 ${index}`)) {
    index += 1;
  }
  return `布局 ${index}`;
}

/** 当前布局取工作副本，其余布局取自身 rootPane（工作副本只镜像当前布局） */
export function layoutTree(
  state: PanesState | PanesDraft,
  layoutId: string,
): PaneNode | PaneNodeDraft | null {
  const layout = state.layouts.find((item) => item.id === layoutId);
  if (!layout || isStarredLayout(layout)) return null;
  if (layoutId === state.currentLayoutId) return state.rootPane;
  return layout.rootPane;
}

export function syncWorkingCopyToCurrentLayout(state: PanesDraft): void {
  const current = activeLayout(state);
  if (!current || isStarredLayout(current)) return;
  current.rootPane = state.rootPane;
  current.activePaneId = state.activePaneId;
}

/**
 * 解析「这次写操作要落到哪个布局的树上」。不传 layoutId = 当前布局（今天的行为）。
 *
 * 为什么需要：leader 派 worker 默认不再强切布局（见 useOrchestratorListener），
 * 但窗格仍必须建在**目标**布局里。store 的工作副本 `state.rootPane` 只代表当前
 * 布局，直接拿它写会把 worker 插进用户正在看的那个布局——比拽回去更糟。
 *
 * 非当前布局时 active 写 `layout.activePaneId`（切过去时生效），不碰 `state.activePaneId`。
 */
export interface LayoutWriteTarget {
  tree: PaneNodeDraft;
  isCurrent: boolean;
  setRoot: (node: PaneNodeDraft) => void;
  setActivePaneId: (paneId: string) => void;
}

export function resolveLayoutWriteTarget(
  state: PanesDraft,
  layoutId?: string,
): LayoutWriteTarget | null {
  if (layoutId && layoutId !== state.currentLayoutId) {
    const layout = state.layouts.find((item) => item.id === layoutId);
    if (layout && !isStarredLayout(layout)) {
      return {
        tree: layout.rootPane,
        isCurrent: false,
        setRoot: (node) => {
          layout.rootPane = node;
        },
        setActivePaneId: (paneId) => {
          layout.activePaneId = paneId;
        },
      };
    }
    // 目标布局不存在/是收藏布局 → 退回当前布局，保证会话总能落地
  }
  if (!activateFirstNormalLayout(state)) return null;
  return {
    tree: state.rootPane,
    isCurrent: true,
    setRoot: (node) => {
      state.rootPane = node;
    },
    setActivePaneId: (paneId) => {
      state.activePaneId = paneId;
    },
  };
}
