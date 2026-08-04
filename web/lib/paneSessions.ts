import { collectPanels } from "@/stores/paneTreeHelpers";
import type { TabContentType } from "@/lib/tabContentType";
import type { PaneNode, Tab, TerminalPaneLeaf, TerminalPaneNode } from "@/types";

export function findTerminalPane(
  node: TerminalPaneNode,
  paneId: string,
): TerminalPaneNode | null {
  if (node.id === paneId) return node;
  if (node.type === "split") {
    for (const child of node.children) {
      const found = findTerminalPane(child, paneId);
      if (found) return found;
    }
  }
  return null;
}

export function collectTerminalLeaves(node?: TerminalPaneNode): TerminalPaneLeaf[] {
  if (!node) return [];
  if (node.type === "leaf") return [node];
  return node.children.flatMap(collectTerminalLeaves);
}

export function collectTerminalSessionIds(tab: Tab): string[] {
  if (tab.contentType !== "terminal" || !tab.terminalRootPane) {
    return tab.sessionId ? [tab.sessionId] : [];
  }
  return collectTerminalLeaves(tab.terminalRootPane)
    .map((leaf) => leaf.sessionId)
    .filter((sessionId): sessionId is string => Boolean(sessionId));
}

/** 全类型 tab 扁平化。与 contentType 无关，是下面所有分类统计的唯一遍历实现。 */
export function collectTabs(node: PaneNode): Tab[] {
  return collectPanels(node).flatMap((panel) => panel.tabs);
}

/** 按 contentType 分桶。缺席的类型给空数组，调用方无需判空。 */
export function collectTabsByContentType(node: PaneNode): Record<TabContentType, Tab[]> {
  const buckets = {
    terminal: [],
    browser: [],
    editor: [],
    "file-explorer": [],
    "mcp-config": [],
    "skill-manager": [],
    "memory-manager": [],
  } as Record<TabContentType, Tab[]>;
  for (const tab of collectTabs(node)) {
    buckets[tab.contentType]?.push(tab);
  }
  return buckets;
}

/** collectTabs 的终端特化。保持单一遍历实现，调用方零改动。 */
export function collectTerminalTabs(node: PaneNode): Tab[] {
  return collectTabs(node).filter((tab) => tab.contentType === "terminal");
}

export function collectTerminalSessionIdsFromTree(node: PaneNode): string[] {
  return collectTerminalTabs(node).flatMap(collectTerminalSessionIds);
}
