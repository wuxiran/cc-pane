import type { Draft } from "immer";

import type { LayoutEntry, PaneNode, Tab } from "@/types";
import { findPane, generateId } from "./paneTreeHelpers";

export interface BrowserTabActions {
  openBrowser: (url: string, title?: string, tabId?: string) => void;
  updateBrowserTab: (tabId: string, patch: { browserUrl?: string; title?: string }) => void;
}

interface BrowserTabState extends BrowserTabActions {
  rootPane: PaneNode;
  activePaneId: string;
  layouts: LayoutEntry[];
}

function findBrowserTab(node: Draft<PaneNode>, tabId: string): Draft<Tab> | null {
  if (node.type === "panel") {
    return node.tabs.find((tab) => tab.id === tabId && tab.contentType === "browser") ?? null;
  }
  for (const child of node.children) {
    const tab = findBrowserTab(child, tabId);
    if (tab) return tab;
  }
  return null;
}

export function createBrowserTabActions<T extends BrowserTabState>(
  set: (recipe: (state: Draft<T>) => void) => void,
): BrowserTabActions {
  return {
    openBrowser: (url, title, tabId) => {
      set((state) => {
        const pane = findPane(state.rootPane, state.activePaneId);
        if (pane?.type !== "panel") return;
        const newTab: Tab = {
          id: tabId || generateId("tab"),
          title: title?.trim() || "Browser",
          contentType: "browser",
          projectId: "",
          projectPath: "",
          sessionId: null,
          browserUrl: url,
        };
        pane.tabs.push(newTab);
        pane.activeTabId = newTab.id;
      });
    },
    updateBrowserTab: (tabId, patch) => {
      set((state) => {
        const tab =
          findBrowserTab(state.rootPane, tabId) ??
          state.layouts.map((layout) => findBrowserTab(layout.rootPane, tabId)).find(Boolean);
        if (!tab) return;
        if (patch.browserUrl !== undefined) tab.browserUrl = patch.browserUrl;
        if (patch.title !== undefined && patch.title.trim()) tab.title = patch.title.trim();
      });
    },
  };
}
