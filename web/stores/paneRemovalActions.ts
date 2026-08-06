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
import type { DestroyPolicy, DestroyReason } from "@/lib/tabLifecycle/destroyPipeline";
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
import { toClosedTabSnapshot, trimClosedTabs } from "./closedTabsUndo";
import {
  assignTreeAndConvergeActive,
  closeTabInTree,
  collectPanels,
  createPanel,
  findPane,
  findParent,
  findTabLocation,
  normalizePaneTree,
  normalizeSplitSizes,
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


/**
 * removeTabsInternal 第一段：树 splice 前按当前树**重新定位**、收集要回收的
 * tab，并发起资源回收（回收先于树操作：splice 后 tab 数据就找不回来了）。
 *
 * 重定位重收集而非信任调用方传来的 Tab 引用：确认弹窗打开期间树可能变化
 * （后端 kill / 跨端快照同步），拿旧引用去杀会杀错对象。
 *
 * 历史快照互覆盖会造成**跨布局同 id 的分叉副本**，收集必须逐位置进行、不能
 * 按 tab.id 去重——去重会漏掉后续副本的资源（不同 sessionId 的分叉副本成
 * 孤儿）。pinned 豁免的副本仍在树上显示它的会话：该会话必须进保护集，否则
 * 「杀掉 pinned 副本正在用的会话」= 一个杀不掉的死终端。
 */
function relocateAndCollect(
  state: PanesState,
  tabIds: string[],
  policy: DestroyPolicy,
  reason: DestroyReason,
  opts: RemoveTabsInternalOptions | undefined,
): void {
  const doomedTabs: Tab[] = [];
  const pinnedProtected = new Set<string>();
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
  // commitResourceDestroy 内部按矩阵决定杀不杀（backend-close 的 PTY 已死，
  // kills=false 整步跳过）。
  if (doomedTabs.length > 0) {
    const protect = pinnedProtected.size > 0
      ? new Set([...(opts?.protectSessionIds ?? []), ...pinnedProtected])
      : opts?.protectSessionIds;
    void commitResourceDestroy(doomedTabs, reason, { protectSessionIds: protect });
  }
}

/**
 * removeTabsInternal 第二段：逐 tab × 逐布局（含星标——镜像标签同样要能移除）
 * 树 splice + closedTabs 撤销快照。pinned 豁免与第一段同口径判定（两处判据
 * 必须一致，否则会出现「资源杀了但标签还在」或反之）。
 * 同 id 继续扫完其余布局（历史快照互覆盖的跨布局分叉副本要移除干净）。
 */
function spliceAcrossLayouts(
  state: PanesDraft,
  tabIds: string[],
  policy: DestroyPolicy,
  removedIds: Set<string>,
): void {
  for (const tabId of tabIds) {
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

      // pinned 语义已按矩阵判过，这里恒 force。
      const nextTree = closeTabInTree(tree, panel.id, tabId, true);
      assignTreeAndConvergeActive(isCurrent ? state : layout, nextTree);
      removedIds.add(tabId);
    }
  }
  if (removedIds.size > 0) {
    trimClosedTabs(state.closedTabs);
  }
}

/**
 * removeTabsInternal 第三段：附属状态清理——poppedOutTabs / 全屏退出 /
 * owner 键卫星态清扫（视图聚合 + 注意标记，不清的话死标签会被 hidden 上报
 * 当「可见」报给 daemon）+ 布局变更通知。
 */
function cleanupSatelliteState(
  set: (recipe: (state: PanesDraft) => void) => void,
  get: () => PanesState,
  removedIds: Set<string>,
): void {
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
  sweepOwnerState(removedIds);
  notifyTerminalLayoutChanged("tab.remove");
}

export function createPaneRemovalActions(
  set: (recipe: (state: PanesDraft) => void) => void,
  get: () => PanesState,
): PaneRemovalActions {
  return {
    // ============ 统一销毁出口（全部关闭路径的唯一入口） ============

    removeTabsInternal: (tabIds, reason, opts) => {
      // 唯一逐-tab 销毁出口，三段编排（docs/78 §8）：
      // relocateAndCollect（回收先于树操作）→ spliceAcrossLayouts（树 splice
      // + closedTabs）→ cleanupSatelliteState（附属清理 + 通知）。
      // 幂等：找不到的 tabId 静默跳过。
      if (tabIds.length === 0) return;
      const policy = DESTROY_POLICY[reason];
      relocateAndCollect(get(), tabIds, policy, reason, opts);
      const removedIds = new Set<string>();
      set((state) => spliceAcrossLayouts(state, tabIds, policy, removedIds));
      if (removedIds.size === 0) return;
      cleanupSatelliteState(set, get, removedIds);
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

        normalizeSplitSizes(parent);

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
