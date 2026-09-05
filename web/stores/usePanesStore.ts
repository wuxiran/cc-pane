import { create } from "zustand";
import { persist } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";
import { createPanel, generateId, notifyTerminalLayoutChanged, syncTabTerminalState } from "@/lib/paneTree";
import type { LayoutEntry } from "@/types";
import { createBackendCloseActions } from "./backendCloseActions";
import { createPaneRemovalActions } from "./paneRemovalActions";
import { createBrowserTabActions } from "./browserTabActions";
import { createWorkspaceToolTabActions } from "./workspaceToolTabActions";
import { migratePersistedPanes } from "./panesPersistMigrations";
import { createEditorTabActions } from "./editorTabActions";
import { createTerminalColdRestoreActions } from "./terminalColdRestoreActions";
import type { PanesState } from "./panesStoreTypes";
export type {
  AdoptSessionMeta,
  CloseTabBySessionIdResult,
  SessionAnchor,
  StarredTabShortcut,
} from "./panesStoreTypes";
import { createLayoutActions } from "./panes/layoutActions";
import { createPaneQueryActions } from "./panes/paneQueryActions";
import { createSessionBindingActions } from "./panes/sessionBindingActions";
import { createSplitActions } from "./panes/splitActions";
import { createTabBasicActions } from "./panes/tabBasicActions";
import { createTabMoveActions } from "./panes/tabMoveActions";
import { createTabOpenActions } from "./panes/tabOpenActions";
import { createTerminalLeafActions } from "./panes/terminalLeafActions";
import { findTabAcrossLayouts } from "./panes/crossLayoutSearch";
import { createStarredLayout, ensureLayoutState, ensureStarredLayoutInDraft } from "./panes/layoutLifecycle";
import { isStarredLayout } from "./paneLayoutHelpers";

// 真身在 paneTreeHelpers；这里保留 re-export 维持既有 import 路径。
export { TERMINAL_LAYOUT_CHANGED_EVENT } from "@/lib/paneTree";
// 真身已拆到 ./panes/*（纯代码移动，签名不变）；保留 re-export 维持既有 import 路径。
export { createTab } from "./panes/createTab";
export { matchLayoutPreset } from "./panes/layoutPresets";

const initialPanel = createPanel();
const initialLayout: LayoutEntry = {
  id: generateId("layout"),
  name: "布局 1",
  kind: "normal",
  rootPane: initialPanel,
  activePaneId: initialPanel.id,
};
const initialStarredLayout = createStarredLayout();

export const usePanesStore = create<PanesState>()(
  persist(
  immer((set, get) => ({
    rootPane: initialPanel,
    activePaneId: initialPanel.id,
    layouts: [initialLayout, initialStarredLayout],
    currentLayoutId: initialLayout.id,
    closedTabs: [],
    poppedOutTabs: new Set<string>(),

    ...createPaneQueryActions({ set, get }),
    ...createLayoutActions({ set, get }),

    // layoutTraversalGuard 把本文件登记为 layout 直访 owner：ensureStarredLayout 留在
    // 聚合出口（逻辑与拆分前一致），星标写入路径走 ensureStarredLayoutInDraft。
    ensureStarredLayout: () => {
      const existing = get().layouts.find(isStarredLayout);
      if (existing) return existing.id;
      let id = "";
      set((state) => {
        id = ensureStarredLayoutInDraft(state);
      });
      return id;
    },

    ...createSplitActions({ set, get }),
    ...createTabBasicActions({ set, get }),
    ...createTabMoveActions({ set, get }),
    ...createTabOpenActions({ set, get }),
    ...createTerminalLeafActions({ set, get }),
    ...createSessionBindingActions({ set, get }),

    ...createWorkspaceToolTabActions({ set, get }),
    ...createBrowserTabActions(set),

    ...createEditorTabActions(set, get),

    ...createPaneRemovalActions(set, get),
    ...createBackendCloseActions(set),

    ...createTerminalColdRestoreActions({ set, findTab: findTabAcrossLayouts, syncTab: syncTabTerminalState, notifyLayoutChanged: notifyTerminalLayoutChanged }),
  })),
  {
    name: "cc-panes-layout",
    version: 5,
    migrate: (persistedState, version) =>
      migratePersistedPanes(persistedState, version, { syncTabTerminalState }),
    partialize: (state) => ({
      ...state.exportLayoutSnapshotPayload(),
      // poppedOutTabs is runtime-only; popped windows do not survive restart.
    }),
    merge: (persistedState, currentState) => {
      const persisted = persistedState as Partial<PanesState> | undefined;
      const layoutState = ensureLayoutState({
        layouts: persisted?.layouts ?? currentState.layouts,
        currentLayoutId: persisted?.currentLayoutId ?? currentState.currentLayoutId,
        rootPane: persisted?.rootPane ?? currentState.rootPane,
        activePaneId: persisted?.activePaneId ?? currentState.activePaneId,
      });
      const merged = {
        ...currentState,
        ...(persisted as object),
        ...layoutState,
        poppedOutTabs: new Set<string>(),
      };
      return merged as PanesState;
    },
  },
  )
);
