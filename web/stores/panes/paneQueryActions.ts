// 只读查询类 store 方法（面板/标签定位、星标收集）。从 usePanesStore.ts 拆出
// （纯代码移动，逻辑不变）；在 usePanesStore 里 spread 挂载。
import { collectPanels, findPane } from "@/lib/paneTree";
import type { Panel } from "@/types";
import { activeLayout, eachLayoutTree } from "../paneLayoutHelpers";
import type { PanesState, StarredTabShortcut } from "../panesStoreTypes";
import { findPaneAcrossLayouts, findTabAcrossLayouts, findTabBySessionAcrossLayouts } from "./crossLayoutSearch";
import type { PanesStoreAccess } from "./storeAccess";

export type PaneQueryActions = Pick<
  PanesState,
  | "allPanels"
  | "allPanelsAcrossLayouts"
  | "activePane"
  | "findPaneById"
  | "findPaneAcrossLayouts"
  | "findTabAcrossLayouts"
  | "findTabBySessionAcrossLayouts"
  | "starredTabs"
>;

export function createPaneQueryActions({ get }: PanesStoreAccess): PaneQueryActions {
  return {
    allPanels: () => collectPanels(get().rootPane),

    allPanelsAcrossLayouts: () => {
      const panels: Panel[] = [];
      eachLayoutTree(get(), (_layout, tree) => {
        panels.push(...collectPanels(tree));
      });
      return panels;
    },

    activePane: () => {
      if (activeLayout(get())?.kind === "starred") return null;
      const pane = findPane(get().rootPane, get().activePaneId);
      return pane?.type === "panel" ? pane : null;
    },

    findPaneById: (paneId) => findPane(get().rootPane, paneId),

    findPaneAcrossLayouts: (paneId) => findPaneAcrossLayouts(get(), paneId),

    findTabAcrossLayouts: (tabId) => findTabAcrossLayouts(get(), tabId),

    findTabBySessionAcrossLayouts: (sessionId) => findTabBySessionAcrossLayouts(get(), sessionId),

    starredTabs: () => {
      const shortcuts: StarredTabShortcut[] = [];
      eachLayoutTree(get(), (layout, tree) => {
        for (const panel of collectPanels(tree)) {
          for (const tab of panel.tabs) {
            if (tab.starred) {
              shortcuts.push({
                layoutId: layout.id,
                layoutName: layout.name,
                paneId: panel.id,
                tab,
              });
            }
          }
        }
      });
      return shortcuts;
    },
  };
}
