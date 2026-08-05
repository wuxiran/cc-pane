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
import {
  commitResourceDestroy,
  DESTROY_KILL_REASON,
  DESTROY_POLICY,
} from "@/lib/tabLifecycle/destroyPipeline";
import type { DestroyReason } from "@/lib/tabLifecycle/destroyPipeline";
import { collectTerminalLeaves } from "@/lib/paneSessions";
import type { Tab } from "@/types";
import type {
  ClosedTabSnapshot,
  PanesDraft,
  PanesState,
  RemoveTabsInternalOptions,
} from "./panesStoreTypes";
import { terminalService } from "@/services/terminalService";
import { handleErrorSilent } from "@/utils/errorHandler";
import { useTerminalStatusStore } from "./useTerminalStatusStore";
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
  /** @deprecated B1-04 已改道 removeTabsInternal(ids, "batch-close")。零调用方，留待批1 收尾删除。 */
  closeTabsToLeft: (paneId: string, tabId: string) => void;
  /** @deprecated 同 closeTabsToLeft。 */
  closeTabsToRight: (paneId: string, tabId: string) => void;
  /** @deprecated 同 closeTabsToLeft。 */
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
      // B1-05 语义拆分：**关 pane = 销毁里面的 tab + 收掉空壳**，两件事分开做。
      // 有 tab 时先走销毁出口（回收 + closedTabs 按矩阵），再收空壳；
      // 已空则只收空壳。搬空 pane 的调用方（moveTab 系）改用 removeEmptyPane，
      // 不再借道这里——那条路径绝不能沾上杀会话副作用。
      const closingPane = findPane(get().rootPane, paneId);
      if (closingPane?.type === "panel" && closingPane.tabs.length > 0) {
        get().removeTabsInternal(
          closingPane.tabs.map((t) => t.id),
          "close-pane",
        );
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
      // B1-05 改道：回收 + closedTabs + 树操作统一走 removeTabsInternal。
      //
      // 顺带修掉双 push——改道前 closeTab 先 push 快照，pane 只剩这一个 tab 时
      // 又转调 closePane，后者再 push 一次，同一个 tab 在撤销栈里占两格。
      // 现在 push 只发生在 removeTabsInternal 一处。
      const pane = findPane(get().rootPane, paneId);
      if (pane?.type !== "panel") return;
      const tab = pane.tabs.find((t) => t.id === tabId);
      if (!tab) return;

      get().removeTabsInternal([tabId], "user-close");

      // 关掉最后一个 tab 后 pane 成空壳，收掉它（纯树操作，零销毁语义）。
      const after = findPane(get().rootPane, paneId);
      if (after?.type === "panel" && after.tabs.length === 0) {
        get().removeEmptyPane(paneId);
      }
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

    removeTabsInternal: (tabIds, reason, opts) => {
      // 唯一逐-tab 销毁出口：重定位重收集 → 回收（commitResourceDestroy）
      // → 树 splice → closedTabs(cap 20) → poppedOut / fullscreen 附属清理。
      // 幂等：找不到的 tabId 静默跳过。
      //
      // **重定位重收集而非信任调用方传来的 Tab 引用**：确认弹窗打开期间树可能
      // 变化（后端 kill / 跨端快照同步），拿旧引用去杀会杀错对象。
      if (tabIds.length === 0) return;
      const policy = DESTROY_POLICY[reason];
      const removedIds = new Set<string>();

      // 阶段 0：树 splice 前按当前树重新定位，收集真正要回收的 tab。
      // pinned 豁免在此判定，与下方树操作同一口径——两处判据必须一致，
      // 否则会出现「资源杀了但标签还在」或反之。
      const doomedTabs: Tab[] = [];
      {
        const state = get();
        for (const tabId of tabIds) {
          for (const layout of state.layouts) {
            const tree = layout.id === state.currentLayoutId ? state.rootPane : layout.rootPane;
            if (!tree) continue;
            const location = findTabLocation(tree, tabId);
            if (!location) continue;
            if (policy.respectsPinned && location.tab.pinned) continue;
            if (!doomedTabs.some((t) => t.id === location.tab.id)) doomedTabs.push(location.tab);
          }
        }
      }
      // 回收先于树操作：树 splice 后 tab 数据就找不回来了。commitResourceDestroy
      // 内部按矩阵决定杀不杀（backend-close 的 PTY 已死，kills=false 整步跳过）。
      if (doomedTabs.length > 0) {
        void commitResourceDestroy(doomedTabs, reason, {
          protectSessionIds: opts?.protectSessionIds,
        });
      }

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

    removeTerminalLeafInternal: (tabId, terminalPaneId, reason) => {
      // 「关一格」：分屏 tab 里关掉一个终端 leaf（树操作与 closeTerminalPane 同实现）。
      //
      // 杀集是**这一格自己的**会话，不是整个 tab 的——关一格只该杀一格，
      // 用 collectResources 全量会连坐同 tab 的其他分屏。按
      // `sessionId ?? savedSessionId` 取（改道前只看 sessionId，恢复中的格子
      // 关掉就成孤儿）。最后一个 leaf 不在这里关，调用方走 removeTabsInternal。
      const policy = DESTROY_POLICY[reason];
      if (policy.kills) {
        const state = get();
        for (const layout of state.layouts) {
          const tree = layout.id === state.currentLayoutId ? state.rootPane : layout.rootPane;
          if (!tree) continue;
          const location = findTabLocation(tree, tabId);
          if (!location) continue;
          const leaf = collectTerminalLeaves(location.tab.terminalRootPane)
            .find((l) => l.id === terminalPaneId);
          const sessionId = leaf?.sessionId ?? leaf?.savedSessionId;
          if (sessionId) {
            terminalService.detachOutput(sessionId);
            terminalService.detachExit(sessionId);
            void terminalService
              .killSession(sessionId, DESTROY_KILL_REASON[reason] ?? undefined)
              .catch((error) => handleErrorSilent(error, "kill terminal leaf session"));
            useTerminalStatusStore.getState().removeSession(sessionId);
          }
          break;
        }
      }

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
