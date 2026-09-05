// 终端 leaf 结构 actions：session/launchId 写入、launch 错误与重试、tab 内分屏、
// 断连标记、restoring 清理。从 usePanesStore.ts 拆出（纯代码移动，逻辑不变）；
// 在 usePanesStore 里 spread 挂载。
import {
  assignTreeAndConvergeActive,
  closeTabInTree,
  closeTerminalLeafInTab,
  findTabLocation,
  findTerminalPaneParent,
  generateId,
  notifyTerminalLayoutChanged,
  syncTabTerminalState,
} from "@/lib/paneTree";
import { collectTerminalLeaves, findTerminalPane } from "@/lib/paneSessions";
import {
  resetTerminalLeafForRelaunch,
  stripInitialPrompt,
} from "@/lib/tabLifecycle/terminalLeafReset";
import type { SplitDirection, TerminalPaneLeaf } from "@/types";
import type { PanesState } from "../panesStoreTypes";
import { findTabAcrossLayouts } from "./crossLayoutSearch";
import { findLayout } from "./layoutTraversal";
import type { PanesStoreAccess } from "./storeAccess";

/**
 * 分屏克隆。重置清单的唯一真身在 `lib/tabLifecycle/terminalLeafReset`
 * （关闭撤销的树回放共用同一份，docs/78 批4）。
 */
function cloneTerminalLeaf(source: TerminalPaneLeaf): TerminalPaneLeaf {
  return resetTerminalLeafForRelaunch(source);
}

export type TerminalLeafActions = Pick<
  PanesState,
  | "updateTabSession"
  | "updateTerminalLaunchId"
  | "setTerminalLaunchError"
  | "retryTerminalLaunch"
  | "removeTerminalLaunch"
  | "setActiveTerminalPane"
  | "splitTerminalPane"
  | "resizeTerminalPanes"
  | "setTabDisconnected"
  | "clearRestoring"
  | "clearTabInitialPrompt"
  | "setTerminalRestoreBlocked"
>;

export function createTerminalLeafActions({ set }: PanesStoreAccess): TerminalLeafActions {
  return {
    updateTabSession: (_paneId, tabId, sessionId, terminalPaneId) => {
      set((state) => {
        const location = findTabAcrossLayouts(state, tabId);
        if (!location) return;
        const { tab } = location;
        if (tab.contentType !== "terminal") {
          tab.sessionId = sessionId;
          return;
        }
        syncTabTerminalState(tab);
        const leafId = terminalPaneId ?? tab.activeTerminalPaneId;
        const leaf = leafId && tab.terminalRootPane
          ? findTerminalPane(tab.terminalRootPane, leafId)
          : null;
        if (leaf?.type !== "leaf") return;
        leaf.sessionId = sessionId;
        leaf.launchError = undefined;
        syncTabTerminalState(tab);
      });
      // 写入会话 sessionId 也要落快照——否则手机镜像看不到新会话，直到 60s 兜底保存。
      notifyTerminalLayoutChanged("session.update");
    },

    updateTerminalLaunchId: (tabId, terminalPaneId, launchId) => {
      set((state) => {
        const location = findTabAcrossLayouts(state, tabId);
        if (!location || location.tab.contentType !== "terminal" || !location.tab.terminalRootPane) return;
        const leaf = findTerminalPane(location.tab.terminalRootPane, terminalPaneId);
        if (leaf?.type !== "leaf") return;
        leaf.launchId = launchId;
        syncTabTerminalState(location.tab);
      });
      notifyTerminalLayoutChanged("launch-id.update");
    },

    setTerminalLaunchError: (tabId, terminalPaneId, error) => {
      set((state) => {
        const location = findTabAcrossLayouts(state, tabId);
        if (!location || location.tab.contentType !== "terminal" || !location.tab.terminalRootPane) return;
        const leaf = findTerminalPane(location.tab.terminalRootPane, terminalPaneId);
        if (leaf?.type !== "leaf" || leaf.sessionId) return;
        leaf.launchError = error;
        syncTabTerminalState(location.tab);
      });
      notifyTerminalLayoutChanged("terminal.launch-error");
    },

    retryTerminalLaunch: (tabId, terminalPaneId) => {
      set((state) => {
        const location = findTabAcrossLayouts(state, tabId);
        if (!location || location.tab.contentType !== "terminal" || !location.tab.terminalRootPane) return;
        const leaf = findTerminalPane(location.tab.terminalRootPane, terminalPaneId);
        if (leaf?.type !== "leaf") return;
        leaf.launchError = undefined;
        leaf.launchAttempt = (leaf.launchAttempt ?? 0) + 1;
        syncTabTerminalState(location.tab);
      });
      notifyTerminalLayoutChanged("terminal.launch-retry");
    },

    removeTerminalLaunch: (tabId, terminalPaneId) => {
      set((state) => {
        const location = findTabAcrossLayouts(state, tabId);
        if (!location || location.tab.contentType !== "terminal") return;
        if (closeTerminalLeafInTab(location.tab, terminalPaneId)) return;
        if (location.tab.pinned) return;

        const isCurrent = location.layoutId === state.currentLayoutId;
        const nextTree = closeTabInTree(location.tree, location.panel.id, tabId);
        const holder = isCurrent
          ? state
          : findLayout(state.layouts, (item) => item.id === location.layoutId);
        if (!holder) return;
        assignTreeAndConvergeActive(holder, nextTree);
      });
      notifyTerminalLayoutChanged("terminal.launch-remove");
    },

    setActiveTerminalPane: (tabId, terminalPaneId) => {
      set((state) => {
        const location = findTabLocation(state.rootPane, tabId);
        if (!location) return;
        const { tab } = location;
        if (tab.contentType !== "terminal" || !tab.terminalRootPane) return;
        if (!findTerminalPane(tab.terminalRootPane, terminalPaneId)) return;
        tab.activeTerminalPaneId = terminalPaneId;
        syncTabTerminalState(tab);
      });
    },

    splitTerminalPane: (tabId, terminalPaneId, direction) => {
      const directionMap: Record<SplitDirection, "horizontal" | "vertical"> = {
        right: "horizontal",
        down: "vertical",
      };
      set((state) => {
        const location = findTabLocation(state.rootPane, tabId);
        if (!location) return;
        const { tab } = location;
        if (tab.contentType !== "terminal" || !tab.terminalRootPane) return;
        const target = findTerminalPane(tab.terminalRootPane, terminalPaneId);
        if (target?.type !== "leaf") return;

        const newLeaf = cloneTerminalLeaf(target);
        const splitDirection = directionMap[direction];
        const parentResult = findTerminalPaneParent(tab.terminalRootPane, terminalPaneId);

        if (!parentResult || parentResult.parent === null) {
          tab.terminalRootPane = {
            type: "split",
            id: generateId("terminal-split"),
            direction: splitDirection,
            children: [target, newLeaf],
            sizes: [50, 50],
          };
        } else if (parentResult.parent.children.length === 1) {
          // 单 child 壳复用，理由同 split()。
          parentResult.parent.direction = splitDirection;
          parentResult.parent.children.push(newLeaf);
          parentResult.parent.sizes = [50, 50];
        } else if (parentResult.parent.direction === splitDirection) {
          parentResult.parent.children.splice(parentResult.index + 1, 0, newLeaf);
          const newSize = 100 / parentResult.parent.children.length;
          parentResult.parent.sizes = parentResult.parent.children.map(() => newSize);
        } else {
          parentResult.parent.children[parentResult.index] = {
            type: "split",
            id: generateId("terminal-split"),
            direction: splitDirection,
            children: [target, newLeaf],
            sizes: [50, 50],
          };
        }

        tab.activeTerminalPaneId = newLeaf.id;
        syncTabTerminalState(tab);
      });
      notifyTerminalLayoutChanged("terminal.split");
    },

    resizeTerminalPanes: (tabId, terminalPaneId, sizes) => {
      set((state) => {
        const location = findTabLocation(state.rootPane, tabId);
        if (!location) return;
        const { tab } = location;
        if (tab.contentType !== "terminal" || !tab.terminalRootPane) return;
        const split = findTerminalPane(tab.terminalRootPane, terminalPaneId);
        if (split?.type === "split") {
          split.sizes = sizes;
        }
      });
      notifyTerminalLayoutChanged("terminal.resize");
    },

    setTabDisconnected: (_paneId, tabId, disconnected, terminalPaneId) => {
      set((state) => {
        const location = findTabAcrossLayouts(state, tabId);
        const tab = location?.tab;
        if (!tab) return;
        if (tab.contentType === "terminal" && tab.terminalRootPane) {
          const leafId = terminalPaneId ?? tab.activeTerminalPaneId;
          const leaf = leafId ? findTerminalPane(tab.terminalRootPane, leafId) : null;
          if (leaf?.type === "leaf") {
            leaf.disconnected = disconnected;
          }
          syncTabTerminalState(tab);
        } else {
          tab.disconnected = disconnected;
        }
        // 更新标题：断连时加闪电，重连时移除
        if (tab.ssh && tab.machineName) {
          const name = tab.projectPath.split(/[/\\]/).pop() || "Terminal";
          if (disconnected) {
            tab.title = `[${tab.machineName}] \u26A1 ${name}`;
          } else {
            tab.title = `[${tab.machineName}] ${name}`;
          }
        }
      });
    },

    clearRestoring: (_paneId, tabId, terminalPaneId) => {
      set((state) => {
        const location = findTabAcrossLayouts(state, tabId);
        const tab = location?.tab;
        if (tab) {
          if (tab.contentType === "terminal" && tab.terminalRootPane) {
            const leaf = findTerminalPane(tab.terminalRootPane, terminalPaneId ?? tab.activeTerminalPaneId ?? "");
            if (leaf?.type === "leaf") {
              leaf.restoring = false;
              leaf.savedSessionId = undefined;
              leaf.restoreBlockedReason = undefined;
              leaf.leaseReadOnly = false;
            }
            syncTabTerminalState(tab);
          } else {
            tab.restoring = false;
            tab.savedSessionId = undefined;
          }
        }
      });
    },

    clearTabInitialPrompt: (tabId) => {
      set((state) => {
        const location = findTabAcrossLayouts(state, tabId);
        const tab = location?.tab;
        if (!tab) return;
        tab.launchExtras = stripInitialPrompt(tab.launchExtras);
        if (tab.terminalRootPane) {
          for (const leaf of collectTerminalLeaves(tab.terminalRootPane)) {
            leaf.launchExtras = stripInitialPrompt(leaf.launchExtras);
          }
        }
      });
    },

    setTerminalRestoreBlocked: (tabId, terminalPaneId, reason, sessionId) => {
      set((state) => {
        const location = findTabAcrossLayouts(state, tabId);
        const tab = location?.tab;
        if (!tab || tab.contentType !== "terminal" || !tab.terminalRootPane) return;
        const leaf = findTerminalPane(tab.terminalRootPane, terminalPaneId);
        if (leaf?.type !== "leaf") return;
        leaf.restoreBlockedReason = reason;
        // 解除阻断时一并清掉候选，避免下一次阻断沿用上一轮的会话 id。
        leaf.restoreBlockedSessionId = reason ? sessionId : undefined;
        syncTabTerminalState(tab);
      });
    },
  };
}
