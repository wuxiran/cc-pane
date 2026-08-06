import type { PaneNode, Panel, SplitPane, Tab, TerminalPaneLeaf } from "@/types";

/** 生成唯一 ID */
export function generateId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

/**
 * 创建新的面板（usePanesStore 与测试共用的唯一实现）。
 * 不传 tab 才生成默认空 "Terminal" 标签——调用点若已有会话标签必须传进来，
 * 否则会多出一个空标签（见 docs/25-pane-placement-fix.md）。
 */
export function createPanel(tab?: Tab): Panel {
  const id = generateId("pane");
  const defaultLeaf: TerminalPaneLeaf = {
    type: "leaf",
    id: generateId("terminal-pane"),
    launchId: generateId("launch"),
    restoreMode: "shell",
    sessionId: null,
  };
  // 占位空标签（docs/78）：**不走** usePanesStore.createTab 富工厂——本模块
  // 按头部约定只依赖 @/types，反向 import 会成环；且这不是可启动身份，只是
  // 空 pane 的 UI 占位。真正的会话标签一律经富工厂构造。
  const defaultTab: Tab = tab || {
    id: generateId("tab"),
    title: "Terminal",
    contentType: "terminal",
    projectId: "",
    projectPath: "",
    sessionId: null,
    terminalRootPane: defaultLeaf,
    activeTerminalPaneId: defaultLeaf.id,
  };
  return {
    type: "panel",
    id,
    tabs: [defaultTab],
    activeTabId: defaultTab.id,
  };
}

/** 创建新标签 */

/** 递归查找面板 */
export function findPane(node: PaneNode, paneId: string): PaneNode | null {
  if (node.id === paneId) return node;
  if (node.type === "split") {
    for (const child of node.children) {
      const found = findPane(child, paneId);
      if (found) return found;
    }
  }
  return null;
}

/** 查找父节点 */
export function findParent(
  node: PaneNode,
  paneId: string,
  parent: SplitPane | null = null
): { parent: SplitPane | null; index: number } | null {
  if (node.id === paneId) {
    return { parent, index: parent ? parent.children.indexOf(node) : -1 };
  }
  if (node.type === "split") {
    for (let i = 0; i < node.children.length; i++) {
      const result = findParent(node.children[i], paneId, node);
      if (result) return result;
    }
  }
  return null;
}

/** 获取所有面板（扁平化） */
export function collectPanels(node: PaneNode): Panel[] {
  if (node.type === "panel") return [node];
  return node.children.flatMap(collectPanels);
}

// ============ 以下自 usePanesStore.ts 下沉 ============
// 本模块保持只依赖 @/types（lib/paneSessions 反向 import collectPanels，别在这里
// import 会成环的模块）；需要 paneSessions / terminalRestoreMode 的树辅助放
// paneTreeRemovalHelpers.ts。

export const TERMINAL_LAYOUT_CHANGED_EVENT = "cc-panes:terminal-layout-changed";

export function notifyTerminalLayoutChanged(reason: string): void {
  if (typeof window === "undefined") return;
  const dispatch = () => {
    window.dispatchEvent(
      new CustomEvent(TERMINAL_LAYOUT_CHANGED_EVENT, {
        detail: { reason },
      })
    );
  };

  if (typeof window.requestAnimationFrame === "function") {
    window.requestAnimationFrame(dispatch);
    return;
  }

  window.setTimeout(dispatch, 0);
}

/** 在单棵 pane 树里定位 tab 及其所在 panel */
export function findTabLocation(
  rootPane: PaneNode,
  tabId: string,
): { panel: Panel; tab: Tab } | null {
  for (const panel of collectPanels(rootPane)) {
    const tab = panel.tabs.find((item) => item.id === tabId);
    if (tab) return { panel, tab };
  }
  return null;
}

export function normalizePaneTree(root: PaneNode): PaneNode {
  if (root.type === "panel") return root;

  root.children = root.children.map((child) => normalizePaneTree(child));

  if (root.children.length === 0) {
    return createPanel();
  }

  // 单 child 时保留 split 壳而不上提：上提会让 PaneContainer 组件类型 /
  // 祖父 SplitView 的 key 变化，React 整棵卸载重挂，幸存终端 xterm 被销毁重建。
  // 壳链只在快照/持久化加载入口由 flattenPaneTreeForImport 压平。
  if (root.sizes.length !== root.children.length) {
    root.sizes = root.children.map(() => 100 / root.children.length);
    return root;
  }

  const total = root.sizes.reduce((sum, size) => sum + size, 0);
  root.sizes = total > 0
    ? root.sizes.map((size) => (size / total) * 100)
    : root.children.map(() => 100 / root.children.length);

  return root;
}

export function closeTabInTree(
  rootPane: PaneNode,
  paneId: string,
  tabId: string,
  force = false,
): PaneNode {
  const pane = findPane(rootPane, paneId);
  if (pane?.type !== "panel") return rootPane;
  const idx = pane.tabs.findIndex((tab) => tab.id === tabId);
  if (idx === -1 || (!force && pane.tabs[idx].pinned)) return rootPane;

  if (pane.tabs.length > 1) {
    pane.tabs.splice(idx, 1);
    if (pane.activeTabId === tabId) {
      const nextIdx = Math.min(idx, pane.tabs.length - 1);
      pane.activeTabId = pane.tabs[nextIdx].id;
    }
    return rootPane;
  }

  const parentResult = findParent(rootPane, paneId);
  if (!parentResult) return rootPane;

  if (parentResult.parent === null) {
    return createPanel();
  }

  const parent = parentResult.parent;
  parent.children.splice(parentResult.index, 1);
  parent.sizes.splice(parentResult.index, 1);
  const total = parent.sizes.reduce((sum, size) => sum + size, 0);
  parent.sizes = total > 0
    ? parent.sizes.map((size) => (size / total) * 100)
    : parent.sizes.map(() => 100 / parent.sizes.length);

  return normalizePaneTree(rootPane);
}
