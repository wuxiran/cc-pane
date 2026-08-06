import { collectPanels } from "@/stores/paneTreeHelpers";
import type { TabContentType } from "@/lib/tabContentType";
import { asPtySessionId } from "@/types/ids";
import type { PaneNode, Tab, TerminalPaneLeaf, TerminalPaneNode } from "@/types";
import type { PtySessionId } from "@/types/ids";

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

export function collectTerminalSessionIds(tab: Tab): PtySessionId[] {
  if (tab.contentType !== "terminal" || !tab.terminalRootPane) {
    return tab.sessionId ? [asPtySessionId(tab.sessionId)] : [];
  }
  return collectTerminalLeaves(tab.terminalRootPane)
    .map((leaf) => leaf.sessionId)
    .filter((sessionId): sessionId is string => Boolean(sessionId))
    .map(asPtySessionId);
}

/** 含 savedSessionId 的全量口径。restoring 中尚未 attach 的 savedSessionId 是真实 PTY，
 *  销毁/统计都必须算进去，否则漏杀成孤儿、少算成显示不一致。 */
export function collectTerminalSessionIdsWithSaved(tab: Tab): PtySessionId[] {
  const ids = new Set<PtySessionId>();
  if (tab.contentType !== "terminal" || !tab.terminalRootPane) {
    if (tab.sessionId) ids.add(asPtySessionId(tab.sessionId));
    if (tab.savedSessionId) ids.add(asPtySessionId(tab.savedSessionId));
    return [...ids];
  }
  for (const leaf of collectTerminalLeaves(tab.terminalRootPane)) {
    if (leaf.sessionId) ids.add(asPtySessionId(leaf.sessionId));
    if (leaf.savedSessionId) ids.add(asPtySessionId(leaf.savedSessionId));
  }
  return [...ids];
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

/**
 * 窄口径（不含 savedSessionId）。**展示遗留专用，销毁路径禁用**——
 * 恢复中的会话是真实 PTY，用本函数做杀集会漏杀成孤儿。
 * 守卫测试锁死：调用 destroySessionsDirectly/commitResourceDestroy 的文件
 * 不得使用本函数（daemonEventContract.test.ts 同款扫描）。
 */
export function collectTerminalSessionIdsFromTree(node: PaneNode): PtySessionId[] {
  return collectTerminalTabs(node).flatMap(collectTerminalSessionIds);
}

/** collectTerminalSessionIdsFromTree 的全量口径版本（含 savedSessionId），跨 tab 去重。 */
export function collectTerminalSessionIdsWithSavedFromTree(node: PaneNode): PtySessionId[] {
  return [...new Set(collectTerminalTabs(node).flatMap(collectTerminalSessionIdsWithSaved))];
}
