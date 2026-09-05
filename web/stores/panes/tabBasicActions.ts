// 标签基础 actions：增删改查、选中/切换/最小化、pin/star、popout 标记。
// 从 usePanesStore.ts 拆出（纯代码移动，逻辑不变）；在 usePanesStore 里 spread 挂载。
import { collectPanels, findPane, notifyTerminalLayoutChanged, syncTabTerminalState } from "@/lib/paneTree";
import { resolveLayoutWriteTarget } from "../paneLayoutHelpers";
import type { PanesState } from "../panesStoreTypes";
import { createTab } from "./createTab";
import { findTabAcrossLayouts } from "./crossLayoutSearch";
import { ensureStarredLayoutInDraft } from "./layoutLifecycle";
import type { PanesStoreAccess } from "./storeAccess";

export type TabBasicActions = Pick<
  PanesState,
  | "addTab"
  | "togglePinTab"
  | "toggleStarTab"
  | "openStarredTab"
  | "renameTab"
  | "reorderTabs"
  | "selectTab"
  | "setActivePane"
  | "nextTab"
  | "prevTab"
  | "switchToTab"
  | "minimizeTab"
  | "restoreTab"
  | "setTabDirty"
  | "markTabPoppedOut"
  | "markTabReclaimed"
  | "isTabPoppedOut"
>;

export function createTabBasicActions({ set, get }: PanesStoreAccess): TabBasicActions {
  return {
    addTab: (paneId, opts, layoutId) => {
      set((state) => {
        const target = resolveLayoutWriteTarget(state, layoutId);
        if (!target) return;
        const tree = target.tree;
        const fallbackPaneId = target.isCurrent ? state.activePaneId : "";
        const found = findPane(tree, paneId) ?? findPane(tree, fallbackPaneId);
        // 传入 split id（如壳状态下的 rootPane.id）时兜底到第一个 panel。
        const pane = found?.type === "panel" ? found : collectPanels(tree)[0];
        if (!pane) return;

        const newTab = createTab(opts);
        pane.tabs.push(newTab);
        pane.activeTabId = newTab.id;
      });
      get().autoBindLayoutWorkspaceFromTabs();
    },

    togglePinTab: (paneId, tabId) => {
      set((state) => {
        const pane = findPane(state.rootPane, paneId);
        if (pane?.type !== "panel") return;
        const tab = pane.tabs.find((t) => t.id === tabId);
        if (tab) tab.pinned = !tab.pinned;
      });
    },

    toggleStarTab: (tabId) => {
      set((state) => {
        const location = findTabAcrossLayouts(state, tabId);
        if (!location) return;
        location.tab.starred = !location.tab.starred;
        if (location.tab.starred) {
          ensureStarredLayoutInDraft(state);
        }
      });
    },

    openStarredTab: (tabId) => {
      const location = findTabAcrossLayouts(get(), tabId);
      if (!location) return false;
      get().switchLayout(location.layoutId);
      get().selectTab(location.panel.id, tabId);
      return true;
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

    selectTab: (paneId, tabId) => {
      let changed = false;
      set((state) => {
        const pane = findPane(state.rootPane, paneId);
        if (pane?.type !== "panel") return;
        changed = pane.activeTabId !== tabId || state.activePaneId !== paneId;
        pane.activeTabId = tabId;
        const tab = pane.tabs.find((item) => item.id === tabId);
        if (tab?.contentType === "terminal") {
          syncTabTerminalState(tab);
        }
        state.activePaneId = paneId;
      });
      if (changed) notifyTerminalLayoutChanged("tab.select");
    },

    setActivePane: (paneId) => {
      let changed = false;
      set((state) => {
        if (state.activePaneId === paneId) return;
        const pane = findPane(state.rootPane, paneId);
        if (pane?.type !== "panel") return;
        state.activePaneId = paneId;
        changed = true;
      });
      if (changed) notifyTerminalLayoutChanged("pane.activate");
    },

    nextTab: (paneId) => {
      let changed = false;
      set((state) => {
        const pane = findPane(state.rootPane, paneId);
        if (pane?.type !== "panel" || pane.tabs.length <= 1) return;
        const currentIndex = pane.tabs.findIndex((t) => t.id === pane.activeTabId);
        const nextIndex = (currentIndex + 1) % pane.tabs.length;
        changed = pane.activeTabId !== pane.tabs[nextIndex].id;
        pane.activeTabId = pane.tabs[nextIndex].id;
      });
      if (changed) notifyTerminalLayoutChanged("tab.next");
    },

    prevTab: (paneId) => {
      let changed = false;
      set((state) => {
        const pane = findPane(state.rootPane, paneId);
        if (pane?.type !== "panel" || pane.tabs.length <= 1) return;
        const currentIndex = pane.tabs.findIndex((t) => t.id === pane.activeTabId);
        const prevIndex = (currentIndex - 1 + pane.tabs.length) % pane.tabs.length;
        changed = pane.activeTabId !== pane.tabs[prevIndex].id;
        pane.activeTabId = pane.tabs[prevIndex].id;
      });
      if (changed) notifyTerminalLayoutChanged("tab.prev");
    },

    switchToTab: (paneId, index) => {
      let changed = false;
      set((state) => {
        const pane = findPane(state.rootPane, paneId);
        if (pane?.type !== "panel") return;
        if (index >= 0 && index < pane.tabs.length) {
          changed = pane.activeTabId !== pane.tabs[index].id;
          pane.activeTabId = pane.tabs[index].id;
        }
      });
      if (changed) notifyTerminalLayoutChanged("tab.switch-index");
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

    setTabDirty: (_paneId, tabId, dirty) => {
      set((state) => {
        const location = findTabAcrossLayouts(state, tabId);
        const tab = location?.tab;
        if (tab) tab.dirty = dirty;
      });
    },

    markTabPoppedOut: (tabId) => {
      set({ poppedOutTabs: new Set(get().poppedOutTabs).add(tabId) });
    },

    markTabReclaimed: (tabId) => {
      const next = new Set(get().poppedOutTabs);
      next.delete(tabId);
      set({ poppedOutTabs: next });
      set((state) => {
        // Bump reclaimKey so TerminalView remounts after a popped-out tab returns.
        const location = findTabAcrossLayouts(state, tabId);
        if (location) {
          location.tab.reclaimKey = (location.tab.reclaimKey ?? 0) + 1;
        }
      });
    },

    isTabPoppedOut: (tabId) => get().poppedOutTabs.has(tabId),
  };
}
