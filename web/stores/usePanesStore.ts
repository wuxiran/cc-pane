import { create } from "zustand";
import { persist } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";
import { useEditorTabsStore } from "./useEditorTabsStore";
import { useActivityBarStore } from "./useActivityBarStore";
import { terminalService, ensureListeners } from "@/services/terminalService";
import type {
  PaneNode,
  Panel,
  SplitPane,
  Tab,
  SplitDirection,
  CliTool,
  SshConnectionInfo,
} from "@/types";

// 生成唯一 ID
function generateId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

// 创建新的面板
function createPanel(tab?: Tab): Panel {
  const id = generateId("pane");
  const defaultTab: Tab = tab || {
    id: generateId("tab"),
    title: "Terminal",
    contentType: "terminal",
    projectId: "",
    projectPath: "",
    sessionId: null,
  };
  return {
    type: "panel",
    id,
    tabs: [defaultTab],
    activeTabId: defaultTab.id,
  };
}

// 创建新标签（对象参数）
interface CreateTabOptions {
  projectId: string;
  projectPath: string;
  resumeId?: string;
  workspaceName?: string;
  providerId?: string;
  workspacePath?: string;
  cliTool?: CliTool;
  customTitle?: string;
  ssh?: SshConnectionInfo;
  machineName?: string;
}

function createTab(opts: CreateTabOptions): Tab {
  const { projectId, projectPath, resumeId, workspaceName, providerId, workspacePath, cliTool, customTitle, ssh, machineName } = opts;
  let title: string;
  if (customTitle) {
    title = customTitle;
  } else {
    const name = projectPath.split(/[/\\]/).pop() || "Terminal";
    if (ssh) {
      // 优先使用 machineName，否则回退到 [SSH]
      const label = machineName || "SSH";
      title = `[${label}] ${name}`;
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
  return {
    id: generateId("tab"),
    title,
    contentType: "terminal",
    projectId,
    projectPath,
    sessionId: null,
    resumeId,
    workspaceName,
    providerId,
    workspacePath,
    cliTool,
    launchClaude: (cliTool && cliTool !== "none") || undefined,
    ssh,
    machineName,
  };
}

// 递归查找面板
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

// 获取所有面板（扁平化）
function collectPanels(node: PaneNode): Panel[] {
  if (node.type === "panel") return [node];
  return node.children.flatMap(collectPanels);
}

/** 已关闭标签的快照（用于恢复） */
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
  machineName?: string;
}

interface PanesState {
  rootPane: PaneNode;
  activePaneId: string;
  closedTabs: ClosedTabSnapshot[];
  poppedOutTabs: Set<string>;

  // 派生
  allPanels: () => Panel[];
  activePane: () => Panel | null;
  findPaneById: (paneId: string) => PaneNode | null;

  // 分屏
  split: (paneId: string, direction: SplitDirection) => void;
  splitRight: (paneId: string) => void;
  splitDown: (paneId: string) => void;
  closePane: (paneId: string) => void;
  resizePanes: (paneId: string, sizes: number[]) => void;

  // 标签
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
  updateTabSession: (paneId: string, tabId: string, sessionId: string) => void;
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
  setTabDisconnected: (paneId: string, tabId: string, disconnected: boolean) => void;
  reconnectTab: (paneId: string, tabId: string) => Promise<string | null>;
  closeTabBySessionId: (sessionId: string) => void;
}

const initialPanel = createPanel();

/** 递归清理重启后不可恢复的状态 */
function cleanRehydratedPanes(node: PaneNode) {
  if (node.type === "panel") {
    for (const tab of node.tabs) {
      if (tab.contentType === "terminal") {
        tab.sessionId = null;
        if (tab.resumeId === "new") {
          tab.resumeId = undefined;
        }
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

        // 清理空 split 节点链（0 个子节点时从树中移除）
        // 注意：1 个子节点的 split 保留不折叠，避免 React remount 终端
        let emptyNodeId: string | null =
          parent.children.length === 0 ? parent.id : null;
        while (emptyNodeId) {
          const gpResult = findParent(state.rootPane, emptyNodeId);
          if (!gpResult) break;

          if (gpResult.parent === null) {
            // 空 split 是根节点 → 替换为新空面板
            const newPane = createPanel();
            state.rootPane = newPane;
            state.activePaneId = newPane.id;
            break;
          }

          const gp = gpResult.parent;
          const gpIdx = gpResult.index;
          gp.children.splice(gpIdx, 1);
          gp.sizes.splice(gpIdx, 1);

          const gpTotal = gp.sizes.reduce((a, b) => a + b, 0);
          gp.sizes = gpTotal > 0
            ? gp.sizes.map((s) => (s / gpTotal) * 100)
            : gp.sizes.map(() => 100 / gp.sizes.length);

          if (gp.children.length > 0) {
            const nextIdx = Math.min(gpIdx, gp.children.length - 1);
            const panels = collectPanels(gp.children[nextIdx]);
            if (panels.length > 0) {
              state.activePaneId = panels[0].id;
            }
            emptyNodeId = null;
          } else {
            // grandparent 也变空了，继续向上清理
            emptyNodeId = gp.id;
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

      // 源面板空了则关闭（closePane 内部有独立 set，不可嵌套）
      const fromPane = findPane(get().rootPane, fromPaneId);
      if (fromPane?.type === "panel" && fromPane.tabs.length === 0) {
        get().closePane(fromPaneId);
      }
    },

    splitAndMoveTab: (paneId, tabId, direction) => {
      const directionMap: Record<SplitDirection, "horizontal" | "vertical"> = {
        right: "horizontal",
        down: "vertical",
      };
      const splitDirection = directionMap[direction];

      set((state) => {
        const sourcePane = findPane(state.rootPane, paneId);
        if (sourcePane?.type !== "panel") return;
        if (sourcePane.tabs.length <= 1) return; // 不允许移走唯一标签

        const tabIndex = sourcePane.tabs.findIndex((t) => t.id === tabId);
        if (tabIndex === -1) return;

        // 取出 tab，创建 plain copy 避免 Immer orphaned draft proxy 问题
        const [draftTab] = sourcePane.tabs.splice(tabIndex, 1);
        const tab: Tab = { ...draftTab };

        // 更新源面板 activeTabId
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

      // 如果所有标签都被关闭，关闭面板
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
        state.activePaneId = paneId;
      });
    },

    setActivePane: (paneId) => set({ activePaneId: paneId }),

    updateTabSession: (paneId, tabId, sessionId) => {
      set((state) => {
        const pane = findPane(state.rootPane, paneId);
        if (pane?.type !== "panel") return;
        const tab = pane.tabs.find((t) => t.id === tabId);
        if (tab) tab.sessionId = sessionId;
      });
    },

    updateTabClaudeSession: (ptySessionId, claudeSessionId) => {
      set((state) => {
        const update = (node: PaneNode): boolean => {
          if (node.type === "panel") {
            for (const tab of node.tabs) {
              if (tab.sessionId === ptySessionId) {
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
        // 如果当前活动标签被最小化，切换到下一个非最小化标签
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
        machineName: lastClosed.machineName,
      });
    },

    openMcpConfig: (projectPath, title) => {
      const active = get().activePane();
      if (!active) return;

      // 复用已有 tab
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
      // 代理到 EditorTabsStore + 切换到 files 模式
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
        // 递增 reclaimKey 触发 TerminalView remount
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

    setTabDisconnected: (paneId, tabId, disconnected) => {
      set((state) => {
        const pane = findPane(state.rootPane, paneId);
        if (pane?.type !== "panel") return;
        const tab = pane.tabs.find((t) => t.id === tabId);
        if (!tab) return;
        tab.disconnected = disconnected;
        // 更新标题：断连时加 ⚡，重连时移除
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

    reconnectTab: async (paneId, tabId) => {
      // 从 Tab 数据中提取创建参数
      const snapshot = get();
      const pane = findPane(snapshot.rootPane, paneId);
      if (pane?.type !== "panel") return null;
      const tab = pane.tabs.find((t) => t.id === tabId);
      if (!tab || !tab.projectPath) return null;

      try {
        await ensureListeners();
        const sessionId = await terminalService.createSession({
          projectPath: tab.projectPath,
          cols: 80,
          rows: 24,
          workspaceName: tab.workspaceName,
          providerId: tab.providerId,
          workspacePath: tab.workspacePath,
          cliTool: tab.cliTool,
          ssh: tab.ssh,
        });

        // 更新 tab 的 sessionId 和断连状态
        set((state) => {
          const p = findPane(state.rootPane, paneId);
          if (p?.type !== "panel") return;
          const t = p.tabs.find((x) => x.id === tabId);
          if (!t) return;
          t.sessionId = sessionId;
          t.disconnected = false;
          // 恢复标题
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
        const tab = panel.tabs.find((t) => t.sessionId === sessionId);
        if (tab) {
          get().closeTab(panel.id, tab.id);
          return;
        }
      }
    },
  })),
  {
    name: "cc-panes-layout",
    version: 2,
    migrate: (persistedState, version) => {
      const state = persistedState as Record<string, unknown>;
      if (version < 2) {
        // v1 → v2: launchClaude: true → cliTool: "claude"
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
      return state;
    },
    partialize: (state) => ({
      rootPane: state.rootPane,
      activePaneId: state.activePaneId,
      // poppedOutTabs 不持久化（重启后弹出窗口不存在）
    }),
    merge: (persistedState, currentState) => {
      const merged = {
        ...currentState,
        ...(persistedState as object),
      };
      // persistedState 来自 JSON.parse，未被 Immer 冻结，可安全修改
      if (persistedState && (persistedState as Partial<PanesState>).rootPane) {
        cleanRehydratedPanes((merged as PanesState).rootPane);
      }
      return merged as PanesState;
    },
  },
  )
);
