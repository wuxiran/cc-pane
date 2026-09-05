// 面板区 DnD 的落点解析（纯函数，便于单测）。
//
// tab 与 layout tab 共用同一个 DndContext（见 DndPaneProvider / MainViewSwitcher）：
// dnd-kit 的碰撞检测只在同一个 context 的 droppable registry 内做，layout tab 条
// 若自带 context 就永远不可能被 tab 命中。合并后靠 active.data.type 分流。
import type { LayoutEntry, PaneNode, Tab } from "@/types";

export type DndDropAction =
  | { kind: "reorder-tabs"; paneId: string; fromIndex: number; toIndex: number }
  | { kind: "move-tab"; fromPaneId: string; toPaneId: string; tabId: string; toIndex?: number }
  | { kind: "split-move-tab"; fromPaneId: string; toPaneId: string; tabId: string; edge: "right" | "bottom" }
  | { kind: "move-tab-to-layout"; fromPaneId: string; tabId: string; toLayoutId: string }
  | { kind: "reorder-layouts"; fromIndex: number; toIndex: number }
  | null;

export interface PaneDndContextData {
  /** 扁平化的全部 panel（usePanesStore.allPanels()） */
  panels: Array<{ id: string; tabs: Tab[] }>;
  /** 全部布局（usePanesStore.layouts，含星标） */
  layouts: Array<Pick<LayoutEntry, "id" | "kind"> & { rootPane?: PaneNode }>;
  currentLayoutId: string;
}

interface DragNode {
  id: string;
  data?: Record<string, unknown>;
}

export function resolveDndDrop(
  active: DragNode,
  over: DragNode | null,
  ctx: PaneDndContextData,
): DndDropAction {
  if (!over || active.id === over.id) return null;

  const activeType = active.data?.type;
  const overType = over.data?.type;

  if (activeType === "layout") {
    // 布局条内重排序。索引对原始 layouts 数组算（含星标项），与合并前的
    // LayoutTopBar.handleLayoutDragEnd 逐字等价。
    if (overType !== "layout") return null;
    const fromIndex = ctx.layouts.findIndex((layout) => layout.id === active.id);
    const toIndex = ctx.layouts.findIndex((layout) => layout.id === over.id);
    if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) return null;
    return { kind: "reorder-layouts", fromIndex, toIndex };
  }

  if (activeType !== "tab") return null;

  const fromPaneId = active.data?.paneId as string | undefined;
  if (!fromPaneId) return null;
  const tabId = active.id;

  if (overType === "layout") {
    const toLayoutId = (over.data?.layoutId as string | undefined) ?? over.id;
    const target = ctx.layouts.find((layout) => layout.id === toLayoutId);
    // 星标布局装不了终端 tab；拖到当前布局等于把 tab 挪到本布局首个 pane，
    // 是意料外的副作用，一律不接。
    if (!target || target.kind === "starred" || target.id === ctx.currentLayoutId) return null;
    return { kind: "move-tab-to-layout", fromPaneId, tabId, toLayoutId };
  }

  // 拖拽落边分屏：落到 pane 右/下边缘条 → 在目标 pane 旁开新窗格放这个 tab
  if (overType === "pane-edge") {
    const toPaneId = over.data?.paneId as string | undefined;
    const edge = over.data?.edge as "right" | "bottom" | undefined;
    if (!toPaneId || !edge) return null;
    if (!ctx.panels.some((p) => p.id === toPaneId)) return null;
    return { kind: "split-move-tab", fromPaneId, toPaneId, tabId, edge };
  }

  if (overType !== "tab") return null;

  const toPaneId = over.data?.paneId as string | undefined;
  if (!toPaneId) return null;

  if (fromPaneId === toPaneId) {
    const panel = ctx.panels.find((p) => p.id === fromPaneId);
    if (!panel) return null;
    const fromIndex = panel.tabs.findIndex((t) => t.id === tabId);
    const toIndex = panel.tabs.findIndex((t) => t.id === over.id);
    if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) return null;
    return { kind: "reorder-tabs", paneId: fromPaneId, fromIndex, toIndex };
  }

  const toPanel = ctx.panels.find((p) => p.id === toPaneId);
  if (!toPanel) return null;
  const toIndex = toPanel.tabs.findIndex((t) => t.id === over.id);
  return {
    kind: "move-tab",
    fromPaneId,
    toPaneId,
    tabId,
    toIndex: toIndex >= 0 ? toIndex : undefined,
  };
}
