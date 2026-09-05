// 布局（layout）生命周期 actions：创建/改名/删除/切换/排序/星标布局、工作空间绑定、
// 快照导出与套用。从 usePanesStore.ts 拆出（纯代码移动，逻辑不变）；
// 在 usePanesStore 里 spread 挂载。
import { createPanel, generateId, notifyTerminalLayoutChanged } from "@/lib/paneTree";
import { collectTabs } from "@/lib/paneSessions";
import { sweepOwnerState } from "@/lib/tabLifecycle/destroyPipeline";
import { getLayoutWorkspaceBinding } from "@/utils/layoutWorkspace";
import type { LayoutEntry } from "@/types";
import { useFullscreenStore } from "../useFullscreenStore";
import {
  isNormalLayout,
  isStarredLayout,
  nextLayoutName,
  syncWorkingCopyToCurrentLayout,
} from "../paneLayoutHelpers";
import type { PanesState } from "../panesStoreTypes";
import { beginSnapshotKillCandidates, collectSnapshotSessionIds } from "../snapshotSessionDiff";
import { filterLayouts, findLayout, findLayoutIndex, flatMapLayouts } from "./layoutTraversal";
import { findTabAcrossLayouts } from "./crossLayoutSearch";
import {
  ensureLayoutState,
  projectedLayouts,
} from "./layoutLifecycle";
import type { PanesStoreAccess } from "./storeAccess";

export type LayoutActions = Pick<
  PanesState,
  | "createLayout"
  | "renameLayout"
  | "deleteLayout"
  | "switchLayout"
  | "switchLayoutByIndex"
  | "reorderLayouts"
  | "listLayouts"
  | "bindLayoutWorkspace"
  | "unbindLayoutWorkspace"
  | "autoBindLayoutWorkspaceFromTabs"
  | "exportLayoutSnapshotPayload"
  | "applyLayoutSnapshotPayload"
>;

export function createLayoutActions({ set, get }: PanesStoreAccess): LayoutActions {
  return {
    createLayout: (name) => {
      const id = generateId("layout");
      set((state) => {
        syncWorkingCopyToCurrentLayout(state);
        const rootPane = createPanel();
        const normalLayouts = filterLayouts(state.layouts, isNormalLayout);
        const layout: LayoutEntry = {
          id,
          name: (name?.trim() || nextLayoutName(normalLayouts)),
          kind: "normal",
          rootPane,
          activePaneId: rootPane.id,
          lastActiveAt: Date.now(),
        };
        const starredIndex = findLayoutIndex(state.layouts, isStarredLayout);
        if (starredIndex >= 0) {
          state.layouts.splice(starredIndex, 0, layout);
        } else {
          state.layouts.push(layout);
        }
        state.currentLayoutId = id;
        state.rootPane = rootPane;
        state.activePaneId = rootPane.id;
      });
      useFullscreenStore.getState().exitFullscreen();
      notifyTerminalLayoutChanged("layout.create");
      return id;
    },

    renameLayout: (id, name) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      set((state) => {
        const layout = findLayout(state.layouts, (item) => item.id === id);
        if (!layout || isStarredLayout(layout)) return;
        layout.name = trimmed;
      });
    },

    deleteLayout: (id) => {
      let deleted = false;
      let doomedTabIds: string[] = [];
      set((state) => {
        const index = findLayoutIndex(state.layouts, (layout) => layout.id === id);
        if (index === -1) return;
        const deletingLayout = state.layouts[index];
        if (isStarredLayout(deletingLayout)) return;
        if (filterLayouts(state.layouts, isNormalLayout).length <= 1) return;

        syncWorkingCopyToCurrentLayout(state);
        const deletingCurrent = state.currentLayoutId === id;
        state.layouts.splice(index, 1);
        deleted = true;
        // owner 键卫星态只扫「从所有布局彻底消失」的标签——星标镜像同 id
        // 的标签可能仍活在别的布局，扫了会误清活标签的视图/注意状态。
        const survivors = new Set(
          flatMapLayouts(state.layouts, (layout) =>
            layout.rootPane ? collectTabs(layout.rootPane).map((tab) => tab.id) : [],
          ),
        );
        doomedTabIds = (deletingLayout.rootPane ? collectTabs(deletingLayout.rootPane) : [])
          .map((tab) => tab.id)
          .filter((tabId) => !survivors.has(tabId));

        if (deletingCurrent) {
          const normalLayouts = filterLayouts(state.layouts, isNormalLayout);
          const previousNormal = normalLayouts
            .slice()
            .reverse()
            .find((layout) => state.layouts.indexOf(layout) < index);
          const nextLayout = previousNormal ?? normalLayouts[0];
          if (!nextLayout) return;
          state.currentLayoutId = nextLayout.id;
          state.rootPane = nextLayout.rootPane;
          state.activePaneId = nextLayout.activePaneId;
        }
      });
      if (!deleted) return;
      sweepOwnerState(doomedTabIds);
      useFullscreenStore.getState().exitFullscreen();
      notifyTerminalLayoutChanged("layout.delete");
    },

    switchLayout: (id) => {
      set((state) => {
        if (state.currentLayoutId === id) return;
        const target = findLayout(state.layouts, (layout) => layout.id === id);
        if (!target) return;
        syncWorkingCopyToCurrentLayout(state);
        state.currentLayoutId = id;
        state.rootPane = target.rootPane;
        state.activePaneId = target.activePaneId;
        target.lastActiveAt = Date.now();
        // zoom 是布局内临时态，切布局即失效（与全屏退出同口径）
        state.zoomedPaneId = null;
      });
      useFullscreenStore.getState().exitFullscreen();
      notifyTerminalLayoutChanged("layout.switch");
    },

    switchLayoutByIndex: (index) => {
      const target = get().layouts[index];
      if (!target) return;
      get().switchLayout(target.id);
    },

    reorderLayouts: (fromIndex, toIndex) => {
      set((state) => {
        if (fromIndex < 0 || fromIndex >= state.layouts.length) return;
        if (toIndex < 0 || toIndex >= state.layouts.length) return;
        if (fromIndex === toIndex) return;
        const [moved] = state.layouts.splice(fromIndex, 1);
        state.layouts.splice(toIndex, 0, moved);
      });
    },

    listLayouts: () => projectedLayouts(get()),

    bindLayoutWorkspace: (layoutId, workspaceName) => {
      const trimmed = workspaceName.trim();
      if (!trimmed) return;
      set((state) => {
        const layout = findLayout(state.layouts, (item) => item.id === layoutId);
        if (!layout || isStarredLayout(layout)) return;
        layout.workspaceName = trimmed;
      });
    },

    unbindLayoutWorkspace: (layoutId) => {
      set((state) => {
        const layout = findLayout(state.layouts, (item) => item.id === layoutId);
        if (!layout || isStarredLayout(layout)) return;
        layout.workspaceName = undefined;
      });
    },

    autoBindLayoutWorkspaceFromTabs: () => {
      set((state) => {
        const layout = findLayout(state.layouts, (item) => item.id === state.currentLayoutId);
        if (!layout || isStarredLayout(layout) || layout.workspaceName?.trim()) return;
        const binding = getLayoutWorkspaceBinding({
          workspaceName: undefined,
          rootPane: state.rootPane,
        });
        if (binding) layout.workspaceName = binding.workspaceName;
      });
    },

    exportLayoutSnapshotPayload: () => {
      const state = get();
      return {
        // v2: LayoutEntry 携带 workspaceName/lastActiveAt（可选字段，v1 消费方可忽略）
        schemaVersion: 2,
        layouts: projectedLayouts(state, { includeStarred: true }),
        currentLayoutId: state.currentLayoutId,
      };
    },

    applyLayoutSnapshotPayload: (payload) => {
      if (!payload || !Array.isArray(payload.layouts)) return false;
      // 接受 v1（无绑定字段）与 v2；未来更高版本结构未知，拒绝以免半解析
      if (typeof payload.schemaVersion === "number" && payload.schemaVersion > 2) return false;

      // 整树替换会让旧树里的会话失去全部引用——它们**可能**是该回收的
      // 孤儿，也**可能**马上被收养回来。跨端同步每 5s 跑一轮
      // apply → reconcileTerminalSessions → runBackgroundLayoutRestore，
      // 新树经 savedSessionId 引用的常常就是当前活着的会话。所以：
      //   1. 这里只算差集（旧引用 − 新引用，两侧都含 savedSessionId），不杀；
      //   2. 真杀等观察期零误报才开闸，且必须等本轮收养 settle 再按当前活会话
      //      复核一遍。
      // 现在先把「如果真杀会杀掉谁」打进日志，与孤儿对账 GC 的发现对账，
      // 攒够零误报的样本再开闸。
      const beforeIds = new Set(collectSnapshotSessionIds(get()));
      let applied = false;
      set((state) => {
        const layoutState = ensureLayoutState({
          layouts: payload.layouts,
          currentLayoutId: payload.currentLayoutId,
          rootPane: state.rootPane,
          activePaneId: state.activePaneId,
        });
        state.layouts = layoutState.layouts;
        state.currentLayoutId = layoutState.currentLayoutId;
        state.rootPane = layoutState.rootPane;
        state.activePaneId = layoutState.activePaneId;
        state.poppedOutTabs = new Set<string>();
        applied = true;
      });
      if (applied) {
        // 杀决策后置：只登记候选，settle 后复核输出（persistence 侧）
        beginSnapshotKillCandidates(beforeIds, new Set(collectSnapshotSessionIds(get())));
        // 全屏中的 tab 若被快照换掉，fullscreenTabId 会悬空（poppedOutTabs
        // 上面已重置，这条是同批补的）。
        const fullscreen = useFullscreenStore.getState();
        if (fullscreen.fullscreenTabId && !findTabAcrossLayouts(get(), fullscreen.fullscreenTabId)) {
          void fullscreen.exitFullscreen();
        }
        notifyTerminalLayoutChanged("layout.snapshot.apply");
      }
      return applied;
    },
  };
}
