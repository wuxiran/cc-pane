// 标签移动 actions：moveTab / moveTabToLayoutPane / splitAndMoveTab。
// 从 usePanesStore.ts 拆出（纯代码移动，逻辑不变）；在 usePanesStore 里 spread 挂载。
import {
  collectPanels,
  findPane,
  findParent,
  generateId,
  notifyTerminalLayoutChanged,
} from "@/lib/paneTree";
import type { Panel, SplitDirection, Tab } from "@/types";
import { isStarredLayout, layoutTree, syncWorkingCopyToCurrentLayout } from "../paneLayoutHelpers";
import type { PanesState } from "../panesStoreTypes";
import { findTabAcrossLayouts } from "./crossLayoutSearch";
import { findLayout } from "./layoutTraversal";
import { debugPanes, summarizePanel } from "./panesDebug";
import type { PanesStoreAccess } from "./storeAccess";

export type TabMoveActions = Pick<
  PanesState,
  "moveTab" | "moveTabToLayoutPane" | "splitAndMoveTab"
>;

export function createTabMoveActions({ set, get }: PanesStoreAccess): TabMoveActions {
  return {
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

      // 收空壳只能用 removeEmptyPane：带销毁语义的出口会回收 pane 内的 tab，
      // 而这里 tab 已搬到别处——借道它等于拖一下标签就杀掉自己的会话。
      const fromPane = findPane(get().rootPane, fromPaneId);
      if (fromPane?.type === "panel" && fromPane.tabs.length === 0) {
        debugPanes("moveTab.close-empty-pane", {
          paneId: fromPaneId,
          tabId,
        });
        get().removeEmptyPane(fromPaneId);

        const targetPane = findPane(get().rootPane, toPaneId);
        if (targetPane?.type === "panel" && targetPane.tabs.some((t) => t.id === tabId)) {
          debugPanes("moveTab.restore-target-focus", {
            paneId: toPaneId,
            tabId,
          });
          get().selectTab(toPaneId, tabId);
        }
      }
      notifyTerminalLayoutChanged("tab.move");
    },

    moveTabToLayoutPane: (fromPaneId, toLayoutId, tabId, toPaneId, toIndex?) => {
      let moved = false;
      let closeEmptyCurrentSource = false;

      set((state) => {
        syncWorkingCopyToCurrentLayout(state);

        const targetLayout = findLayout(state.layouts, (layout) => layout.id === toLayoutId);
        if (!targetLayout || isStarredLayout(targetLayout)) return;

        const targetTree = layoutTree(state, toLayoutId);
        if (!targetTree) return;

        const targetPanels = collectPanels(targetTree);
        const targetPaneId = toPaneId ?? targetPanels[0]?.id;
        if (!targetPaneId) return;

        const targetPane = findPane(targetTree, targetPaneId);
        if (targetPane?.type !== "panel") return;

        const sourceLocation = findTabAcrossLayouts(state, tabId);
        if (!sourceLocation || sourceLocation.panel.id !== fromPaneId) return;
        if (sourceLocation.layoutId === toLayoutId && sourceLocation.panel.id === targetPane.id) return;

        const tabIndex = sourceLocation.panel.tabs.findIndex((tab) => tab.id === tabId);
        if (tabIndex === -1) return;

        const [tab] = sourceLocation.panel.tabs.splice(tabIndex, 1);
        const insertAt =
          toIndex !== undefined && toIndex >= 0
            ? Math.min(toIndex, targetPane.tabs.length)
            : targetPane.tabs.length;
        targetPane.tabs.splice(insertAt, 0, tab);
        targetPane.activeTabId = tab.id;
        targetLayout.activePaneId = targetPane.id;

        if (toLayoutId === state.currentLayoutId) {
          state.activePaneId = targetPane.id;
        }

        if (sourceLocation.panel.tabs.length > 0) {
          const nextIndex = Math.min(tabIndex, sourceLocation.panel.tabs.length - 1);
          sourceLocation.panel.activeTabId = sourceLocation.panel.tabs[nextIndex].id;
          const sourceLayout = findLayout(state.layouts, (layout) => layout.id === sourceLocation.layoutId);
          if (sourceLayout) {
            sourceLayout.activePaneId = sourceLocation.panel.id;
          }
          if (sourceLocation.layoutId === state.currentLayoutId && toLayoutId !== state.currentLayoutId) {
            state.activePaneId = sourceLocation.panel.id;
          }
        } else if (sourceLocation.layoutId === state.currentLayoutId) {
          closeEmptyCurrentSource = true;
        }

        moved = true;
      });

      if (!moved) return;

      // 同 moveTab：源 pane 是空壳，只收树不碰会话。
      if (closeEmptyCurrentSource) {
        get().removeEmptyPane(fromPaneId);
      }
      notifyTerminalLayoutChanged("tab.move-layout");
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
      notifyTerminalLayoutChanged("tab.split-move");
    },
  };
}
