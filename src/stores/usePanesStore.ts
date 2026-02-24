import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import type {
  PaneNode,
  Panel,
  SplitPane,
  Tab,
  SplitDirection,
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

// 创建新标签
function createTab(
  projectId: string,
  projectPath: string,
  resumeId?: string,
  workspaceName?: string,
  providerId?: string,
  workspacePath?: string,
  launchClaude?: boolean
): Tab {
  const name = projectPath.split(/[/\\]/).pop() || "Terminal";
  let title = name;
  if (launchClaude) {
    title = `${name} (Claude)`;
  } else if (resumeId === "new") {
    title = `${name} (Claude)`;
  } else if (resumeId) {
    title = `${name} (resume)`;
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
    launchClaude,
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

interface PanesState {
  rootPane: PaneNode;
  activePaneId: string;

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
  addTab: (paneId: string, projectId: string, projectPath: string, resumeId?: string, workspaceName?: string, providerId?: string, workspacePath?: string, launchClaude?: boolean) => void;
  closeTab: (paneId: string, tabId: string) => void;
  togglePinTab: (paneId: string, tabId: string) => void;
  renameTab: (paneId: string, tabId: string, newTitle: string) => void;
  reorderTabs: (paneId: string, fromIndex: number, toIndex: number) => void;
  moveTab: (fromPaneId: string, toPaneId: string, tabId: string, toIndex?: number) => void;
  splitAndMoveTab: (paneId: string, tabId: string, direction: SplitDirection) => void;
  selectTab: (paneId: string, tabId: string) => void;
  setActivePane: (paneId: string) => void;
  updateTabSession: (paneId: string, tabId: string, sessionId: string) => void;
  openProject: (projectId: string, projectPath: string, resumeId?: string, workspaceName?: string, providerId?: string, workspacePath?: string, launchClaude?: boolean) => void;
  openProjectInPane: (paneId: string, projectId: string, projectPath: string, resumeId?: string, workspaceName?: string, providerId?: string, workspacePath?: string, launchClaude?: boolean) => void;
  nextTab: (paneId: string) => void;
  prevTab: (paneId: string) => void;
  switchToTab: (paneId: string, index: number) => void;
}

const initialPanel = createPanel();

export const usePanesStore = create<PanesState>()(
  immer((set, get) => ({
    rootPane: initialPanel,
    activePaneId: initialPanel.id,

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

    addTab: (paneId, projectId, projectPath, resumeId?, workspaceName?, providerId?, workspacePath?, launchClaude?) => {
      set((state) => {
        const pane = findPane(state.rootPane, paneId);
        if (pane?.type !== "panel") return;

        const newTab = createTab(projectId, projectPath, resumeId, workspaceName, providerId, workspacePath, launchClaude);
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

    openProjectInPane: (paneId, projectId, projectPath, resumeId?, workspaceName?, providerId?, workspacePath?, launchClaude?) => {
      set((state) => {
        const pane = findPane(state.rootPane, paneId);
        if (pane?.type !== "panel") return;

        if (resumeId || launchClaude) {
          const newTab = createTab(projectId, projectPath, resumeId, workspaceName, providerId, workspacePath, launchClaude);
          pane.tabs.push(newTab);
          pane.activeTabId = newTab.id;
          state.activePaneId = paneId;
          return;
        }

        const existingTab = pane.tabs.find(
          (t) => t.projectId === projectId && !t.resumeId && !t.launchClaude
        );
        if (existingTab) {
          pane.activeTabId = existingTab.id;
        } else {
          const activeTab = pane.tabs.find((t) => t.id === pane.activeTabId);
          if (activeTab && !activeTab.projectPath) {
            const tabIndex = pane.tabs.indexOf(activeTab);
            const newTab = createTab(projectId, projectPath, undefined, workspaceName, providerId, workspacePath);
            pane.tabs.splice(tabIndex, 1, newTab);
            pane.activeTabId = newTab.id;
          } else {
            const newTab = createTab(projectId, projectPath, undefined, workspaceName, providerId, workspacePath);
            pane.tabs.push(newTab);
            pane.activeTabId = newTab.id;
          }
        }
        state.activePaneId = paneId;
      });
    },

    openProject: (projectId, projectPath, resumeId?, workspaceName?, providerId?, workspacePath?, launchClaude?) => {
      const active = get().activePane();
      if (active) {
        get().openProjectInPane(active.id, projectId, projectPath, resumeId, workspaceName, providerId, workspacePath, launchClaude);
      } else if (get().rootPane.type === "panel") {
        get().openProjectInPane(get().rootPane.id, projectId, projectPath, resumeId, workspaceName, providerId, workspacePath, launchClaude);
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
  }))
);
