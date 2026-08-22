import type { Draft } from "immer";

import type { PaneNode, Tab } from "@/types";
import type { PanesDraft } from "./panesStoreTypes";
import { resolveLayoutWriteTarget } from "./paneLayoutHelpers";
import { collectPanels, findPane } from "@/lib/paneTree";
import { createTabOfType } from "@/lib/tabLifecycle/tabFactory";

export interface OpenBrowserOptions {
  /** 落位到指定窗格；缺省或找不到时回落当前活动窗格 */
  paneId?: string;
  /** 已有同 URL 标签时复用并聚焦（默认 true） */
  reuse?: boolean;
  /**
   * 落位到指定布局；缺省 = 当前布局。
   * MCP 调用方（agent）所在布局由此传入——不传就会落进用户此刻正看着的布局，
   * 表现为「标签飞到别的布局去了」。
   */
  layoutId?: string;
}

export interface BrowserTabActions {
  openBrowser: (
    url: string,
    title?: string,
    tabId?: string,
    options?: OpenBrowserOptions,
  ) => string | null;
  updateBrowserTab: (tabId: string, patch: { browserUrl?: string; title?: string }) => void;
  /**
   * 开一个 DeepSeek Harness 标签。
   *
   * 与 openBrowser 的两点不同：**不按 URL 去重**（URL 要等实例起来才知道，
   * 端口由 OS 分配），且带 `projectPath`（dsh 用调用目录作默认工作空间根）
   * 与 `workspacePath`（决定复用哪个 dsh 实例——同工作空间共享一个进程，
   * API key 与会话历史因此跟着工作空间而不是标签）。
   */
  openDsh: (
    projectPath?: string,
    workspacePath?: string,
    options?: OpenBrowserOptions,
  ) => string | null;
}


/**
 * 找一个由 webview 承载的标签。
 *
 * 认 `browser` 与 `dsh` 两种：dsh 标签内部也是 BrowserTabContent 在渲染，
 * 导航回填走同一条 `updateBrowserTab`。只认 browser 会让 dsh 的 URL 回填
 * 静默丢失（找不到就什么都不做），表现为窗格永远停在「正在启动」。
 */
function findBrowserTab(node: Draft<PaneNode>, tabId: string): Draft<Tab> | null {
  if (node.type === "panel") {
    return (
      node.tabs.find(
        (tab) =>
          tab.id === tabId && (tab.contentType === "browser" || tab.contentType === "dsh"),
      ) ?? null
    );
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

export function createBrowserTabActions(
  set: (recipe: (state: PanesDraft) => void) => void,
): BrowserTabActions {
  return {
    openBrowser: (url, title, tabId, options) => {
      const reuse = options?.reuse !== false;
      let actualTabId: string | null = null;
      set((state) => {
        // 0) 先定「写到哪个布局」：目标布局不存在时 resolveLayoutWriteTarget 会退回当前布局。
        const target = resolveLayoutWriteTarget(state, options?.layoutId);
        if (!target) return;
        const tree = target.tree;

        // 1) 复用：同一个页面已经开着就聚焦它，不再堆一个新标签。
        //    这是默认路径——调用方每查一个页面就开一个标签会把版面堆满。
        //    只在目标布局内查重：跨布局复用等于把用户拽走，正是要治的「到处飞」。
        if (reuse) {
          const existing = findTabByUrl(tree, url);
          if (existing) {
            const pane = findPane(tree, existing.paneId);
            if (pane?.type === "panel") {
              pane.activeTabId = existing.tab.id;
              target.setActivePaneId(pane.id);
              actualTabId = existing.tab.id;
            }
            return;
          }
        }

        // 2) 落位：显式 paneId 优先；无效则回落活动窗格，绝不静默丢弃这次打开。
        const requested = options?.paneId ? findPane(tree, options.paneId) : null;
        const fallbackPaneId = target.isCurrent ? state.activePaneId : "";
        const found =
          requested?.type === "panel" ? requested : findPane(tree, fallbackPaneId);
        const pane = found?.type === "panel" ? found : collectPanels(tree)[0];
        if (pane?.type !== "panel") return;

        // 差异保留（docs/78 批4）：id 由调用方指定——弹出/重开等入口要求
        // webview 键与 tabId 同源，不能让工厂另生成一个。
        const newTab = createTabOfType("browser", {
          id: tabId,
          title,
          browserUrl: url,
        });
        pane.tabs.push(newTab);
        pane.activeTabId = newTab.id;
        target.setActivePaneId(pane.id);
        actualTabId = newTab.id;
      });
      return actualTabId;
    },
    openDsh: (projectPath, workspacePath, options) => {
      let actualTabId: string | null = null;
      set((state) => {
        const target = resolveLayoutWriteTarget(state, options?.layoutId);
        if (!target) return;
        const tree = target.tree;

        // 落位规则与 openBrowser 一致：显式 paneId 优先，无效则回落活动窗格。
        const requested = options?.paneId ? findPane(tree, options.paneId) : null;
        const fallbackPaneId = target.isCurrent ? state.activePaneId : "";
        const found =
          requested?.type === "panel" ? requested : findPane(tree, fallbackPaneId);
        const pane = found?.type === "panel" ? found : collectPanels(tree)[0];
        if (pane?.type !== "panel") return;

        // 不带 browserUrl：端口由 OS 分配，窗格拉起实例后才回填。
        const newTab = createTabOfType("dsh", { projectPath, workspacePath });
        pane.tabs.push(newTab);
        pane.activeTabId = newTab.id;
        target.setActivePaneId(pane.id);
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
