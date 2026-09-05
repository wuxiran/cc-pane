// 跨布局查找纯函数（当前布局工作副本 + 各布局树）。从 usePanesStore.ts 拆出
// （纯代码移动，逻辑不变）；store 方法与各 action 工厂共用同一份实现。
import { collectPanels, findPane, findTabLocation, findSessionInTab } from "@/lib/paneTree";
import { eachLayoutTree } from "../paneLayoutHelpers";
import type {
  DraftTabAcrossLayoutsLocation,
  PaneAcrossLayoutsLocation,
  PanesDraft,
  PanesState,
  TabAcrossLayoutsLocation,
} from "../panesStoreTypes";

export function findTabAcrossLayouts(state: PanesState, tabId: string): TabAcrossLayoutsLocation | null;
export function findTabAcrossLayouts(state: PanesDraft, tabId: string): DraftTabAcrossLayoutsLocation | null;
export function findTabAcrossLayouts(
  state: PanesState | PanesDraft,
  tabId: string
): TabAcrossLayoutsLocation | DraftTabAcrossLayoutsLocation | null {
  let found: TabAcrossLayoutsLocation | DraftTabAcrossLayoutsLocation | null = null;
  eachLayoutTree(state as PanesState, (layout, tree) => {
    if (found) return;
    const location = findTabLocation(tree, tabId);
    if (location) {
      found = {
        layoutId: layout.id,
        layoutName: layout.name,
        tree,
        panel: location.panel,
        tab: location.tab,
      };
    }
  });
  return found;
}

export function findTabBySessionAcrossLayouts(state: PanesState, sessionId: string): TabAcrossLayoutsLocation | null {
  let found: TabAcrossLayoutsLocation | null = null;
  eachLayoutTree(state, (layout, tree) => {
    if (found) return;
    for (const panel of collectPanels(tree)) {
      const tab = panel.tabs.find((item) => Boolean(findSessionInTab(item, sessionId)));
      if (tab) {
        found = {
          layoutId: layout.id,
          layoutName: layout.name,
          tree,
          panel,
          tab,
        };
        return;
      }
    }
  });
  return found;
}

export function findPaneAcrossLayouts(state: PanesState, paneId: string): PaneAcrossLayoutsLocation | null {
  let found: PaneAcrossLayoutsLocation | null = null;
  eachLayoutTree(state, (layout, tree) => {
    if (found) return;
    const pane = findPane(tree, paneId);
    if (pane) {
      found = {
        layoutId: layout.id,
        tree,
        pane,
      };
    }
  });
  return found;
}
