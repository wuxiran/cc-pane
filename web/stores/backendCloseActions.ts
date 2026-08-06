// 后端事件驱动的标签关闭（docs/78）。
//
// 与其他销毁出口的根本区别：**PTY 已经死了**（session-killed 事件）——所以
// 这条路径只做树操作与附属清理，绝不 kill——矩阵里 backend-close 的
// kills=false 就是这个意思。另有一个独有语义：分屏 tab 优先只摘掉那一格，
// 保留其余格子，removeTabsInternal 的整 tab 口径覆盖不了。
import { current } from "immer";
import { commitResourceDestroy, sweepOwnerState } from "@/lib/tabLifecycle/destroyPipeline";
import type { Tab } from "@/types";
import type { CloseTabBySessionIdResult, PanesDraft } from "./panesStoreTypes";
import { closeTabInTree, collectPanels, findPane } from "./paneTreeHelpers";
import { closeTerminalLeafInTab, findSessionInTab } from "./paneTreeRemovalHelpers";

export interface BackendCloseActions {
  closeTabBySessionId: (sessionId: string) => CloseTabBySessionIdResult;
}

export function createBackendCloseActions(
  set: (recipe: (state: PanesDraft) => void) => void,
): BackendCloseActions {
  return {
  closeTabBySessionId: (sessionId: string) => {
    // 后端事件驱动（session-killed）。PTY 已经死了，**绝不能再 kill**
    // 矩阵里 backend-close 的 kills=false 就是这个意思；本路径只做树操作
    // 与附属清理。分屏 tab 优先只摘掉那一格（保留其余格子），这是本出口
    // 独有的语义，removeTabsInternal 的整 tab 口径覆盖不了，故保留自有实现。
    let closed = 0;
    const doomedTabs: Tab[] = [];
    set((state) => {
      // 不用 eachLayoutTree：它跳过星标布局，而星标布局里的标签同样是真实 PTY 镜像，
      // 后端 kill 后必须一并关掉，否则星标布局里的标签永远关不掉。
      // eachLayoutTree 的跳过语义被布局编辑等多处依赖，不在此处改动它。
      // 同一会话可能同时出现在普通布局和星标布局，因此不在首个命中处停止，逐布局各关一次。
      for (const layout of state.layouts) {
        const isCurrent = layout.id === state.currentLayoutId;
        const tree = isCurrent ? state.rootPane : layout.rootPane;
        if (!tree) continue;
        for (const panel of collectPanels(tree)) {
          const tab = panel.tabs.find((item) => Boolean(findSessionInTab(item, sessionId)));
          if (!tab) continue;
          // 这是唯一由后端事件驱动的关标签路径，必须留痕便于排障
          console.info("[panes] closeTabBySessionId", {
            sessionId,
            layoutId: layout.id,
            paneId: panel.id,
            tabId: tab.id,
            tabTitle: tab.title,
          });
          const leaf = findSessionInTab(tab, sessionId);
          if (leaf && closeTerminalLeafInTab(tab, leaf.id)) {
            closed += 1;
            break;
          }
          // backend-driven kill 表示 PTY 已不存在；即使标签 pinned 也必须关闭，
          // pinned 只保护用户手动关闭，不应留下已死亡的终端壳。
          // 快照留给下面的附属清理——树摘掉后就拿不到 tab 数据了。
          // **必须深拷贝**：浅拷贝的 terminalRootPane 仍指向 Immer draft，
          // set() 结束后 proxy 被 revoke，异步回收再读就抛
          // 「Cannot perform 'get' on a proxy that has been revoked」。
          doomedTabs.push(structuredClone(current(tab)));
          const nextTree = closeTabInTree(tree, panel.id, tab.id, true);
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
          closed += 1;
          break;
        }
      }
    });
    // 附属清理走登记表的 onClosed（清 status 条目 / contextUsage / 关弹窗），
    // 但**不 kill**——PTY 已死。tab 快照在树操作前抓好，摘完就取不到了。
    if (doomedTabs.length > 0) {
      void commitResourceDestroy(doomedTabs, "backend-close", {});
      sweepOwnerState(doomedTabs.map((tab) => tab.id));
    }
    return { closed };
  },
  };
}
