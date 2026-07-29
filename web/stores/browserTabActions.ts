import type { Draft } from "immer";

import type { LayoutEntry, PaneNode, Tab } from "@/types";
import { findPane, generateId } from "./paneTreeHelpers";

export interface OpenBrowserOptions {
  /** 落位到指定窗格；缺省或找不到时回落当前活动窗格 */
  paneId?: string;
  /** 已有同 URL 标签时复用并聚焦（默认 true） */
  reuse?: boolean;
}

export interface BrowserTabActions {
  openBrowser: (
    url: string,
    title?: string,
    tabId?: string,
    options?: OpenBrowserOptions,
  ) => string | null;
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

/**
 * URL 归一化——只用于「是不是同一个页面」的判断。
 * 去掉 hash（同页锚点不算另一个页面）与末尾斜杠；其余保持原样，
 * 不动 query，因为 `?id=1` 与 `?id=2` 确实是两个页面。
 */
function sameTarget(a: string, b: string): boolean {
  const normalize = (raw: string) => {
    try {
      const url = new URL(raw);
      url.hash = "";
      const text = url.toString();
      return text.endsWith("/") ? text.slice(0, -1) : text;
    } catch {
      return raw.trim();
    }
  };
  return normalize(a) === normalize(b);
}

/** 在整棵 pane 树里找已打开的同目标浏览器标签 */
function findTabByUrl(
  node: Draft<PaneNode>,
  url: string,
): { paneId: string; tab: Draft<Tab> } | null {
  if (node.type === "panel") {
    const tab = node.tabs.find(
      (item) => item.contentType === "browser" && sameTarget(item.browserUrl ?? "", url),
    );
    return tab ? { paneId: node.id, tab } : null;
  }
  for (const child of node.children) {
    const hit = findTabByUrl(child, url);
    if (hit) return hit;
  }
  return null;
}

export function createBrowserTabActions<T extends BrowserTabState>(
  set: (recipe: (state: Draft<T>) => void) => void,
): BrowserTabActions {
  return {
    openBrowser: (url, title, tabId, options) => {
      const reuse = options?.reuse !== false;
      let actualTabId: string | null = null;
      set((state) => {
        // 1) 复用：同一个页面已经开着就聚焦它，不再堆一个新标签。
        //    这是默认路径——调用方每查一个页面就开一个标签会把版面堆满。
        if (reuse) {
          const existing = findTabByUrl(state.rootPane, url);
          if (existing) {
            const pane = findPane(state.rootPane, existing.paneId);
            if (pane?.type === "panel") {
              pane.activeTabId = existing.tab.id;
              state.activePaneId = pane.id;
              actualTabId = existing.tab.id;
            }
            return;
          }
        }

        // 2) 落位：显式 paneId 优先；无效则回落活动窗格，绝不静默丢弃这次打开。
        const requested = options?.paneId ? findPane(state.rootPane, options.paneId) : null;
        const pane =
          requested?.type === "panel" ? requested : findPane(state.rootPane, state.activePaneId);
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
        state.activePaneId = pane.id;
        actualTabId = newTab.id;
      });
      return actualTabId;
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
