// 布局预设（layout presets）相关的纯函数：分屏方向解析、预设树组装、结构匹配。
// 从 usePanesStore.ts 拆出（纯代码移动，逻辑不变）；matchLayoutPreset 由
// usePanesStore re-export 维持既有 import 路径。
import { generateId } from "@/lib/paneTree";
import type { PaneNode, Panel, SplitPane, SplitDirection } from "@/types";
import type { LayoutPresetId } from "@/types/pane";

/** 从根到目标节点的 split 祖先链（自顶向下，不含目标本身）；未找到返回 null */
export function findAncestorSplits(
  node: PaneNode,
  paneId: string,
  chain: SplitPane[] = []
): SplitPane[] | null {
  if (node.id === paneId) return chain;
  if (node.type === "split") {
    for (const child of node.children) {
      const found = findAncestorSplits(child, paneId, [...chain, node]);
      if (found) return found;
    }
  }
  return null;
}

/**
 * "auto" 方向：与最近一层**真正在分屏**的祖先容器取反，连续分屏即形成螺旋（右、下、右、下…）。
 * 单 child 壳的 direction 是陈旧值（插入时会被改写成新方向），必须跳过，否则首次分屏判反。
 */
export function resolveAutoDirection(root: PaneNode, paneId: string): SplitDirection {
  const chain = findAncestorSplits(root, paneId);
  if (!chain) return "right";
  for (let i = chain.length - 1; i >= 0; i--) {
    const ancestor = chain[i];
    if (ancestor.children.length >= 2) {
      return ancestor.direction === "horizontal" ? "down" : "right";
    }
  }
  return "right";
}

/** 各预设的格子数 */
export const LAYOUT_PRESET_SLOTS: Record<LayoutPresetId, number> = {
  "single": 1,
  "two-col": 2,
  "three-col": 3,
  "two-row": 2,
  "grid-2x2": 4,
  "main-side": 3,
};

export function createSplit(
  direction: SplitPane["direction"],
  children: PaneNode[],
  sizes?: number[]
): SplitPane {
  return {
    type: "split",
    id: generateId("split"),
    direction,
    children,
    sizes: sizes ?? children.map(() => 100 / children.length),
  };
}

// 按预设结构组装分屏树。slots 长度必须等于 LAYOUT_PRESET_SLOTS[preset]。
// rootSplitId 传现有根 split 的 id 以复用其 React key，减少整树 remount。
export function buildPresetTree(
  preset: LayoutPresetId,
  slots: Panel[],
  rootSplitId: string | null
): PaneNode {
  let root: PaneNode;
  switch (preset) {
    case "single":
      // 根已是 split 时保留单 child 壳（与 normalizePaneTree 的壳约定一致）
      root = rootSplitId
        ? createSplit("horizontal", [slots[0]], [100])
        : slots[0];
      break;
    case "two-col":
      root = createSplit("horizontal", slots);
      break;
    case "three-col":
      root = createSplit("horizontal", slots);
      break;
    case "two-row":
      root = createSplit("vertical", slots);
      break;
    case "grid-2x2":
      root = createSplit("vertical", [
        createSplit("horizontal", [slots[0], slots[1]]),
        createSplit("horizontal", [slots[2], slots[3]]),
      ]);
      break;
    case "main-side":
      root = createSplit(
        "horizontal",
        [slots[0], createSplit("vertical", [slots[1], slots[2]])],
        [60, 40]
      );
      break;
  }
  if (rootSplitId && root.type === "split") {
    root.id = rootSplitId;
  }
  return root;
}

/** 跳过单 child split 壳，取结构上的有效节点（仅用于结构匹配，不修改树） */
export function unwrapShell(node: PaneNode): PaneNode {
  let current = node;
  while (current.type === "split" && current.children.length === 1) {
    current = current.children[0];
  }
  return current;
}

/** 判断当前树结构是否恰好匹配某个预设（用于布局条高亮），不匹配返回 null */
export function matchLayoutPreset(root: PaneNode): LayoutPresetId | null {
  const node = unwrapShell(root);
  if (node.type === "panel") return "single";

  const children = node.children.map(unwrapShell);
  const allPanels = children.every((child) => child.type === "panel");

  if (node.direction === "horizontal") {
    if (children.length === 2 && allPanels) return "two-col";
    if (children.length === 3 && allPanels) return "three-col";
    if (
      children.length === 2
      && children[0].type === "panel"
      && children[1].type === "split"
      && children[1].direction === "vertical"
      && children[1].children.length === 2
      && children[1].children.map(unwrapShell).every((child) => child.type === "panel")
    ) {
      return "main-side";
    }
    return null;
  }

  if (children.length === 2 && allPanels) return "two-row";
  if (
    children.length === 2
    && children.every(
      (child) =>
        child.type === "split"
        && child.direction === "horizontal"
        && child.children.length === 2
        && child.children.map(unwrapShell).every((grand) => grand.type === "panel")
    )
  ) {
    return "grid-2x2";
  }
  return null;
}
