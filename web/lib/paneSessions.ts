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

export function collectTerminalTabs(node: PaneNode): Tab[] {
  if (node.type === "panel") {
    return node.tabs.filter((tab) => tab.contentType === "terminal");
  }
  return node.children.flatMap(collectTerminalTabs);
}

export function collectTerminalSessionIdsFromTree(node: PaneNode): string[] {
  return collectTerminalTabs(node).flatMap(collectTerminalSessionIds);
}
