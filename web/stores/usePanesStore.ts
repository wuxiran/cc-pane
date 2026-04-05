import { create } from "zustand";
import { persist } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";
import { useEditorTabsStore } from "./useEditorTabsStore";
import { useActivityBarStore } from "./useActivityBarStore";
import { terminalService, ensureListeners } from "@/services/terminalService";
import { devDebugLog } from "@/utils/devLogger";
import type {
  PaneNode,
  Panel,
  SplitPane,
  Tab,
  SplitDirection,
  CliTool,
  SshConnectionInfo,
  WslLaunchInfo,
  TerminalPaneNode,
  TerminalPaneLeaf,
  TerminalPaneSplit,
} from "@/types";

// 生成唯一 ID
function generateId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

// 创建新的面板
function createPanel(tab?: Tab): Panel {
  const id = generateId("pane");
  const defaultTab: Tab = tab || createTab({
    projectId: "",
    projectPath: "",
    customTitle: "Terminal",
  });
  return {
    type: "panel",
    id,
    tabs: [defaultTab],
    activeTabId: defaultTab.id,
  };
}

interface CreateTabOptions {
  projectId: string;
  projectPath: string;
  sessionId?: string;
  resumeId?: string;
  workspaceName?: string;
  providerId?: string;
  workspacePath?: string;
  cliTool?: CliTool;
  customTitle?: string;
  ssh?: SshConnectionInfo;
  wsl?: WslLaunchInfo;
  machineName?: string;
}

function createTab(opts: CreateTabOptions): Tab {
  const { projectId, projectPath, sessionId, resumeId, workspaceName, providerId, workspacePath, cliTool, customTitle, ssh, wsl, machineName } = opts;
  let title: string;
  if (customTitle) {
    title = customTitle;
  } else {
    const name = projectPath.split(/[/\\]/).pop() || "Terminal";
    if (ssh) {
      const label = machineName || "SSH";
      title = `[${label}] ${name}`;
    } else if (wsl && cliTool && cliTool !== "none") {
      const toolLabel = cliTool.charAt(0).toUpperCase() + cliTool.slice(1);
      title = `${name} (${toolLabel} WSL)`;
    } else if (cliTool && cliTool !== "none") {
      const toolLabel = cliTool.charAt(0).toUpperCase() + cliTool.slice(1);
      title = `${name} (${toolLabel})`;
    } else if (resumeId === "new") {
      title = `${name} (Claude)`;
    } else if (resumeId) {
      title = `${name} (resume)`;
    } else {
      title = name;
    }
  }
  const terminalLeaf: TerminalPaneLeaf = {
    type: "leaf",
    id: generateId("terminal-pane"),
    sessionId: sessionId ?? null,
    resumeId,
    workspaceName,
    providerId,
    workspacePath,
    cliTool,
    launchClaude: (cliTool && cliTool !== "none") || undefined,
    ssh,
    wsl,
    machineName,
  };

  return {
    id: generateId("tab"),
    title,
    contentType: "terminal",
    projectId,
    projectPath,
    sessionId: terminalLeaf.sessionId,
    resumeId: terminalLeaf.resumeId,
    workspaceName: terminalLeaf.workspaceName,
    providerId: terminalLeaf.providerId,
    workspacePath: terminalLeaf.workspacePath,
    cliTool: terminalLeaf.cliTool,
    launchClaude: terminalLeaf.launchClaude,
    ssh: terminalLeaf.ssh,
    wsl: terminalLeaf.wsl,
    machineName: terminalLeaf.machineName,
    terminalRootPane: terminalLeaf,
    activeTerminalPaneId: terminalLeaf.id,
  };
}

function cloneTerminalLeaf(source: TerminalPaneLeaf): TerminalPaneLeaf {
  return {
    ...source,
    id: generateId("terminal-pane"),
    sessionId: null,
    disconnected: false,
    restoring: false,
    savedSessionId: undefined,
  };
}

function findTerminalPane(node: TerminalPaneNode, paneId: string): TerminalPaneNode | null {
  if (node.id === paneId) return node;
  if (node.type === "split") {
    for (const child of node.children) {
      const found = findTerminalPane(child, paneId);
      if (found) return found;
    }
  }
  return null;
}

function findTerminalPaneParent(
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

function collectTerminalLeaves(node?: TerminalPaneNode): TerminalPaneLeaf[] {
  if (!node) return [];
  if (node.type === "leaf") return [node];
  return node.children.flatMap(collectTerminalLeaves);
}

function syncTabTerminalState(tab: Tab): void {
  if (tab.contentType !== "terminal") return;

  if (!tab.terminalRootPane) {
    const fallbackLeaf: TerminalPaneLeaf = {
      type: "leaf",
      id: generateId("terminal-pane"),
      sessionId: tab.sessionId ?? null,
      resumeId: tab.resumeId,
      workspaceName: tab.workspaceName,
      providerId: tab.providerId,
      workspacePath: tab.workspacePath,
      cliTool: tab.cliTool,
      launchClaude: tab.launchClaude,
      ssh: tab.ssh,
      wsl: tab.wsl,
      machineName: tab.machineName,
      disconnected: tab.disconnected,
      restoring: tab.restoring,
      savedSessionId: tab.savedSessionId,
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
  tab.workspaceName = activeLeaf.workspaceName;
  tab.providerId = activeLeaf.providerId;
  tab.workspacePath = activeLeaf.workspacePath;
  tab.cliTool = activeLeaf.cliTool;
  tab.launchClaude = activeLeaf.launchClaude;
  tab.ssh = activeLeaf.ssh;
  tab.wsl = activeLeaf.wsl;
  tab.machineName = activeLeaf.machineName;
  tab.disconnected = activeLeaf.disconnected;
  tab.restoring = activeLeaf.restoring;
  tab.savedSessionId = activeLeaf.savedSessionId;
}

function findTabLocation(rootPane: PaneNode, tabId: string): { panel: Panel; tab: Tab } | null {
  for (const panel of collectPanels(rootPane)) {
    const tab = panel.tabs.find((item) => item.id === tabId);
    if (tab) return { panel, tab };
  }
  return null;
}
function findPane(node: PaneNode, paneId: string): PaneNode | null {
  if (node.id === paneId) return node;
  if (node.type === "split") {
    for (const child of node.children) {
      const found = findPane(child, paneId);
      if (found) return found;
    }
  }
  return null;
}

// 查找父节点
function findParent(
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

// Flatten all panels in the pane tree.
function collectPanels(node: PaneNode): Panel[] {
  if (node.type === "panel") return [node];
  return node.children.flatMap(collectPanels);
}

function normalizePaneTree(root: PaneNode): PaneNode {
  if (root.type === "panel") return root;

  root.children = root.children.map((child) => normalizePaneTree(child));

  if (root.children.length === 0) {
    return createPanel();
  }

  if (root.children.length === 1) {
    return root.children[0];
  }

  const total = root.sizes.reduce((sum, size) => sum + size, 0);
  root.sizes = total > 0
    ? root.sizes.map((size) => (size / total) * 100)
    : root.children.map(() => 100 / root.children.length);

  return root;
}

const PANES_DEBUG = import.meta.env.DEV;

function summarizePanel(node: PaneNode | null) {
  if (node?.type !== "panel") return null;
  return {
    paneId: node.id,
    activeTabId: node.activeTabId,
    tabs: node.tabs.map((tab) => ({
      tabId: tab.id,
      sessionId: tab.sessionId ?? null,
      cliTool: tab.cliTool ?? (tab.launchClaude ? "claude" : "none"),
      projectPath: tab.projectPath,
    })),
  };
}

function debugPanes(event: string, payload: Record<string, unknown>): void {
  if (!PANES_DEBUG) return;
  devDebugLog("panes-store-debug", event, payload);
}

/** Snapshot of a closed tab so it can be reopened later. */
interface ClosedTabSnapshot {
  projectId: string;
  projectPath: string;
  title: string;
  resumeId?: string;
  workspaceName?: string;
  providerId?: string;
  workspacePath?: string;
  launchClaude?: boolean;
  cliTool?: CliTool;
  ssh?: SshConnectionInfo;
  wsl?: WslLaunchInfo;
  machineName?: string;
}

interface PanesState {
  rootPane: PaneNode;
  activePaneId: string;
  closedTabs: ClosedTabSnapshot[];
  poppedOutTabs: Set<string>;

  // Derived helpers
  allPanels: () => Panel[];
  activePane: () => Panel | null;
  findPaneById: (paneId: string) => PaneNode | null;

  // Pane layout
  split: (paneId: string, direction: SplitDirection) => void;
  splitRight: (paneId: string) => void;
  splitDown: (paneId: string) => void;
  closePane: (paneId: string) => void;
  resizePanes: (paneId: string, sizes: number[]) => void;

  // Tabs
  addTab: (paneId: string, opts: CreateTabOptions) => void;
  closeTab: (paneId: string, tabId: string) => void;
  togglePinTab: (paneId: string, tabId: string) => void;
  renameTab: (paneId: string, tabId: string, newTitle: string) => void;
  reorderTabs: (paneId: string, fromIndex: number, toIndex: number) => void;
  moveTab: (fromPaneId: string, toPaneId: string, tabId: string, toIndex?: number) => void;
  splitAndMoveTab: (paneId: string, tabId: string, direction: SplitDirection) => void;
  closeTabsToLeft: (paneId: string, tabId: string) => void;
  closeTabsToRight: (paneId: string, tabId: string) => void;
  closeOtherTabs: (paneId: string, tabId: string) => void;
  selectTab: (paneId: string, tabId: string) => void;
  setActivePane: (paneId: string) => void;
  updateTabSession: (paneId: string, tabId: string, sessionId: string, terminalPaneId?: string) => void;
  setActiveTerminalPane: (tabId: string, terminalPaneId: string) => void;
  splitTerminalPane: (tabId: string, terminalPaneId: string, direction: SplitDirection) => void;
  closeTerminalPane: (tabId: string, terminalPaneId: string) => void;
  resizeTerminalPanes: (tabId: string, terminalPaneId: string, sizes: number[]) => void;
  openProject: (opts: CreateTabOptions) => void;
  openProjectInPane: (paneId: string, opts: CreateTabOptions) => void;
  nextTab: (paneId: string) => void;
  prevTab: (paneId: string) => void;
  switchToTab: (paneId: string, index: number) => void;
  minimizeTab: (paneId: string, tabId: string) => void;
  restoreTab: (paneId: string, tabId: string) => void;
  reopenClosedTab: (paneId: string) => void;
  openMcpConfig: (projectPath: string, title: string) => void;
  openSkillManager: (projectPath: string, title: string) => void;
  openMemoryManager: (projectPath: string, title: string) => void;
  openFileExplorer: (projectPath: string, title: string) => void;
  openEditor: (projectPath: string, filePath: string, title: string) => void;
  setTabDirty: (paneId: string, tabId: string, dirty: boolean) => void;
  markTabPoppedOut: (tabId: string) => void;
  markTabReclaimed: (tabId: string) => void;
  isTabPoppedOut: (tabId: string) => boolean;
  updateTabClaudeSession: (ptySessionId: string, claudeSessionId: string) => void;
  setTabDisconnected: (paneId: string, tabId: string, disconnected: boolean, terminalPaneId?: string) => void;
  reconnectTab: (paneId: string, tabId: string, terminalPaneId?: string) => Promise<string | null>;
  closeTabBySessionId: (sessionId: string) => void;
  /** Clear restoring metadata after a terminal tab finishes recovery. */
  clearRestoring: (paneId: string, tabId: string, terminalPaneId?: string) => void;
  /** Collect terminal tabs that can be restored after restart. */
  getRestorableTabs: () => Array<{ tab: Tab; paneId: string }>;
}

const initialPanel = createPanel();

/** Clean non-restorable runtime state after layout rehydration. */
function cleanRehydratedPanes(node: PaneNode) {
  if (node.type === "panel") {
    for (const tab of node.tabs) {
      if (tab.contentType === "terminal") {
        syncTabTerminalState(tab);
        for (const leaf of collectTerminalLeaves(tab.terminalRootPane)) {
          if (leaf.sessionId) {
            leaf.savedSessionId = leaf.sessionId;
            leaf.restoring = true;
          }
          leaf.sessionId = null;
          if (leaf.resumeId === "new") {
            leaf.resumeId = undefined;
          }
        }
        syncTabTerminalState(tab);
      }
      if (tab.contentType === "editor") {
        tab.dirty = false;
      }
    }
  } else {
    node.children.forEach(cleanRehydratedPanes);
  }
}

export const usePanesStore = create<PanesState>()(
  persist(
  immer((set, get) => ({
    rootPane: initialPanel,
    activePaneId: initialPanel.id,
    closedTabs: [],
    poppedOutTabs: new Set<string>(),

    allPanels: () => collectPanels(get().rootPane),

    activePane: () => {
      const pane = findPane(get().rootPane, get().activePaneId);
      return pane?.type === "panel" ? pane : null;
    },

    findPaneById: (paneId) => findPane(get().rootPane, paneId),

    split: (paneId, direction) => {
      const directionMap: Record<SplitDirection, "horizontal" | "vertical"> = {
        right: "horizontal",
        down: "vertical",
      };
      const splitDirection = directionMap[direction];

      set((state) => {
        const parentResult = findParent(state.rootPane, paneId);
        if (!parentResult) return;

        const targetPane = findPane(state.rootPane, paneId);
        if (!targetPane || targetPane.type !== "panel") return;

        const newPane = createPanel();

        if (parentResult.parent === null) {
          const newSplit: SplitPane = {
            type: "split",
            id: generateId("split"),
            direction: splitDirection,
            children: [targetPane, newPane],
            sizes: [50, 50],
          };
          state.rootPane = newSplit;
        } else {
          const parent = parentResult.parent;
          const index = parentResult.index;

          if (parent.direction === splitDirection) {
            parent.children.splice(index + 1, 0, newPane);
            const newSize = 100 / parent.children.length;
            parent.sizes = parent.children.map(() => newSize);
          } else {
            const newSplit: SplitPane = {
              type: "split",
              id: generateId("split"),
              direction: splitDirection,
              children: [targetPane, newPane],
              sizes: [50, 50],
            };
            parent.children[index] = newSplit;
          }
        }

        state.activePaneId = newPane.id;
      });
    },

    splitRight: (paneId) => get().split(paneId, "right"),
    splitDown: (paneId) => get().split(paneId, "down"),

    closePane: (paneId) => {
      // 保存可恢复标签
      const closingPane = findPane(get().rootPane, paneId);
      if (closingPane?.type === "panel") {
        const recoverableTabs: ClosedTabSnapshot[] = closingPane.tabs
          .filter((t) => t.projectPath && t.contentType === "terminal")
          .map((t) => ({
            projectId: t.projectId,
            projectPath: t.projectPath,
            title: t.title,
            resumeId: t.resumeId,
            workspaceName: t.workspaceName,
            providerId: t.providerId,
            workspacePath: t.workspacePath,
            launchClaude: t.launchClaude,
            cliTool: t.cliTool,
            ssh: t.ssh,
            wsl: t.wsl,
            machineName: t.machineName,
          }));
        if (recoverableTabs.length > 0) {
          set((state) => {
            state.closedTabs.push(...recoverableTabs);
          });
        }
      }

      set((state) => {
        const parentResult = findParent(state.rootPane, paneId);
        if (!parentResult) return;

        if (parentResult.parent === null) {
          const newPane = createPanel();
          state.rootPane = newPane;
          state.activePaneId = newPane.id;
          return;
        }

        const parent = parentResult.parent;
        const index = parentResult.index;

        parent.children.splice(index, 1);
        parent.sizes.splice(index, 1);

        const total = parent.sizes.reduce((a, b) => a + b, 0);
        parent.sizes = total > 0
          ? parent.sizes.map((s) => (s / total) * 100)
          : parent.sizes.map(() => 100 / parent.sizes.length);

        if (parent.children.length > 0) {
          const newIndex = Math.min(index, parent.children.length - 1);
          const nextPane = parent.children[newIndex];
          const panels = collectPanels(nextPane);
          if (panels.length > 0) {
            state.activePaneId = panels[0].id;
          }
        }

        state.rootPane = normalizePaneTree(state.rootPane);
        const activePane = findPane(state.rootPane, state.activePaneId);
        if (activePane?.type !== "panel") {
          const panels = collectPanels(state.rootPane);
          if (panels.length > 0) {
            state.activePaneId = panels[0].id;
          }
        }
      });
    },

    resizePanes: (paneId, sizes) => {
      set((state) => {
        const pane = findPane(state.rootPane, paneId);
        if (pane?.type === "split") {
          pane.sizes = sizes;
        }
      });
    },

    addTab: (paneId, opts) => {
      set((state) => {
        const pane = findPane(state.rootPane, paneId);
        if (pane?.type !== "panel") return;

        const newTab = createTab(opts);
        pane.tabs.push(newTab);
        pane.activeTabId = newTab.id;
      });
    },

    togglePinTab: (paneId, tabId) => {
      set((state) => {
        const pane = findPane(state.rootPane, paneId);
        if (pane?.type !== "panel") return;
        const tab = pane.tabs.find((t) => t.id === tabId);
        if (tab) tab.pinned = !tab.pinned;
      });
    },

    renameTab: (paneId, tabId, newTitle) => {
      set((state) => {
        const pane = findPane(state.rootPane, paneId);
        if (pane?.type !== "panel") return;
        const tab = pane.tabs.find((t) => t.id === tabId);
        if (tab) tab.title = newTitle;
      });
    },

    reorderTabs: (paneId, fromIndex, toIndex) => {
      set((state) => {
        const pane = findPane(state.rootPane, paneId);
        if (pane?.type !== "panel") return;
        if (fromIndex < 0 || fromIndex >= pane.tabs.length) return;
        if (toIndex < 0 || toIndex >= pane.tabs.length) return;

        const [movedTab] = pane.tabs.splice(fromIndex, 1);
        pane.tabs.splice(toIndex, 0, movedTab);
      });
    },

    moveTab: (fromPaneId, toPaneId, tabId, toIndex?) => {
      const beforeState = get();
      const beforeFromPane = findPane(beforeState.rootPane, fromPaneId);
      const beforeToPane = findPane(beforeState.rootPane, toPaneId);
      const movingTab =
        beforeFromPane?.type === "panel"
          ? beforeFromPane.tabs.find((t) => t.id === tabId) ?? null
          : null;
      debugPanes("moveTab.begin", {
        fromPaneId,
        toPaneId,
        tabId,
        toIndex: toIndex ?? null,
        activePaneId: beforeState.activePaneId,
        movingSessionId: movingTab?.sessionId ?? null,
        cliTool: movingTab?.cliTool ?? (movingTab?.launchClaude ? "claude" : "none"),
        fromPane: summarizePanel(beforeFromPane),
        toPane: summarizePanel(beforeToPane),
      });
      set((state) => {
        const fromPane = findPane(state.rootPane, fromPaneId);
        const toPane = findPane(state.rootPane, toPaneId);
        if (fromPane?.type !== "panel" || toPane?.type !== "panel") return;

        const tabIndex = fromPane.tabs.findIndex((t) => t.id === tabId);
        if (tabIndex === -1) return;

        const [tab] = fromPane.tabs.splice(tabIndex, 1);
        const insertAt =
          toIndex !== undefined && toIndex >= 0
            ? Math.min(toIndex, toPane.tabs.length)
            : toPane.tabs.length;
        toPane.tabs.splice(insertAt, 0, tab);

        toPane.activeTabId = tab.id;
        if (fromPane.tabs.length > 0) {
          const newIdx = Math.min(tabIndex, fromPane.tabs.length - 1);
          fromPane.activeTabId = fromPane.tabs[newIdx].id;
        }
        state.activePaneId = toPaneId;
      });

      const afterState = get();
      const afterFromPane = findPane(afterState.rootPane, fromPaneId);
      const afterToPane = findPane(afterState.rootPane, toPaneId);
      debugPanes("moveTab.end", {
        fromPaneId,
        toPaneId,
        tabId,
        activePaneId: afterState.activePaneId,
        fromPane: summarizePanel(afterFromPane),
        toPane: summarizePanel(afterToPane),
      });

      // closePane uses its own state update, so do this after the move completes.
      const fromPane = findPane(get().rootPane, fromPaneId);
      if (fromPane?.type === "panel" && fromPane.tabs.length === 0) {
        debugPanes("moveTab.close-empty-pane", {
          paneId: fromPaneId,
          tabId,
        });
        get().closePane(fromPaneId);

        const targetPane = findPane(get().rootPane, toPaneId);
        if (targetPane?.type === "panel" && targetPane.tabs.some((t) => t.id === tabId)) {
          debugPanes("moveTab.restore-target-focus", {
            paneId: toPaneId,
            tabId,
          });
          get().selectTab(toPaneId, tabId);
        }
      }
    },

    splitAndMoveTab: (paneId, tabId, direction) => {
      const beforeState = get();
      const beforePane = findPane(beforeState.rootPane, paneId);
      const movingTab =
        beforePane?.type === "panel"
          ? beforePane.tabs.find((t) => t.id === tabId) ?? null
          : null;
      debugPanes("splitAndMoveTab.begin", {
        paneId,
        tabId,
        direction,
        activePaneId: beforeState.activePaneId,
        movingSessionId: movingTab?.sessionId ?? null,
        cliTool: movingTab?.cliTool ?? (movingTab?.launchClaude ? "claude" : "none"),
        sourcePane: summarizePanel(beforePane),
      });
      const directionMap: Record<SplitDirection, "horizontal" | "vertical"> = {
        right: "horizontal",
        down: "vertical",
      };
      const splitDirection = directionMap[direction];

      set((state) => {
        const sourcePane = findPane(state.rootPane, paneId);
        if (sourcePane?.type !== "panel") return;
        if (sourcePane.tabs.length <= 1) return; // Never move the only tab out of a pane.

        const tabIndex = sourcePane.tabs.findIndex((t) => t.id === tabId);
        if (tabIndex === -1) return;

        // Copy the tab out of the draft to avoid keeping an orphaned Immer proxy around.
        const [draftTab] = sourcePane.tabs.splice(tabIndex, 1);
        const tab: Tab = { ...draftTab };

        // Update the source pane's active tab after removing the moved tab.
        if (sourcePane.activeTabId === tabId) {
          const newIdx = Math.min(tabIndex, sourcePane.tabs.length - 1);
          sourcePane.activeTabId = sourcePane.tabs[newIdx].id;
        }

        // 创建新面板（包含移过来的 tab）
        const newPane: Panel = {
          type: "panel",
          id: generateId("pane"),
          tabs: [tab],
          activeTabId: tab.id,
        };

        // 树结构插入
        const parentResult = findParent(state.rootPane, paneId);
        if (!parentResult) return;

        if (parentResult.parent === null) {
          state.rootPane = {
            type: "split",
            id: generateId("split"),
            direction: splitDirection,
            children: [sourcePane, newPane],
            sizes: [50, 50],
          };
        } else {
          const parent = parentResult.parent;
          const index = parentResult.index;
          if (parent.direction === splitDirection) {
            parent.children.splice(index + 1, 0, newPane);
            const newSize = 100 / parent.children.length;
            parent.sizes = parent.children.map(() => newSize);
          } else {
            parent.children[index] = {
              type: "split",
              id: generateId("split"),
              direction: splitDirection,
              children: [sourcePane, newPane],
              sizes: [50, 50],
            };
          }
        }

        state.activePaneId = newPane.id;
      });

      const afterState = get();
      debugPanes("splitAndMoveTab.end", {
        paneId,
        tabId,
        direction,
        activePaneId: afterState.activePaneId,
        panels: collectPanels(afterState.rootPane).map((panel) => summarizePanel(panel)),
      });
    },

    closeTab: (paneId, tabId) => {
      const snapshot = get();
      const snapPane = findPane(snapshot.rootPane, paneId);
      if (snapPane?.type !== "panel") return;
      const snapTab = snapPane.tabs.find((t) => t.id === tabId);
      if (!snapTab || snapTab.pinned) return;

      // 保存可恢复标签
      if (snapTab.projectPath && snapTab.contentType === "terminal") {
        set((state) => {
          state.closedTabs.push({
            projectId: snapTab.projectId,
            projectPath: snapTab.projectPath,
            title: snapTab.title,
            resumeId: snapTab.resumeId,
            workspaceName: snapTab.workspaceName,
            providerId: snapTab.providerId,
            workspacePath: snapTab.workspacePath,
            launchClaude: snapTab.launchClaude,
            cliTool: snapTab.cliTool,
            ssh: snapTab.ssh,
            wsl: snapTab.wsl,
            machineName: snapTab.machineName,
          });
        });
      }

      if (snapPane.tabs.length <= 1) {
        get().closePane(paneId);
        return;
      }

      set((state) => {
        const p = findPane(state.rootPane, paneId);
        if (p?.type !== "panel") return;

        const idx = p.tabs.findIndex((t) => t.id === tabId);
        if (idx === -1) return;
        if (p.tabs[idx].pinned) return;
        if (p.tabs.length <= 1) return;

        p.tabs.splice(idx, 1);
        if (p.activeTabId === tabId) {
          const newIdx = Math.min(idx, p.tabs.length - 1);
          p.activeTabId = p.tabs[newIdx].id;
        }
      });
    },

    closeTabsToLeft: (paneId, tabId) => {
      const snapshot = get();
      const snapPane = findPane(snapshot.rootPane, paneId);
      if (snapPane?.type !== "panel") return;
      const targetIdx = snapPane.tabs.findIndex((t) => t.id === tabId);
      if (targetIdx <= 0) return;

      const toClose = snapPane.tabs.slice(0, targetIdx).filter((t) => !t.pinned);
      if (toClose.length === 0) return;

      set((state) => {
        const p = findPane(state.rootPane, paneId);
        if (p?.type !== "panel") return;
        const closeIds = new Set(toClose.map((t) => t.id));
        p.tabs = p.tabs.filter((t) => !closeIds.has(t.id));
        if (p.activeTabId && closeIds.has(p.activeTabId)) {
          p.activeTabId = tabId;
        }
      });

      // Close the pane if every tab was removed.
      const afterPane = findPane(get().rootPane, paneId);
      if (afterPane?.type === "panel" && afterPane.tabs.length === 0) {
        get().closePane(paneId);
      }
    },

    closeTabsToRight: (paneId, tabId) => {
      const snapshot = get();
      const snapPane = findPane(snapshot.rootPane, paneId);
      if (snapPane?.type !== "panel") return;
      const targetIdx = snapPane.tabs.findIndex((t) => t.id === tabId);
      if (targetIdx === -1 || targetIdx >= snapPane.tabs.length - 1) return;

      const toClose = snapPane.tabs.slice(targetIdx + 1).filter((t) => !t.pinned);
      if (toClose.length === 0) return;

      set((state) => {
        const p = findPane(state.rootPane, paneId);
        if (p?.type !== "panel") return;
        const closeIds = new Set(toClose.map((t) => t.id));
        p.tabs = p.tabs.filter((t) => !closeIds.has(t.id));
        if (p.activeTabId && closeIds.has(p.activeTabId)) {
          p.activeTabId = tabId;
        }
      });

      const afterPane = findPane(get().rootPane, paneId);
      if (afterPane?.type === "panel" && afterPane.tabs.length === 0) {
        get().closePane(paneId);
      }
    },

    closeOtherTabs: (paneId, tabId) => {
      const snapshot = get();
      const snapPane = findPane(snapshot.rootPane, paneId);
      if (snapPane?.type !== "panel") return;

      const toClose = snapPane.tabs.filter((t) => t.id !== tabId && !t.pinned);
      if (toClose.length === 0) return;

      set((state) => {
        const p = findPane(state.rootPane, paneId);
        if (p?.type !== "panel") return;
        const closeIds = new Set(toClose.map((t) => t.id));
        p.tabs = p.tabs.filter((t) => !closeIds.has(t.id));
        if (p.activeTabId && closeIds.has(p.activeTabId)) {
          p.activeTabId = tabId;
        }
      });

      const afterPane = findPane(get().rootPane, paneId);
      if (afterPane?.type === "panel" && afterPane.tabs.length === 0) {
        get().closePane(paneId);
      }
    },

    selectTab: (paneId, tabId) => {
      set((state) => {
        const pane = findPane(state.rootPane, paneId);
        if (pane?.type !== "panel") return;
        pane.activeTabId = tabId;
        const tab = pane.tabs.find((item) => item.id === tabId);
        if (tab?.contentType === "terminal") {
          syncTabTerminalState(tab);
        }
        state.activePaneId = paneId;
      });
    },

    setActivePane: (paneId) => set({ activePaneId: paneId }),

    updateTabSession: (_paneId, tabId, sessionId, terminalPaneId) => {
      set((state) => {
        const location = findTabLocation(state.rootPane, tabId);
        if (!location) return;
        const { tab } = location;
        if (tab.contentType !== "terminal") {
          tab.sessionId = sessionId;
          return;
        }
        syncTabTerminalState(tab);
        const leafId = terminalPaneId ?? tab.activeTerminalPaneId;
        const leaf = leafId && tab.terminalRootPane
          ? findTerminalPane(tab.terminalRootPane, leafId)
          : null;
        if (leaf?.type !== "leaf") return;
        leaf.sessionId = sessionId;
        syncTabTerminalState(tab);
      });
    },

    setActiveTerminalPane: (tabId, terminalPaneId) => {
      set((state) => {
        const location = findTabLocation(state.rootPane, tabId);
        if (!location) return;
        const { tab } = location;
        if (tab.contentType !== "terminal" || !tab.terminalRootPane) return;
        if (!findTerminalPane(tab.terminalRootPane, terminalPaneId)) return;
        tab.activeTerminalPaneId = terminalPaneId;
        syncTabTerminalState(tab);
      });
    },

    splitTerminalPane: (tabId, terminalPaneId, direction) => {
      const directionMap: Record<SplitDirection, "horizontal" | "vertical"> = {
        right: "horizontal",
        down: "vertical",
      };
      set((state) => {
        const location = findTabLocation(state.rootPane, tabId);
        if (!location) return;
        const { tab } = location;
        if (tab.contentType !== "terminal" || !tab.terminalRootPane) return;
        const target = findTerminalPane(tab.terminalRootPane, terminalPaneId);
        if (target?.type !== "leaf") return;

        const newLeaf = cloneTerminalLeaf(target);
        const splitDirection = directionMap[direction];
        const parentResult = findTerminalPaneParent(tab.terminalRootPane, terminalPaneId);

        if (!parentResult || parentResult.parent === null) {
          tab.terminalRootPane = {
            type: "split",
            id: generateId("terminal-split"),
            direction: splitDirection,
            children: [target, newLeaf],
            sizes: [50, 50],
          };
        } else if (parentResult.parent.direction === splitDirection) {
          parentResult.parent.children.splice(parentResult.index + 1, 0, newLeaf);
          const newSize = 100 / parentResult.parent.children.length;
          parentResult.parent.sizes = parentResult.parent.children.map(() => newSize);
        } else {
          parentResult.parent.children[parentResult.index] = {
            type: "split",
            id: generateId("terminal-split"),
            direction: splitDirection,
            children: [target, newLeaf],
            sizes: [50, 50],
          };
        }

        tab.activeTerminalPaneId = newLeaf.id;
        syncTabTerminalState(tab);
      });
    },

    closeTerminalPane: (tabId, terminalPaneId) => {
      set((state) => {
        const location = findTabLocation(state.rootPane, tabId);
        if (!location) return;
        const { tab } = location;
        if (tab.contentType !== "terminal" || !tab.terminalRootPane) return;

        const leaves = collectTerminalLeaves(tab.terminalRootPane);
        if (leaves.length <= 1) return;

        const parentResult = findTerminalPaneParent(tab.terminalRootPane, terminalPaneId);
        if (!parentResult) return;

        if (parentResult.parent === null) {
          return;
        }

        const parent = parentResult.parent;
        parent.children.splice(parentResult.index, 1);
        parent.sizes.splice(parentResult.index, 1);

        if (parent.children.length === 1) {
          const gpResult = findTerminalPaneParent(tab.terminalRootPane, parent.id);
          if (!gpResult || gpResult.parent === null) {
            tab.terminalRootPane = parent.children[0];
          } else {
            gpResult.parent.children[gpResult.index] = parent.children[0];
          }
        } else {
          const total = parent.sizes.reduce((sum, size) => sum + size, 0);
          parent.sizes = parent.sizes.map((size) => (size / total) * 100);
        }

        const nextLeaves = collectTerminalLeaves(tab.terminalRootPane);
        tab.activeTerminalPaneId = nextLeaves[Math.min(parentResult.index, nextLeaves.length - 1)]?.id;
        syncTabTerminalState(tab);
      });
    },

    resizeTerminalPanes: (tabId, terminalPaneId, sizes) => {
      set((state) => {
        const location = findTabLocation(state.rootPane, tabId);
        if (!location) return;
        const { tab } = location;
        if (tab.contentType !== "terminal" || !tab.terminalRootPane) return;
        const split = findTerminalPane(tab.terminalRootPane, terminalPaneId);
        if (split?.type === "split") {
          split.sizes = sizes;
        }
      });
    },

    updateTabClaudeSession: (ptySessionId, claudeSessionId) => {
      set((state) => {
        const update = (node: PaneNode): boolean => {
          if (node.type === "panel") {
            for (const tab of node.tabs) {
              if (tab.contentType === "terminal" && tab.terminalRootPane) {
                for (const leaf of collectTerminalLeaves(tab.terminalRootPane)) {
                  if (leaf.sessionId === ptySessionId) {
                    leaf.resumeId = claudeSessionId;
                    syncTabTerminalState(tab);
                    return true;
                  }
                }
              } else if (tab.sessionId === ptySessionId) {
                tab.resumeId = claudeSessionId;
                return true;
              }
            }
          } else {
            for (const child of node.children) {
              if (update(child)) return true;
            }
          }
          return false;
        };
        update(state.rootPane);
      });
    },

    openProjectInPane: (paneId, opts) => {
      const { projectId, resumeId, cliTool } = opts;
      set((state) => {
        const pane = findPane(state.rootPane, paneId);
        if (pane?.type !== "panel") return;

        if (resumeId || (cliTool && cliTool !== "none")) {
          const newTab = createTab(opts);
          pane.tabs.push(newTab);
          pane.activeTabId = newTab.id;
          state.activePaneId = paneId;
          return;
        }

        const existingTab = pane.tabs.find(
          (t) => t.projectId === projectId && !t.resumeId && !t.cliTool
        );
        if (existingTab) {
          pane.activeTabId = existingTab.id;
        } else {
          const activeTab = pane.tabs.find((t) => t.id === pane.activeTabId);
          if (activeTab && !activeTab.projectPath) {
            const tabIndex = pane.tabs.indexOf(activeTab);
            const newTab = createTab({ ...opts, resumeId: undefined });
            pane.tabs.splice(tabIndex, 1, newTab);
            pane.activeTabId = newTab.id;
          } else {
            const newTab = createTab({ ...opts, resumeId: undefined });
            pane.tabs.push(newTab);
            pane.activeTabId = newTab.id;
          }
        }
        state.activePaneId = paneId;
      });
    },

    openProject: (opts) => {
      const active = get().activePane();
      if (active) {
        get().openProjectInPane(active.id, opts);
      } else if (get().rootPane.type === "panel") {
        get().openProjectInPane(get().rootPane.id, opts);
      }
    },

    nextTab: (paneId) => {
      set((state) => {
        const pane = findPane(state.rootPane, paneId);
        if (pane?.type !== "panel" || pane.tabs.length <= 1) return;
        const currentIndex = pane.tabs.findIndex((t) => t.id === pane.activeTabId);
        const nextIndex = (currentIndex + 1) % pane.tabs.length;
        pane.activeTabId = pane.tabs[nextIndex].id;
      });
    },

    prevTab: (paneId) => {
      set((state) => {
        const pane = findPane(state.rootPane, paneId);
        if (pane?.type !== "panel" || pane.tabs.length <= 1) return;
        const currentIndex = pane.tabs.findIndex((t) => t.id === pane.activeTabId);
        const prevIndex = (currentIndex - 1 + pane.tabs.length) % pane.tabs.length;
        pane.activeTabId = pane.tabs[prevIndex].id;
      });
    },

    switchToTab: (paneId, index) => {
      set((state) => {
        const pane = findPane(state.rootPane, paneId);
        if (pane?.type !== "panel") return;
        if (index >= 0 && index < pane.tabs.length) {
          pane.activeTabId = pane.tabs[index].id;
        }
      });
    },

    minimizeTab: (paneId, tabId) => {
      set((state) => {
        const pane = findPane(state.rootPane, paneId);
        if (pane?.type !== "panel") return;
        const tab = pane.tabs.find((t) => t.id === tabId);
        if (!tab) return;
        tab.minimized = true;
        // If the active tab is minimized, switch to the next visible tab.
        if (pane.activeTabId === tabId) {
          const nextVisible = pane.tabs.find((t) => t.id !== tabId && !t.minimized);
          if (nextVisible) {
            pane.activeTabId = nextVisible.id;
          }
        }
      });
    },

    restoreTab: (paneId, tabId) => {
      set((state) => {
        const pane = findPane(state.rootPane, paneId);
        if (pane?.type !== "panel") return;
        const tab = pane.tabs.find((t) => t.id === tabId);
        if (!tab) return;
        tab.minimized = false;
        pane.activeTabId = tabId;
      });
    },

    reopenClosedTab: (paneId) => {
      const { closedTabs } = get();
      if (closedTabs.length === 0) return;

      const lastClosed = closedTabs[closedTabs.length - 1];
      set((state) => {
        state.closedTabs.pop();
      });

      get().addTab(paneId, {
        projectId: lastClosed.projectId,
        projectPath: lastClosed.projectPath,
        resumeId: lastClosed.resumeId,
        workspaceName: lastClosed.workspaceName,
        providerId: lastClosed.providerId,
        workspacePath: lastClosed.workspacePath,
        cliTool: lastClosed.cliTool,
        ssh: lastClosed.ssh,
        wsl: lastClosed.wsl,
        machineName: lastClosed.machineName,
      });
    },

    openMcpConfig: (projectPath, title) => {
      const active = get().activePane();
      if (!active) return;

      // Reuse the existing tab if the project is already open here.
      const existing = active.tabs.find(
        (t) => t.contentType === "mcp-config" && t.projectPath === projectPath
      );
      if (existing) {
        get().selectTab(active.id, existing.id);
        return;
      }

      set((state) => {
        const pane = findPane(state.rootPane, state.activePaneId);
        if (pane?.type !== "panel") return;
        const newTab: Tab = {
          id: generateId("tab"),
          title: `MCP - ${title}`,
          contentType: "mcp-config",
          projectId: "",
          projectPath,
          sessionId: null,
        };
        pane.tabs.push(newTab);
        pane.activeTabId = newTab.id;
      });
    },

    openSkillManager: (projectPath, title) => {
      const active = get().activePane();
      if (!active) return;

      const existing = active.tabs.find(
        (t) => t.contentType === "skill-manager" && t.projectPath === projectPath
      );
      if (existing) {
        get().selectTab(active.id, existing.id);
        return;
      }

      set((state) => {
        const pane = findPane(state.rootPane, state.activePaneId);
        if (pane?.type !== "panel") return;
        const newTab: Tab = {
          id: generateId("tab"),
          title: `Skill - ${title}`,
          contentType: "skill-manager",
          projectId: "",
          projectPath,
          sessionId: null,
        };
        pane.tabs.push(newTab);
        pane.activeTabId = newTab.id;
      });
    },

    openMemoryManager: (projectPath, title) => {
      const active = get().activePane();
      if (!active) return;

      const existing = active.tabs.find(
        (t) => t.contentType === "memory-manager" && t.projectPath === projectPath
      );
      if (existing) {
        get().selectTab(active.id, existing.id);
        return;
      }

      set((state) => {
        const pane = findPane(state.rootPane, state.activePaneId);
        if (pane?.type !== "panel") return;
        const newTab: Tab = {
          id: generateId("tab"),
          title: `Memory - ${title}`,
          contentType: "memory-manager",
          projectId: "",
          projectPath,
          sessionId: null,
        };
        pane.tabs.push(newTab);
        pane.activeTabId = newTab.id;
      });
    },

    openFileExplorer: (projectPath, title) => {
      const active = get().activePane();
      if (!active) return;

      const existing = active.tabs.find(
        (t) => t.contentType === "file-explorer" && t.projectPath === projectPath
      );
      if (existing) {
        get().selectTab(active.id, existing.id);
        return;
      }

      set((state) => {
        const pane = findPane(state.rootPane, state.activePaneId);
        if (pane?.type !== "panel") return;
        const newTab: Tab = {
          id: generateId("tab"),
          title: `Explorer - ${title}`,
          contentType: "file-explorer",
          projectId: "",
          projectPath,
          sessionId: null,
        };
        pane.tabs.push(newTab);
        pane.activeTabId = newTab.id;
      });
    },

    openEditor: (projectPath, filePath, title) => {
      // Delegate to the editor tab store and switch to files mode.
      useEditorTabsStore.getState().openFile(projectPath, filePath, title);
      const activityState = useActivityBarStore.getState();
      if (activityState.appViewMode !== "files") {
        activityState.toggleFilesMode();
      }
    },

    setTabDirty: (paneId, tabId, dirty) => {
      set((state) => {
        const pane = findPane(state.rootPane, paneId);
        if (pane?.type !== "panel") return;
        const tab = pane.tabs.find((t) => t.id === tabId);
        if (tab) tab.dirty = dirty;
      });
    },

    markTabPoppedOut: (tabId) => {
      set((state) => {
        state.poppedOutTabs = new Set(state.poppedOutTabs).add(tabId);
      });
    },

    markTabReclaimed: (tabId) => {
      set((state) => {
        const next = new Set(state.poppedOutTabs);
        next.delete(tabId);
        state.poppedOutTabs = next;
        // Bump reclaimKey so TerminalView remounts after a popped-out tab returns.
        const panels = collectPanels(state.rootPane);
        for (const panel of panels) {
          const tab = panel.tabs.find((t) => t.id === tabId);
          if (tab) {
            tab.reclaimKey = (tab.reclaimKey ?? 0) + 1;
            break;
          }
        }
      });
    },

    isTabPoppedOut: (tabId) => get().poppedOutTabs.has(tabId),

    setTabDisconnected: (_paneId, tabId, disconnected, terminalPaneId) => {
      set((state) => {
        const location = findTabLocation(state.rootPane, tabId);
        const tab = location?.tab;
        if (!tab) return;
        if (tab.contentType === "terminal" && tab.terminalRootPane) {
          const leafId = terminalPaneId ?? tab.activeTerminalPaneId;
          const leaf = leafId ? findTerminalPane(tab.terminalRootPane, leafId) : null;
          if (leaf?.type === "leaf") {
            leaf.disconnected = disconnected;
          }
          syncTabTerminalState(tab);
        } else {
          tab.disconnected = disconnected;
        }
        // 更新标题：断连时加闪电，重连时移除
        if (tab.ssh && tab.machineName) {
          const name = tab.projectPath.split(/[/\\]/).pop() || "Terminal";
          if (disconnected) {
            tab.title = `[${tab.machineName}] \u26A1 ${name}`;
          } else {
            tab.title = `[${tab.machineName}] ${name}`;
          }
        }
      });
    },

    reconnectTab: async (_paneId, tabId, terminalPaneId) => {
      // 从 Tab 数据中提取创建参数
      const snapshot = get();
      const location = findTabLocation(snapshot.rootPane, tabId);
      const tab = location?.tab;
      if (!tab || !tab.projectPath) return null;
      const terminalLeaf =
        tab.contentType === "terminal" && tab.terminalRootPane
          ? findTerminalPane(tab.terminalRootPane, terminalPaneId ?? tab.activeTerminalPaneId ?? "")
          : null;
      const leaf = terminalLeaf?.type === "leaf" ? terminalLeaf : null;

      try {
        await ensureListeners();
        const sessionId = await terminalService.createSession({
          projectPath: tab.projectPath,
          cols: 80,
          rows: 24,
          workspaceName: leaf?.workspaceName ?? tab.workspaceName,
          providerId: leaf?.providerId ?? tab.providerId,
          workspacePath: leaf?.workspacePath ?? tab.workspacePath,
          cliTool: leaf?.cliTool ?? tab.cliTool,
          ssh: leaf?.ssh ?? tab.ssh,
          wsl: leaf?.wsl ?? tab.wsl,
        });

        // 更新 tab 的 sessionId 和断连状态
        set((state) => {
          const currentLocation = findTabLocation(state.rootPane, tabId);
          const t = currentLocation?.tab;
          if (!t) return;
          if (t.contentType === "terminal" && t.terminalRootPane) {
            const currentLeaf = findTerminalPane(
              t.terminalRootPane,
              terminalPaneId ?? t.activeTerminalPaneId ?? ""
            );
            if (currentLeaf?.type === "leaf") {
              currentLeaf.sessionId = sessionId;
              currentLeaf.disconnected = false;
            }
            syncTabTerminalState(t);
          } else {
            t.sessionId = sessionId;
            t.disconnected = false;
          }
          // Restore the original SSH tab title after reconnection succeeds.
          if (t.ssh && t.machineName) {
            const name = t.projectPath.split(/[/\\]/).pop() || "Terminal";
            t.title = `[${t.machineName}] ${name}`;
          }
        });

        return sessionId;
      } catch (error) {
        console.error("[reconnectTab] Failed to reconnect:", error);
        return null;
      }
    },

    closeTabBySessionId: (sessionId) => {
      const panels = collectPanels(get().rootPane);
      for (const panel of panels) {
        const tab = panel.tabs.find((t) => {
          if (t.contentType === "terminal" && t.terminalRootPane) {
            return collectTerminalLeaves(t.terminalRootPane).some((leaf) => leaf.sessionId === sessionId);
          }
          return t.sessionId === sessionId;
        });
        if (tab) {
          if (tab.contentType === "terminal" && tab.terminalRootPane) {
            const leaf = collectTerminalLeaves(tab.terminalRootPane)
              .find((item) => item.sessionId === sessionId);
            if (leaf && collectTerminalLeaves(tab.terminalRootPane).length > 1) {
              get().closeTerminalPane(tab.id, leaf.id);
              return;
            }
          }
          get().closeTab(panel.id, tab.id);
          return;
        }
      }
    },

    clearRestoring: (_paneId, tabId, terminalPaneId) => {
      set((state) => {
        const location = findTabLocation(state.rootPane, tabId);
        const tab = location?.tab;
        if (tab) {
          if (tab.contentType === "terminal" && tab.terminalRootPane) {
            const leaf = findTerminalPane(tab.terminalRootPane, terminalPaneId ?? tab.activeTerminalPaneId ?? "");
            if (leaf?.type === "leaf") {
              leaf.restoring = false;
              leaf.savedSessionId = undefined;
            }
            syncTabTerminalState(tab);
          } else {
            tab.restoring = false;
            tab.savedSessionId = undefined;
          }
        }
      });
    },

    getRestorableTabs: () => {
      const panels = collectPanels(get().rootPane);
      const result: Array<{ tab: Tab; paneId: string }> = [];
      for (const panel of panels) {
        for (const tab of panel.tabs) {
          if (tab.contentType === "terminal" && tab.projectPath) {
            syncTabTerminalState(tab);
            result.push({ tab, paneId: panel.id });
          }
        }
      }
      return result;
    },
  })),
  {
    name: "cc-panes-layout",
    version: 3,
    migrate: (persistedState, version) => {
      const state = persistedState as Record<string, unknown>;
      if (version < 2) {
        // v1 -> v2: migrate launchClaude=true tabs to cliTool="claude"
        function migrateNode(node: PaneNode) {
          if (node.type === "panel") {
            for (const tab of node.tabs) {
              if (!tab.cliTool && tab.launchClaude) {
                tab.cliTool = "claude";
              }
            }
          } else {
            node.children.forEach(migrateNode);
          }
        }
        if (state.rootPane) {
          migrateNode(state.rootPane as PaneNode);
        }
      }
      if (version < 3 && state.rootPane) {
        const migrateTerminalTabs = (node: PaneNode) => {
          if (node.type === "panel") {
            for (const tab of node.tabs) {
              if (tab.contentType === "terminal") {
                syncTabTerminalState(tab);
              }
            }
          } else {
            node.children.forEach(migrateTerminalTabs);
          }
        };
        migrateTerminalTabs(state.rootPane as PaneNode);
      }
      return state;
    },
    partialize: (state) => ({
      rootPane: state.rootPane,
      activePaneId: state.activePaneId,
      // poppedOutTabs is runtime-only; popped windows do not survive restart.
    }),
    merge: (persistedState, currentState) => {
      const merged = {
        ...currentState,
        ...(persistedState as object),
      };
      // persistedState comes from JSON.parse and is safe to normalize in place.
      if (persistedState && (persistedState as Partial<PanesState>).rootPane) {
        cleanRehydratedPanes((merged as PanesState).rootPane);
      }
      return merged as PanesState;
    },
  },
  )
);
