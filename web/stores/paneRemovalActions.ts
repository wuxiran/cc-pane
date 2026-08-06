// 分屏区 pane / tab 的关闭与移除（docs/78）。
//
// 从 usePanesStore.ts 拆出（该文件已触到行数棘轮上限，见 web/test/lineRatchet.test.ts），
// 与 editorTabActions.ts 同一套路：createPaneRemovalActions(set, get) 工厂，
// 在 usePanesStore 里 spread 挂载。
//
// 三个统一出口（removeTabsInternal / removeTerminalLeafInternal /
// removeEmptyPane）——全部 UI 与后端销毁路径的唯一入口，资源回收统一走
// destroyPipeline。历史上的六个散装出口（closeTab/closePane/批量三件/
// closeTerminalPane）已随双写拆除删净。
import {
  commitResourceDestroy,
  DESTROY_KILL_REASON,
  DESTROY_POLICY,
  sweepOwnerState,
} from "@/lib/tabLifecycle/destroyPipeline";
import { TAB_LIFECYCLE } from "@/lib/tabLifecycle/registry";
import type { DestroyReason } from "@/lib/tabLifecycle/destroyPipeline";
import { collectTerminalLeaves, collectTerminalSessionIdsWithSaved } from "@/lib/paneSessions";
import type { Tab } from "@/types";
import type {
  PanesDraft,
  PanesState,
  RemoveTabsInternalOptions,
} from "./panesStoreTypes";
import { terminalService } from "@/services/terminalService";
import { handleErrorSilent } from "@/utils/errorHandler";
import { useTerminalStatusStore } from "./useTerminalStatusStore";
import { toClosedTabSnapshot, trimClosedTabs } from "./closedTabsCap";
import {
  closeTabInTree,
  collectPanels,
  createPanel,
  findPane,
  findParent,
  findTabLocation,
  normalizePaneTree,
  notifyTerminalLayoutChanged,
} from "@/lib/paneTree";
import { closeTerminalLeafInTab } from "@/lib/paneTree";
import { useFullscreenStore } from "./useFullscreenStore";

export interface PaneRemovalActions {
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


export function createPaneRemovalActions(
  set: (recipe: (state: PanesDraft) => void) => void,
  get: () => PanesState,
): PaneRemovalActions {
  return {
    // ============ 统一销毁出口（全部关闭路径的唯一入口） ============

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
      // 历史快照互覆盖会造成**跨布局同 id 的分叉副本**（下方
      // 树操作的注释即为此扫完全部布局）。收集必须逐位置进行，不能按 tab.id
      // 去重——去重会漏掉后续副本的资源（不同 sessionId 的分叉副本成孤儿）。
      // 同时 pinned 豁免的副本仍在树上显示它的会话：该会话必须进保护集，
      // 否则「杀掉 pinned 副本正在用的会话」= 一个杀不掉的死终端。
      const pinnedProtected = new Set<string>();
      {
        const state = get();
        for (const tabId of tabIds) {
          for (const layout of state.layouts) {
            const tree = layout.id === state.currentLayoutId ? state.rootPane : layout.rootPane;
            if (!tree) continue;
            const location = findTabLocation(tree, tabId);
            if (!location) continue;
            if (policy.respectsPinned && location.tab.pinned) {
              for (const sid of collectTerminalSessionIdsWithSaved(location.tab)) {
                pinnedProtected.add(sid);
              }
              continue;
            }
            doomedTabs.push(location.tab);
          }
        }
      }
      // 回收先于树操作：树 splice 后 tab 数据就找不回来了。commitResourceDestroy
      // 内部按矩阵决定杀不杀（backend-close 的 PTY 已死，kills=false 整步跳过）。
      if (doomedTabs.length > 0) {
        const protect = pinnedProtected.size > 0
          ? new Set([...(opts?.protectSessionIds ?? []), ...pinnedProtected])
          : opts?.protectSessionIds;
        void commitResourceDestroy(doomedTabs, reason, { protectSessionIds: protect });
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

            if (policy.recordsClosedTabs && tab.projectPath && tab.contentType === "terminal") {
              state.closedTabs.push(toClosedTabSnapshot(tab));
            } else if (policy.recordsClosedTabs) {
              // 非终端撤销（docs/78）：browser 存 URL、editor 存 filePath。
              const snap = TAB_LIFECYCLE[tab.contentType].persistForUndo?.(tab);
              if (snap) state.closedTabs.push(snap);
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
      // owner 键卫星态清扫（视图聚合 + 注意标记）：不清的话被关标签的
      // views/aggregate 条目永远留在 store，且大概率停在 active（人总是关
      // 当前标签）——hidden 上报会把死标签当「可见」上报给 daemon。
      sweepOwnerState(removedIds);
      notifyTerminalLayoutChanged("tab.remove");
    },

    removeTerminalLeafInternal: (tabId, terminalPaneId, reason) => {
      // 「关一格」：分屏 tab 里关掉一个终端 leaf（树操作走 closeTerminalLeafInTab）。
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
          const leaves = collectTerminalLeaves(location.tab.terminalRootPane);
          // **kill 必须与树操作同守卫**。最后一格时下面的
          // closeTerminalLeafInTab 会 no-op（保持 tab 存在），若这里仍杀了
          // 会话，结果是「会话已死但格子还在树上」——一个杀不掉又用不了的
          // 死终端。最后一格由调用方走 removeTabsInternal 关整个 tab。
          if (leaves.length <= 1) return;
          const leaf = leaves.find((l) => l.id === terminalPaneId);
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
      // 收掉留下的空壳。它们的 pane 里已经没有任何 tab，绝不能借道
      // 搬空 pane 的路径沾上杀会话副作用——非空即拒是硬守卫，不是防御式冗余。
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
