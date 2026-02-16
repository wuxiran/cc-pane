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
  providerId?: string
): Tab {
  const name = projectPath.split(/[/\\]/).pop() || "Terminal";
  let title = name;
  if (resumeId === "new") {
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
  addTab: (paneId: string, projectId: string, projectPath: string, resumeId?: string, workspaceName?: string, providerId?: string) => void;
  closeTab: (paneId: string, tabId: string) => void;
  togglePinTab: (paneId: string, tabId: string) => void;
  renameTab: (paneId: string, tabId: string, newTitle: string) => void;
  reorderTabs: (paneId: string, fromIndex: number, toIndex: number) => void;
  selectTab: (paneId: string, tabId: string) => void;
  setActivePane: (paneId: string) => void;
  updateTabSession: (paneId: string, tabId: string, sessionId: string) => void;
  openProject: (projectId: string, projectPath: string, resumeId?: string, workspaceName?: string, providerId?: string) => void;
  openProjectInPane: (paneId: string, projectId: string, projectPath: string, resumeId?: string, workspaceName?: string, providerId?: string) => void;
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
        parent.sizes = parent.sizes.map((s) => (s / total) * 100);

        if (parent.children.length === 1) {
          const remainingChild = parent.children[0];
          const grandParentResult = findParent(state.rootPane, parent.id);

          if (grandParentResult?.parent === null) {
            state.rootPane = remainingChild;
          } else if (grandParentResult?.parent) {
            const grandIndex = grandParentResult.index;
            grandParentResult.parent.children[grandIndex] = remainingChild;
          }
        }

        if (parent.children.length > 0) {
          const newIndex = Math.min(index, parent.children.length - 1);
          const nextPane = parent.children[newIndex];
          if (nextPane.type === "panel") {
            state.activePaneId = nextPane.id;
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

    addTab: (paneId, projectId, projectPath, resumeId?, workspaceName?, providerId?) => {
      set((state) => {
        const pane = findPane(state.rootPane, paneId);
        if (pane?.type !== "panel") return;

        const newTab = createTab(projectId, projectPath, resumeId, workspaceName, providerId);
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

    closeTab: (paneId, tabId) => {
      // 先检查是否需要 closePane（单 tab 面板）
      const snapshot = get();
      const snapPane = findPane(snapshot.rootPane, paneId);
      if (snapPane?.type !== "panel") return;
      const snapTab = snapPane.tabs.find((t) => t.id === tabId);
      if (!snapTab || snapTab.pinned) return;

      if (snapPane.tabs.length <= 1) {
        get().closePane(paneId);
        return;
      }

      // 多 tab 场景，在单个 set 中完成所有操作
      set((state) => {
        const p = findPane(state.rootPane, paneId);
        if (p?.type !== "panel") return;

        const idx = p.tabs.findIndex((t) => t.id === tabId);
        if (idx === -1) return;
        if (p.tabs[idx].pinned) return;

        // 二次检查：如果在 set 时 tab 数已变为 1，不做操作（留给下次调用）
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

    openProjectInPane: (paneId, projectId, projectPath, resumeId?, workspaceName?, providerId?) => {
      set((state) => {
        const pane = findPane(state.rootPane, paneId);
        if (pane?.type !== "panel") return;

        if (resumeId) {
          const newTab = createTab(projectId, projectPath, resumeId, workspaceName, providerId);
          pane.tabs.push(newTab);
          pane.activeTabId = newTab.id;
          state.activePaneId = paneId;
          return;
        }

        const existingTab = pane.tabs.find(
          (t) => t.projectId === projectId && !t.resumeId
        );
        if (existingTab) {
          pane.activeTabId = existingTab.id;
        } else {
          const activeTab = pane.tabs.find((t) => t.id === pane.activeTabId);
          if (activeTab && !activeTab.projectPath) {
            const tabIndex = pane.tabs.indexOf(activeTab);
            const newTab = createTab(projectId, projectPath, undefined, workspaceName, providerId);
            pane.tabs.splice(tabIndex, 1, newTab);
            pane.activeTabId = newTab.id;
          } else {
            const newTab = createTab(projectId, projectPath, undefined, workspaceName, providerId);
            pane.tabs.push(newTab);
            pane.activeTabId = newTab.id;
          }
        }
        state.activePaneId = paneId;
      });
    },

    openProject: (projectId, projectPath, resumeId?, workspaceName?, providerId?) => {
      const active = get().activePane();
      if (active) {
        get().openProjectInPane(active.id, projectId, projectPath, resumeId, workspaceName, providerId);
      } else if (get().rootPane.type === "panel") {
        get().openProjectInPane(get().rootPane.id, projectId, projectPath, resumeId, workspaceName, providerId);
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
