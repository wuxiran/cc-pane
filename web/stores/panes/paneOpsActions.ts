// 窗格级操作 actions：closePane / equalizePaneSizes / togglePaneZoom / splitAndDropTab。
// 为「布局操作一等公民」新增（命令注册中心 / pane 头部菜单 / 拖拽落边分屏共用）。
import {
  collectPanels,
  findPane,
  findParent,
  generateId,
  notifyTerminalLayoutChanged,
} from "@/lib/paneTree";
import type { Panel, PaneNode, SplitDirection, Tab } from "@/types";
import type { PanesState } from "../panesStoreTypes";
import type { PanesStoreAccess } from "./storeAccess";

export type PaneOpsActions = Pick<
  PanesState,
  "closePane" | "equalizePaneSizes" | "togglePaneZoom" | "splitAndDropTab"
>;

/** node 子树内是否包含目标 pane（zoom 渲染按层判断哪一支保留可见）。 */
export function subtreeContainsPane(node: PaneNode, paneId: string): boolean {
  if (node.id === paneId) return true;
  if (node.type === "panel") return false;
  return node.children.some((child) => subtreeContainsPane(child, paneId));
}

export function createPaneOpsActions({ set, get }: PanesStoreAccess): PaneOpsActions {
  return {
    closePane: (paneId) => {
      const pane = findPane(get().rootPane, paneId);
      if (pane?.type !== "panel") return;
      const tabIds = pane.tabs.map((tab) => tab.id);
      // 统一销毁出口：资源回收 / closedTabs 快照 / pinned 豁免都走 removeTabsInternal
      // 的既有矩阵（reason "close-pane"），这里不复制任何销毁语义。
      if (tabIds.length > 0) {
        get().removeTabsInternal(tabIds, "close-pane");
      }
      // pinned 豁免后仍有剩余 tab 的 pane 保留；空 pane 走纯树收编（零销毁语义，
      // 会话已在上一步行销毁）。
      const after = findPane(get().rootPane, paneId);
      if (after?.type === "panel" && after.tabs.length === 0) {
        get().removeEmptyPane(paneId);
      }
      if (get().zoomedPaneId === paneId && !findPane(get().rootPane, paneId)) {
        set((state) => {
          state.zoomedPaneId = null;
        });
      }
    },

    equalizePaneSizes: () => {
      let touched = false;
      set((state) => {
        const walk = (node: PaneNode): void => {
          if (node.type !== "split") return;
          node.sizes = node.children.map(() => 100 / node.children.length);
          node.children.forEach(walk);
          touched = true;
        };
        walk(state.rootPane);
      });
      if (touched) notifyTerminalLayoutChanged("pane.equalize");
    },

    togglePaneZoom: (paneId) => {
      const pane = findPane(get().rootPane, paneId);
      if (pane?.type !== "panel") return;
      // 只有一格可见时 zoom 无意义（等于现状），不给状态制造噪音。
      if (collectPanels(get().rootPane).length <= 1) return;
      set((state) => {
        state.zoomedPaneId = state.zoomedPaneId === paneId ? null : paneId;
      });
      // 让幸存终端 refit：隐藏支被挤到 0 宽（isTerminalHostRenderable 的
      // rect.width > 1 守卫会跳过 refit），还原时统一走这条通知。
      notifyTerminalLayoutChanged("pane.zoom");
    },

    splitAndDropTab: (targetPaneId, fromPaneId, tabId, direction: SplitDirection) => {
      // 拖到本 pane 边缘 = 拆自己（splitAndMoveTab 内部对单 tab pane 自然 no-op）。
      if (targetPaneId === fromPaneId) {
        get().splitAndMoveTab(fromPaneId, tabId, direction);
        return;
      }
      // 单 set 原子完成「摘 tab + 目标旁插入新窗格」：不能拆成 split()+moveTab——
      // 无参 split 的新窗格自带一个默认空 Terminal 标签，分两次 set 会让它真实
      // 挂载出 PTY 再被拆掉（生成即杀竞态）。插入逻辑与 split 逐条对齐。
      const splitDirection = direction === "right" ? "horizontal" : "vertical";
      let newPaneId = "";
      let moved = false;
      set((state) => {
        const sourcePane = findPane(state.rootPane, fromPaneId);
        const targetPane = findPane(state.rootPane, targetPaneId);
        if (sourcePane?.type !== "panel" || targetPane?.type !== "panel") return;
        const parentResult = findParent(state.rootPane, targetPaneId);
        if (!parentResult) return;
        const tabIndex = sourcePane.tabs.findIndex((tab) => tab.id === tabId);
        if (tabIndex === -1) return;

        // 复制出 draft 再搬，避免挂着 Immer 代理的孤儿引用（同 splitAndMoveTab）。
        const [draftTab] = sourcePane.tabs.splice(tabIndex, 1);
        const tab: Tab = { ...draftTab };
        if (sourcePane.activeTabId === tabId && sourcePane.tabs.length > 0) {
          const newIdx = Math.min(tabIndex, sourcePane.tabs.length - 1);
          sourcePane.activeTabId = sourcePane.tabs[newIdx].id;
        }

        const newPane: Panel = {
          type: "panel",
          id: generateId("pane"),
          tabs: [tab],
          activeTabId: tab.id,
        };

        if (parentResult.parent === null) {
          state.rootPane = {
            type: "split",
            id: generateId("split"),
            direction: splitDirection,
            children: [targetPane, newPane],
            sizes: [50, 50],
          };
        } else {
          const parent = parentResult.parent;
          const index = parentResult.index;
          if (parent.children.length === 1) {
            parent.direction = splitDirection;
            parent.children.push(newPane);
            parent.sizes = [50, 50];
          } else if (parent.direction === splitDirection) {
            parent.children.splice(index + 1, 0, newPane);
            const newSize = 100 / parent.children.length;
            parent.sizes = parent.children.map(() => newSize);
          } else {
            parent.children[index] = {
              type: "split",
              id: generateId("split"),
              direction: splitDirection,
              children: [targetPane, newPane],
              sizes: [50, 50],
            };
          }
        }

        state.activePaneId = newPane.id;
        newPaneId = newPane.id;
        moved = true;
      });
      if (!moved) return;

      // 源 pane 空壳收编（纯树操作，零销毁语义）；收壳会重算 activePaneId，
      // 焦点恢复给新窗格（与 moveTab 的 restore-target-focus 同口径）。
      const source = findPane(get().rootPane, fromPaneId);
      if (source?.type === "panel" && source.tabs.length === 0) {
        get().removeEmptyPane(fromPaneId);
        const landed = findPane(get().rootPane, newPaneId);
        if (landed?.type === "panel" && landed.tabs.some((tab) => tab.id === tabId)) {
          get().selectTab(newPaneId, tabId);
        }
      }
      notifyTerminalLayoutChanged("tab.split-drop");
    },
  };
}
