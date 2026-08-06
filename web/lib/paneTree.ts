import type {
  PaneNode,
  Panel,
  SplitPane,
  Tab,
  TerminalPaneLeaf,
  TerminalPaneNode,
  TerminalPaneSplit,
} from "@/types";
import { inferCliTool, resolveRestoreMode } from "@/lib/terminalRestoreMode";

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
  // 占位空标签（docs/78 批4）：**不走** lib/tabLifecycle/tabFactory 的唯一构造
  // 点——tabFactory 反过来依赖本模块的 generateId，改道会成环；且这不是可启动
  // 身份，只是空 pane 的 UI 占位。真正的会话标签一律经工厂构造。
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
// 本文件位于 lib 层：纯树函数 + 零 store 依赖（层次由目录位置表达，
// 不再靠口头约定）。

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

  normalizeSplitSizes(root);

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
  normalizeSplitSizes(parent);

  return normalizePaneTree(rootPane);
}

/** 终端分屏树：按 id 查找节点。 */
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

/** 终端分屏树：收集全部 leaf。 */
export function collectTerminalLeaves(node?: TerminalPaneNode): TerminalPaneLeaf[] {
  if (!node) return [];
  if (node.type === "leaf") return [node];
  return node.children.flatMap(collectTerminalLeaves);
}

export function findTerminalPaneParent(
  node: TerminalPaneNode,
  paneId: string,
  parent: TerminalPaneSplit | null = null
): { parent: TerminalPaneSplit | null; index: number } | null {
  if (node.id === paneId) {
    return { parent, index: parent ? parent.children.indexOf(node) : -1 };
  }
  if (node.type === "split") {
    for (let i = 0; i < node.children.length; i += 1) {
      const result = findTerminalPaneParent(node.children[i], paneId, node);
      if (result) return result;
    }
  }
  return null;
}

export function syncTabTerminalState(tab: Tab): void {
  if (tab.contentType !== "terminal") return;

  if (!tab.terminalRootPane) {
    const fallbackLeaf: TerminalPaneLeaf = {
      type: "leaf",
      id: generateId("terminal-pane"),
      launchId: generateId("launch"),
      restoreMode: resolveRestoreMode({
        cliTool: inferCliTool(tab.cliTool, tab.launchClaude, tab.resumeId),
        resumeId: tab.resumeId,
      }),
      sessionId: tab.sessionId ?? null,
      resumeId: tab.resumeId,
      resumeIdSource: tab.resumeIdSource,
      workspaceName: tab.workspaceName,
      providerId: tab.providerId,
      modelId: tab.modelId,
      providerSelection: tab.providerSelection,
      launchProfileId: tab.launchProfileId,
      workspacePath: tab.workspacePath,
      workspaceSnapshotId: tab.workspaceSnapshotId,
      cliTool: tab.cliTool,
      launchClaude: tab.launchClaude,
      ssh: tab.ssh,
      wsl: tab.wsl,
      machineName: tab.machineName,
      disconnected: tab.disconnected,
      restoring: tab.restoring,
      savedSessionId: tab.savedSessionId,
      restoreBlockedReason: tab.restoreBlockedReason,
      leaseReadOnly: tab.leaseReadOnly,
      launchError: tab.launchError,
      launchAttempt: tab.launchAttempt,
    };
    tab.terminalRootPane = fallbackLeaf;
    tab.activeTerminalPaneId = fallbackLeaf.id;
  }

  const leaves = collectTerminalLeaves(tab.terminalRootPane);
  if (leaves.length === 0) return;

  const activeLeaf =
    (tab.activeTerminalPaneId
      ? leaves.find((leaf) => leaf.id === tab.activeTerminalPaneId)
      : null) ?? leaves[0];

  tab.activeTerminalPaneId = activeLeaf.id;
  tab.sessionId = activeLeaf.sessionId;
  tab.resumeId = activeLeaf.resumeId;
  tab.resumeIdSource = activeLeaf.resumeIdSource;
  tab.workspaceName = activeLeaf.workspaceName;
  tab.providerId = activeLeaf.providerId;
  tab.modelId = activeLeaf.modelId;
  tab.providerSelection = activeLeaf.providerSelection;
  tab.launchProfileId = activeLeaf.launchProfileId;
  tab.workspacePath = activeLeaf.workspacePath;
  tab.workspaceSnapshotId = activeLeaf.workspaceSnapshotId;
  tab.cliTool = activeLeaf.cliTool;
  tab.launchClaude = activeLeaf.launchClaude;
  tab.ssh = activeLeaf.ssh;
  tab.wsl = activeLeaf.wsl;
  tab.machineName = activeLeaf.machineName;
  tab.disconnected = activeLeaf.disconnected;
  tab.restoring = activeLeaf.restoring;
  tab.savedSessionId = activeLeaf.savedSessionId;
  tab.restoreBlockedReason = activeLeaf.restoreBlockedReason;
  tab.leaseReadOnly = activeLeaf.leaseReadOnly;
  tab.launchError = activeLeaf.launchError;
  tab.launchAttempt = activeLeaf.launchAttempt;
}

export function closeTerminalLeafInTab(tab: Tab, terminalPaneId: string): boolean {
  if (tab.contentType !== "terminal" || !tab.terminalRootPane) return false;
  const leaves = collectTerminalLeaves(tab.terminalRootPane);
  if (leaves.length <= 1) return false;

  const parentResult = findTerminalPaneParent(tab.terminalRootPane, terminalPaneId);
  if (!parentResult || parentResult.parent === null) return false;

  const parent = parentResult.parent;
  parent.children.splice(parentResult.index, 1);
  parent.sizes.splice(parentResult.index, 1);

  // 单 child 时保留 split 壳（不上提），避免幸存终端 remount；见 normalizePaneTree。
  normalizeSplitSizes(parent);

  const nextLeaves = collectTerminalLeaves(tab.terminalRootPane);
  tab.activeTerminalPaneId = nextLeaves[Math.min(parentResult.index, nextLeaves.length - 1)]?.id;
  syncTabTerminalState(tab);
  return true;
}

/** 在 tab（含分屏树）里按 sessionId 找 leaf；非分屏 tab 用 tab 自身伪造一个 leaf。 */
export function findSessionInTab(tab: Tab, sessionId: string): TerminalPaneLeaf | null {
  if (tab.contentType === "terminal" && tab.terminalRootPane) {
    return collectTerminalLeaves(tab.terminalRootPane)
      .find((leaf) => leaf.sessionId === sessionId) ?? null;
  }
  return tab.sessionId === sessionId
    ? {
        type: "leaf",
        id: tab.id,
        sessionId,
      }
    : null;
}

/** split 的 sizes 重归一化到 100（splice 后调用；全零时按 children 均分）。 */
export function normalizeSplitSizes(node: { sizes: number[]; children: unknown[] }): void {
  const total = node.sizes.reduce((sum, size) => sum + size, 0);
  node.sizes = total > 0
    ? node.sizes.map((size) => (size / total) * 100)
    : node.children.map(() => 100 / node.children.length);
}

/**
 * splice 后收敛：把新树写回持有者并把 activePaneId 落到首个 panel。
 *
 * holder 既可以是 store 工作副本（state），也可以是隐藏布局条目（layout）——
 * 两者结构同形（rootPane + activePaneId），这正是此前 8 处逐字副本的由来。
 */
export function assignTreeAndConvergeActive(
  holder: { rootPane: PaneNode; activePaneId: string },
  nextTree: PaneNode,
): void {
  holder.rootPane = nextTree;
  const activePane = findPane(holder.rootPane, holder.activePaneId);
  if (activePane?.type !== "panel") {
    holder.activePaneId = collectPanels(holder.rootPane)[0]?.id ?? holder.rootPane.id;
  }
}

/**
 * 逐布局遍历**含星标**（与消费侧 eachLayoutTree 的关键区别）：销毁/移除类
 * 操作必须扫星标布局——镜像标签同样要能移除，否则星标布局里的标签永远
 * 关不掉。当前布局的活树取工作副本 rootPane（layouts[i].rootPane 是旧的）。
 */
export function eachLayoutTreeWithStarred<L extends { id: string; rootPane?: PaneNode }>(
  state: { layouts: L[]; currentLayoutId: string; rootPane: PaneNode },
  fn: (tree: PaneNode, layout: L, isCurrent: boolean) => void,
): void {
  for (const layout of state.layouts) {
    const isCurrent = layout.id === state.currentLayoutId;
    const tree = isCurrent ? state.rootPane : layout.rootPane;
    if (!tree) continue;
    fn(tree, layout, isCurrent);
  }
}
