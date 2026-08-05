// 分屏区 pane / tab 的关闭与移除（docs/78 批1 · B1-03）。
//
// 从 usePanesStore.ts 拆出（该文件已触到行数棘轮上限，见 web/test/lineRatchet.test.ts），
// 与 editorTabActions.ts 同一套路：createPaneRemovalActions(set, get) 工厂，
// 在 usePanesStore 里 spread 挂载。
//
// 两组成员：
// 1. 六个既有出口（closeTab / closeTabsToLeft / closeTabsToRight / closeOtherTabs /
//    closePane / closeTerminalPane）——**原样搬家，行为零变化**，后续 B1-04+ 逐个改道；
// 2. 三个新出口骨架（removeTabsInternal / removeTerminalLeafInternal / removeEmptyPane）
//    ——树操作已实现，**资源回收（detach/kill/关弹窗/onClosed）留 TODO**，由
//    destroyPipeline（轨 A / B1-02）在改道 commit 接入。本 commit 无任何调用方。
import { DESTROY_POLICY } from "@/lib/tabLifecycle/destroyPipeline";
import type { DestroyReason } from "@/lib/tabLifecycle/destroyPipeline";
import { collectTerminalLeaves } from "@/lib/paneSessions";
import type {
  ClosedTabSnapshot,
  PanesDraft,
  PanesState,
  RemoveTabsInternalOptions,
} from "./panesStoreTypes";
import { trimClosedTabs } from "./closedTabsCap";
import {
  closeTabInTree,
  collectPanels,
  createPanel,
  findPane,
  findParent,
  findTabLocation,
  normalizePaneTree,
  notifyTerminalLayoutChanged,
} from "./paneTreeHelpers";
import {
  closeTerminalLeafInTab,
  findTerminalPaneParent,
  syncTabTerminalState,
} from "./paneTreeRemovalHelpers";
import { useFullscreenStore } from "./useFullscreenStore";

export interface PaneRemovalActions {
  closePane: (paneId: string) => void;
  closeTab: (paneId: string, tabId: string) => void;
  closeTabsToLeft: (paneId: string, tabId: string) => void;
  closeTabsToRight: (paneId: string, tabId: string) => void;
  closeOtherTabs: (paneId: string, tabId: string) => void;
  closeTerminalPane: (tabId: string, terminalPaneId: string) => void;
  removeTabsInternal: (
    tabIds: string[],
    reason: DestroyReason,
    opts?: RemoveTabsInternalOptions,
  ) => void;
  removeTerminalLeafInternal: (
    tabId: string,
    terminalPaneId: string,
    reason: DestroyReason,
  ) => void;
  removeEmptyPane: (paneId: string) => void;
}

/** closeTab / closePane 记入 closedTabs 的快照映射（两处共用，字段一字不差） */
function toClosedTabSnapshot(t: {
  projectId: string;
  projectPath: string;
  title: string;
  resumeId?: string;
  workspaceName?: string;
  providerId?: string;
  modelId?: string;
  providerSelection?: ClosedTabSnapshot["providerSelection"];
  launchProfileId?: string;
  workspacePath?: string;
  workspaceSnapshotId?: string;
  launchClaude?: boolean;
  cliTool?: ClosedTabSnapshot["cliTool"];
  ssh?: ClosedTabSnapshot["ssh"];
  wsl?: ClosedTabSnapshot["wsl"];
  machineName?: string;
}): ClosedTabSnapshot {
  return {
    projectId: t.projectId,
    projectPath: t.projectPath,
    title: t.title,
    resumeId: t.resumeId,
    workspaceName: t.workspaceName,
    providerId: t.providerId,
    modelId: t.modelId,
    providerSelection: t.providerSelection,
    launchProfileId: t.launchProfileId,
    workspacePath: t.workspacePath,
    workspaceSnapshotId: t.workspaceSnapshotId,
    launchClaude: t.launchClaude,
    cliTool: t.cliTool,
    ssh: t.ssh,
    wsl: t.wsl,
    machineName: t.machineName,
  };
}

export function createPaneRemovalActions(
  set: (recipe: (state: PanesDraft) => void) => void,
  get: () => PanesState,
): PaneRemovalActions {
  return {
    closePane: (paneId) => {
      // 保存可恢复标签
      const closingPane = findPane(get().rootPane, paneId);
      if (closingPane?.type === "panel") {
        const recoverableTabs: ClosedTabSnapshot[] = closingPane.tabs
          .filter((t) => t.projectPath && t.contentType === "terminal")
          .map((t) => toClosedTabSnapshot(t));
        if (recoverableTabs.length > 0) {
          set((state) => {
            state.closedTabs.push(...recoverableTabs);
          });
        }
      }

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
        parent.sizes = total > 0
          ? parent.sizes.map((s) => (s / total) * 100)
          : parent.sizes.map(() => 100 / parent.sizes.length);

        if (parent.children.length > 0) {
          const newIndex = Math.min(index, parent.children.length - 1);
          const nextPane = parent.children[newIndex];
          const panels = collectPanels(nextPane);
          if (panels.length > 0) {
            state.activePaneId = panels[0].id;
          }
        }

        state.rootPane = normalizePaneTree(state.rootPane);
        const activePane = findPane(state.rootPane, state.activePaneId);
        if (activePane?.type !== "panel") {
          const panels = collectPanels(state.rootPane);
          if (panels.length > 0) {
            state.activePaneId = panels[0].id;
          }
        }
      });
      notifyTerminalLayoutChanged("pane.close");
    },

    closeTab: (paneId, tabId) => {
      const snapshot = get();
      const snapPane = findPane(snapshot.rootPane, paneId);
      if (snapPane?.type !== "panel") return;
      const snapTab = snapPane.tabs.find((t) => t.id === tabId);
      if (!snapTab || snapTab.pinned) return;

      // 保存可恢复标签
      if (snapTab.projectPath && snapTab.contentType === "terminal") {
        set((state) => {
          state.closedTabs.push(toClosedTabSnapshot(snapTab));
        });
      }

      if (snapPane.tabs.length <= 1) {
        get().closePane(paneId);
        return;
      }

      set((state) => {
        const p = findPane(state.rootPane, paneId);
        if (p?.type !== "panel") return;

        const idx = p.tabs.findIndex((t) => t.id === tabId);
        if (idx === -1) return;
        if (p.tabs[idx].pinned) return;
        if (p.tabs.length <= 1) return;

        p.tabs.splice(idx, 1);
        if (p.activeTabId === tabId) {
          const newIdx = Math.min(idx, p.tabs.length - 1);
          p.activeTabId = p.tabs[newIdx].id;
        }
      });
    },

    closeTabsToLeft: (paneId, tabId) => {
      const snapshot = get();
      const snapPane = findPane(snapshot.rootPane, paneId);
      if (snapPane?.type !== "panel") return;
      const targetIdx = snapPane.tabs.findIndex((t) => t.id === tabId);
      if (targetIdx <= 0) return;

      const toClose = snapPane.tabs.slice(0, targetIdx).filter((t) => !t.pinned);
      if (toClose.length === 0) return;

      set((state) => {
        const p = findPane(state.rootPane, paneId);
        if (p?.type !== "panel") return;
        const closeIds = new Set(toClose.map((t) => t.id));
        p.tabs = p.tabs.filter((t) => !closeIds.has(t.id));
        if (p.activeTabId && closeIds.has(p.activeTabId)) {
          p.activeTabId = tabId;
        }
      });

      // Close the pane if every tab was removed.
      const afterPane = findPane(get().rootPane, paneId);
      if (afterPane?.type === "panel" && afterPane.tabs.length === 0) {
        get().closePane(paneId);
      }
    },

    closeTabsToRight: (paneId, tabId) => {
      const snapshot = get();
      const snapPane = findPane(snapshot.rootPane, paneId);
      if (snapPane?.type !== "panel") return;
      const targetIdx = snapPane.tabs.findIndex((t) => t.id === tabId);
      if (targetIdx === -1 || targetIdx >= snapPane.tabs.length - 1) return;

      const toClose = snapPane.tabs.slice(targetIdx + 1).filter((t) => !t.pinned);
      if (toClose.length === 0) return;

      set((state) => {
        const p = findPane(state.rootPane, paneId);
        if (p?.type !== "panel") return;
        const closeIds = new Set(toClose.map((t) => t.id));
        p.tabs = p.tabs.filter((t) => !closeIds.has(t.id));
        if (p.activeTabId && closeIds.has(p.activeTabId)) {
          p.activeTabId = tabId;
        }
      });

      const afterPane = findPane(get().rootPane, paneId);
      if (afterPane?.type === "panel" && afterPane.tabs.length === 0) {
        get().closePane(paneId);
      }
    },

    closeOtherTabs: (paneId, tabId) => {
      const snapshot = get();
      const snapPane = findPane(snapshot.rootPane, paneId);
      if (snapPane?.type !== "panel") return;

      const toClose = snapPane.tabs.filter((t) => t.id !== tabId && !t.pinned);
      if (toClose.length === 0) return;

      set((state) => {
        const p = findPane(state.rootPane, paneId);
        if (p?.type !== "panel") return;
        const closeIds = new Set(toClose.map((t) => t.id));
        p.tabs = p.tabs.filter((t) => !closeIds.has(t.id));
        if (p.activeTabId && closeIds.has(p.activeTabId)) {
          p.activeTabId = tabId;
        }
      });

      const afterPane = findPane(get().rootPane, paneId);
      if (afterPane?.type === "panel" && afterPane.tabs.length === 0) {
        get().closePane(paneId);
      }
    },

    closeTerminalPane: (tabId, terminalPaneId) => {
      set((state) => {
        const location = findTabLocation(state.rootPane, tabId);
        if (!location) return;
        const { tab } = location;
        if (tab.contentType !== "terminal" || !tab.terminalRootPane) return;

        const leaves = collectTerminalLeaves(tab.terminalRootPane);
        if (leaves.length <= 1) return;

        const parentResult = findTerminalPaneParent(tab.terminalRootPane, terminalPaneId);
        if (!parentResult) return;

        if (parentResult.parent === null) {
          return;
        }

        const parent = parentResult.parent;
        parent.children.splice(parentResult.index, 1);
        parent.sizes.splice(parentResult.index, 1);

        // 单 child 时保留 split 壳（不上提），避免幸存终端 remount；见 normalizePaneTree。
        const total = parent.sizes.reduce((sum, size) => sum + size, 0);
        parent.sizes = total > 0
          ? parent.sizes.map((size) => (size / total) * 100)
          : parent.children.map(() => 100 / parent.children.length);

        const nextLeaves = collectTerminalLeaves(tab.terminalRootPane);
        tab.activeTerminalPaneId = nextLeaves[Math.min(parentResult.index, nextLeaves.length - 1)]?.id;
        syncTabTerminalState(tab);
      });
      notifyTerminalLayoutChanged("terminal.close");
    },

    // ============ 以下为 B1-03 新出口骨架（暂无调用方，B1-04+ 逐出口改道接入） ============

    removeTabsInternal: (tabIds, reason, _opts) => {
      // 唯一逐-tab 销毁出口（目标态）。本骨架只做：树 splice → closedTabs(cap 20)
      // → poppedOut / fullscreen 附属清理。幂等：找不到的 tabId 静默跳过。
      //
      // TODO(B1-04+，回收管线接入): 在树 splice **之前**重定位重收集资源
      // （collectTerminalSessionIdsWithSaved 全量 + poppedOut），调
      // destroyPipeline.commitResourceDestroy(tabs, reason, { protectSessionIds:
      // opts?.protectSessionIds })——plan 只存 tabId 不存 Tab 引用，commit 时重收集
      // （确认弹窗窗口期树可能变化）。多杀/少杀断言全部打在本出口。
      if (tabIds.length === 0) return;
      const policy = DESTROY_POLICY[reason];
      const removedIds = new Set<string>();

      set((state) => {
        for (const tabId of tabIds) {
          // 不用 eachLayoutTree：它跳过星标布局，而星标布局里的标签同样要能移除
          // （与 closeTabBySessionId 同理）。当前布局的活树在工作副本 state.rootPane 上。
          for (const layout of state.layouts) {
            const isCurrent = layout.id === state.currentLayoutId;
            const tree = isCurrent ? state.rootPane : layout.rootPane;
            if (!tree) continue;
            const location = findTabLocation(tree, tabId);
            if (!location) continue;
            const { panel, tab } = location;
            if (policy.respectsPinned && tab.pinned) continue;

            if (
              policy.recordsClosedTabs
              && tab.projectPath
              && tab.contentType === "terminal"
            ) {
              state.closedTabs.push(toClosedTabSnapshot(tab));
            }

            // pinned 语义已在上面按矩阵判过，这里恒 force。
            const nextTree = closeTabInTree(tree, panel.id, tabId, true);
            if (isCurrent) {
              state.rootPane = nextTree;
              const activePane = findPane(state.rootPane, state.activePaneId);
              if (activePane?.type !== "panel") {
                state.activePaneId = collectPanels(state.rootPane)[0]?.id ?? state.rootPane.id;
              }
            } else {
              layout.rootPane = nextTree;
              const activePane = findPane(layout.rootPane, layout.activePaneId);
              if (activePane?.type !== "panel") {
                layout.activePaneId = collectPanels(layout.rootPane)[0]?.id ?? layout.rootPane.id;
              }
            }
            removedIds.add(tabId);
            // tab id 理论上全局唯一，但历史快照互覆盖出现过跨布局同 id（见
            // attachSessionToAnchor 注释）——继续扫完其余布局，保证移除干净。
          }
        }
        if (removedIds.size > 0) {
          trimClosedTabs(state.closedTabs);
        }
      });

      if (removedIds.size === 0) return;

      // 附属状态清理（store 侧两份真相；popupWindowService 侧与窗口关闭属回收管线，见上方 TODO）
      const popped = get().poppedOutTabs;
      const stalePopped = [...removedIds].filter((id) => popped.has(id));
      if (stalePopped.length > 0) {
        const next = new Set(popped);
        for (const id of stalePopped) next.delete(id);
        set((state) => {
          state.poppedOutTabs = next;
        });
      }
      const fullscreen = useFullscreenStore.getState();
      if (fullscreen.fullscreenTabId && removedIds.has(fullscreen.fullscreenTabId)) {
        void fullscreen.exitFullscreen();
      }
      notifyTerminalLayoutChanged("tab.remove");
    },

    removeTerminalLeafInternal: (tabId, terminalPaneId, _reason) => {
      // 「关一格」：分屏 tab 里关掉一个终端 leaf（树操作与 closeTerminalPane 同实现）。
      //
      // TODO(B1-07，回收接入): 树 splice 前在本出口内重新定位 leaf，按
      // `sessionId ?? savedSessionId` 走 destroyPipeline kill（开放问题1 取 Codex
      // 倾向 B，不复用 findActiveTerminalSessionId）。最后一个 leaf 不在这里关——
      // 调用方应改走 removeTabsInternal 关整个 tab。
      let changed = false;
      set((state) => {
        for (const layout of state.layouts) {
          const isCurrent = layout.id === state.currentLayoutId;
          const tree = isCurrent ? state.rootPane : layout.rootPane;
          if (!tree) continue;
          const location = findTabLocation(tree, tabId);
          if (!location) continue;
          // closeTerminalLeafInTab 对最后一个 leaf / 根 leaf 返回 false（保持 no-op）
          changed = closeTerminalLeafInTab(location.tab, terminalPaneId);
          return;
        }
      });
      if (changed) notifyTerminalLayoutChanged("terminal.close");
    },

    removeEmptyPane: (paneId) => {
      // 纯树操作，**零销毁语义**：专供 moveTab / moveTabToLayoutPane 在 tab 搬走后
      // 收掉留下的空壳（B1-05 改道）。它们的 pane 里已经没有任何 tab，绝不能借道
      // closePane 沾上未来的杀会话副作用——非空即拒是硬守卫，不是防御式冗余。
      const pane = findPane(get().rootPane, paneId);
      if (pane?.type !== "panel") return;
      if (pane.tabs.length > 0) {
        if (import.meta.env.DEV) {
          console.warn(
            "[panes] removeEmptyPane rejected: pane is not empty (zero-destroy contract)",
            { paneId, tabCount: pane.tabs.length },
          );
        }
        return;
      }

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
        parent.sizes = total > 0
          ? parent.sizes.map((s) => (s / total) * 100)
          : parent.sizes.map(() => 100 / parent.sizes.length);

        if (parent.children.length > 0) {
          const newIndex = Math.min(index, parent.children.length - 1);
          const nextPane = parent.children[newIndex];
          const panels = collectPanels(nextPane);
          if (panels.length > 0) {
            state.activePaneId = panels[0].id;
          }
        }

        state.rootPane = normalizePaneTree(state.rootPane);
        const activePane = findPane(state.rootPane, state.activePaneId);
        if (activePane?.type !== "panel") {
          const panels = collectPanels(state.rootPane);
          if (panels.length > 0) {
            state.activePaneId = panels[0].id;
          }
        }
      });
      notifyTerminalLayoutChanged("pane.close");
    },
  };
}
