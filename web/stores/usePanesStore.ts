import { create } from "zustand";
import { persist } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";
import { useFullscreenStore } from "./useFullscreenStore";
import { useTerminalStatusStore } from "./useTerminalStatusStore";
import { terminalService, ensureListeners } from "@/services/terminalService";
import { waitForTerminalRestoreBarrierWithDeadline } from "@/services/terminalRestoreBarrier";
import { devDebugLog } from "@/utils/devLogger";
import { projectPathsEquivalent } from "@/utils/projectIdentity";
import { collectTabs, collectTerminalLeaves, findTerminalPane } from "@/lib/paneSessions";
import { assignTreeAndConvergeActive } from "@/lib/paneTree";
import { sweepOwnerState } from "@/lib/tabLifecycle/destroyPipeline";
// createPanel 唯一实现在 paneTreeHelpers（该模块只依赖 @/types，反向引用不会成环）。
// 注意它接受可选 tab：openSessionBesidePane 依赖 createPanel(createTab(opts)) 避免多出空标签。
// 树辅助（findPane 等）与 close 系树操作已下沉到 paneTreeHelpers /
// paneTreeRemovalHelpers，本文件与 paneRemovalActions 共用同一份实现。
import {
  closeTabInTree,
  collectPanels,
  createPanel,
  findPane,
  findParent,
  findTabLocation,
  notifyTerminalLayoutChanged,
  generateId,
} from "@/lib/paneTree";
import {
  closeTerminalLeafInTab,
  findSessionInTab,
  findTerminalPaneParent,
  syncTabTerminalState,
} from "@/lib/paneTree";
import { createBackendCloseActions } from "./backendCloseActions";
import { beginSnapshotKillCandidates, collectSnapshotSessionIds } from "./snapshotSessionDiff";
import { createPaneRemovalActions } from "./paneRemovalActions";
import {
  activateFirstNormalLayout,
  activeLayout,
  eachLayoutTree,
  firstNormalLayout,
  isNormalLayout,
  isStarredLayout,
  layoutTree,
  nextLayoutName,
  resolveLayoutWriteTarget,
  syncWorkingCopyToCurrentLayout,
} from "./paneLayoutHelpers";
import { createBrowserTabActions } from "./browserTabActions";
import { inferCliTool, resolveRestoreMode } from "@/lib/terminalRestoreMode";
import { migratePersistedPanes } from "./panesPersistMigrations";
import { createEditorTabActions } from "./editorTabActions";
import { createTerminalColdRestoreActions } from "./terminalColdRestoreActions";
import { reopenNonTerminalSnapshot, restoreClosedTabIdentity, trimClosedTabs } from "./closedTabsUndo";
import type {
  CreateTabOptions,
  DraftTabAcrossLayoutsLocation,
  PaneAcrossLayoutsLocation,
  PanesDraft,
  PanesState,
  StarredTabShortcut,
  TabAcrossLayoutsLocation,
} from "./panesStoreTypes";
export type {
  AdoptSessionMeta,
  CloseTabBySessionIdResult,
  SessionAnchor,
  StarredTabShortcut,
} from "./panesStoreTypes";
import type {
  PaneNode,
  Panel,
  SplitPane,
  LayoutEntry,
  Tab,
  SplitDirection,
  TerminalPaneNode,
  TerminalPaneLeaf,
  LaunchExtras,
} from "@/types";
import type { LayoutPresetId } from "@/types/pane";
import { getLayoutWorkspaceBinding } from "@/utils/layoutWorkspace";


// 真身在 paneTreeHelpers；这里保留 re-export 维持既有 import 路径。
export { TERMINAL_LAYOUT_CHANGED_EVENT } from "@/lib/paneTree";

export function createTab(opts: CreateTabOptions): Tab {
  const { projectId, projectPath, launchId, sessionId, resumeId, workspaceName, providerId, modelId, providerSelection, launchProfileId, workspacePath, workspaceSnapshotId, cliTool, customTitle, ssh, wsl, machineName, parentTabId, launchExtras } = opts;
  let title: string;
  if (customTitle) {
    title = customTitle;
  } else {
    const name = projectPath.split(/[/\\]/).pop() || "Terminal";
    if (ssh) {
      const label = machineName || "SSH";
      title = `[${label}] ${name}`;
    } else if (wsl && cliTool && cliTool !== "none") {
      const toolLabel = cliTool.charAt(0).toUpperCase() + cliTool.slice(1);
      title = `${name} (${toolLabel} WSL)`;
    } else if (cliTool && cliTool !== "none") {
      const toolLabel = cliTool.charAt(0).toUpperCase() + cliTool.slice(1);
      title = `${name} (${toolLabel})`;
    } else if (resumeId === "new") {
      title = `${name} (Claude)`;
    } else if (resumeId) {
      title = `${name} (resume)`;
    } else {
      title = name;
    }
  }
  const terminalLeaf: TerminalPaneLeaf = {
    type: "leaf",
    id: generateId("terminal-pane"),
    launchId: launchId ?? generateId("launch"),
    restoreMode: resolveRestoreMode({
      cliTool: inferCliTool(cliTool, resumeId),
      resumeId,
    }),
    sessionId: sessionId ?? null,
    resumeId,
    workspaceName,
    providerId,
    modelId,
    providerSelection,
    launchProfileId,
    workspacePath,
    workspaceSnapshotId,
    cliTool,
    launchClaude: (cliTool && cliTool !== "none") || undefined,
    ssh,
    wsl,
    machineName,
    launchExtras,
  };

  return {
    id: generateId("tab"),
    title,
    contentType: "terminal",
    projectId,
    projectPath,
    sessionId: terminalLeaf.sessionId,
    resumeId: terminalLeaf.resumeId,
    resumeIdSource: terminalLeaf.resumeIdSource,
    workspaceName: terminalLeaf.workspaceName,
    providerId: terminalLeaf.providerId,
    modelId: terminalLeaf.modelId,
    providerSelection: terminalLeaf.providerSelection,
    launchProfileId: terminalLeaf.launchProfileId,
    workspacePath: terminalLeaf.workspacePath,
    workspaceSnapshotId: terminalLeaf.workspaceSnapshotId,
    cliTool: terminalLeaf.cliTool,
    launchClaude: terminalLeaf.launchClaude,
    ssh: terminalLeaf.ssh,
    wsl: terminalLeaf.wsl,
    machineName: terminalLeaf.machineName,
    terminalRootPane: terminalLeaf,
    activeTerminalPaneId: terminalLeaf.id,
    parentTabId,
    launchExtras: terminalLeaf.launchExtras,
    launchError: terminalLeaf.launchError,
    launchAttempt: terminalLeaf.launchAttempt,
  };
}

function cloneTerminalLeaf(source: TerminalPaneLeaf): TerminalPaneLeaf {
  return {
    ...source,
    id: generateId("terminal-pane"),
    launchId: generateId("launch"),
    restoreMode: resolveRestoreMode({
      cliTool: inferCliTool(source.cliTool, source.launchClaude, source.resumeId),
      resumeId: source.resumeId,
    }),
    sessionId: null,
    disconnected: false,
    restoring: false,
    savedSessionId: undefined,
    restoreBlockedReason: undefined,
    leaseReadOnly: false,
    launchError: undefined,
    launchAttempt: 0,
    // initialPrompt 仅首启生效：分屏克隆的新 leaf 不得重放
    launchExtras: stripInitialPrompt(source.launchExtras),
  };
}

/** 去掉 launchExtras 中的 initialPrompt（防重放）；无其余字段时整体归 undefined */
function stripInitialPrompt(extras: LaunchExtras | undefined): LaunchExtras | undefined {
  if (!extras) return undefined;
  if (extras.initialPrompt === undefined) return extras;
  const { initialPrompt: _initialPrompt, ...rest } = extras;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

export const STARRED_LAYOUT_NAME = "星标";

function createDefaultLayout(name = "布局 1"): LayoutEntry {
  const rootPane = createPanel();
  return {
    id: generateId("layout"),
    name,
    kind: "normal",
    rootPane,
    activePaneId: rootPane.id,
  };
}

function createStarredLayout(): LayoutEntry {
  const rootPane = createPanel();
  return {
    id: generateId("layout"),
    name: STARRED_LAYOUT_NAME,
    kind: "starred",
    rootPane,
    activePaneId: rootPane.id,
  };
}

function ensureStarredLayout(layouts: LayoutEntry[]): LayoutEntry[] {
  const normalLayouts = layouts.filter(isNormalLayout);
  const nextLayouts = normalLayouts.length > 0 ? layouts : [createDefaultLayout(), ...layouts];
  const firstStarred = nextLayouts.find(isStarredLayout);
  const deduped = firstStarred
    ? nextLayouts.filter((layout) => !isStarredLayout(layout) || layout.id === firstStarred.id)
    : [...nextLayouts, createStarredLayout()];

  for (const layout of deduped) {
    if (isStarredLayout(layout)) {
      layout.name = STARRED_LAYOUT_NAME;
    } else if (!layout.kind) {
      layout.kind = "normal";
    }
  }

  return deduped;
}

function ensureStarredLayoutInDraft(state: PanesDraft): string {
  const existing = state.layouts.find(isStarredLayout);
  if (existing) {
    existing.name = STARRED_LAYOUT_NAME;
    return existing.id;
  }
  const layout = createStarredLayout();
  state.layouts.push(layout);
  return layout.id;
}

function findTabAcrossLayouts(state: PanesState, tabId: string): TabAcrossLayoutsLocation | null;
function findTabAcrossLayouts(state: PanesDraft, tabId: string): DraftTabAcrossLayoutsLocation | null;
function findTabAcrossLayouts(
  state: PanesState | PanesDraft,
  tabId: string
): TabAcrossLayoutsLocation | DraftTabAcrossLayoutsLocation | null {
  let found: TabAcrossLayoutsLocation | DraftTabAcrossLayoutsLocation | null = null;
  eachLayoutTree(state as PanesState, (layout, tree) => {
    if (found) return;
    const location = findTabLocation(tree, tabId);
    if (location) {
      found = {
        layoutId: layout.id,
        layoutName: layout.name,
        tree,
        panel: location.panel,
        tab: location.tab,
      };
    }
  });
  return found;
}

function findTabBySessionAcrossLayouts(state: PanesState, sessionId: string): TabAcrossLayoutsLocation | null {
  let found: TabAcrossLayoutsLocation | null = null;
  eachLayoutTree(state, (layout, tree) => {
    if (found) return;
    for (const panel of collectPanels(tree)) {
      const tab = panel.tabs.find((item) => Boolean(findSessionInTab(item, sessionId)));
      if (tab) {
        found = {
          layoutId: layout.id,
          layoutName: layout.name,
          tree,
          panel,
          tab,
        };
        return;
      }
    }
  });
  return found;
}

function findPaneAcrossLayouts(state: PanesState, paneId: string): PaneAcrossLayoutsLocation | null {
  let found: PaneAcrossLayoutsLocation | null = null;
  eachLayoutTree(state, (layout, tree) => {
    if (found) return;
    const pane = findPane(tree, paneId);
    if (pane) {
      found = {
        layoutId: layout.id,
        tree,
        pane,
      };
    }
  });
  return found;
}

function projectedLayouts(
  state: Pick<PanesState, "layouts" | "currentLayoutId" | "rootPane" | "activePaneId">,
  options: { includeStarred?: boolean } = {},
): LayoutEntry[] {
  const layouts = Array.isArray(state.layouts) ? state.layouts : [];
  if (layouts.length === 0) {
    return [{
      id: state.currentLayoutId || generateId("layout"),
      name: "布局 1",
      kind: "normal",
      rootPane: state.rootPane,
      activePaneId: state.activePaneId,
    }];
  }
  return layouts
    .filter((layout) => options.includeStarred || isNormalLayout(layout))
    .map((layout) => (
      layout.id === state.currentLayoutId && isNormalLayout(layout)
      ? {
          ...layout,
          rootPane: state.rootPane,
          activePaneId: state.activePaneId,
        }
      : layout
    ));
}

function ensureLayoutState(
  partial: Partial<Pick<PanesState, "layouts" | "currentLayoutId" | "rootPane" | "activePaneId">>
): Pick<PanesState, "layouts" | "currentLayoutId" | "rootPane" | "activePaneId"> {
  const validLayouts = Array.isArray(partial.layouts)
    ? partial.layouts.filter((layout): layout is LayoutEntry => (
        Boolean(layout)
        && typeof layout.id === "string"
        && typeof layout.name === "string"
        && Boolean(layout.rootPane)
        && typeof layout.activePaneId === "string"
      ))
    : [];

  const layouts = ensureStarredLayout(validLayouts.length > 0
    ? validLayouts
    : [createDefaultLayout()]);

  for (const layout of layouts) {
    if (isStarredLayout(layout)) continue;
    layout.rootPane = flattenPaneTreeForImport(layout.rootPane);
    cleanRehydratedPanes(layout.rootPane);
    const active = findPane(layout.rootPane, layout.activePaneId);
    if (active?.type !== "panel") {
      layout.activePaneId = collectPanels(layout.rootPane)[0]?.id ?? layout.rootPane.id;
    }
  }

  const currentLayoutId = layouts.some((layout) => layout.id === partial.currentLayoutId && isNormalLayout(layout))
    ? partial.currentLayoutId!
    : firstNormalLayout(layouts)!.id;
  const current = layouts.find((layout) => layout.id === currentLayoutId) ?? firstNormalLayout(layouts)!;

  return {
    layouts,
    currentLayoutId,
    rootPane: current.rootPane,
    activePaneId: current.activePaneId,
  };
}


/** 从根到目标节点的 split 祖先链（自顶向下，不含目标本身）；未找到返回 null */
function findAncestorSplits(
  node: PaneNode,
  paneId: string,
  chain: SplitPane[] = []
): SplitPane[] | null {
  if (node.id === paneId) return chain;
  if (node.type === "split") {
    for (const child of node.children) {
      const found = findAncestorSplits(child, paneId, [...chain, node]);
      if (found) return found;
    }
  }
  return null;
}

/**
 * "auto" 方向：与最近一层**真正在分屏**的祖先容器取反，连续分屏即形成螺旋（右、下、右、下…）。
 * 单 child 壳的 direction 是陈旧值（插入时会被改写成新方向），必须跳过，否则首次分屏判反。
 */
function resolveAutoDirection(root: PaneNode, paneId: string): SplitDirection {
  const chain = findAncestorSplits(root, paneId);
  if (!chain) return "right";
  for (let i = chain.length - 1; i >= 0; i--) {
    const ancestor = chain[i];
    if (ancestor.children.length >= 2) {
      return ancestor.direction === "horizontal" ? "down" : "right";
    }
  }
  return "right";
}

/** 各预设的格子数 */
const LAYOUT_PRESET_SLOTS: Record<LayoutPresetId, number> = {
  "single": 1,
  "two-col": 2,
  "three-col": 3,
  "two-row": 2,
  "grid-2x2": 4,
  "main-side": 3,
};

function createSplit(
  direction: SplitPane["direction"],
  children: PaneNode[],
  sizes?: number[]
): SplitPane {
  return {
    type: "split",
    id: generateId("split"),
    direction,
    children,
    sizes: sizes ?? children.map(() => 100 / children.length),
  };
}

// 按预设结构组装分屏树。slots 长度必须等于 LAYOUT_PRESET_SLOTS[preset]。
// rootSplitId 传现有根 split 的 id 以复用其 React key，减少整树 remount。
function buildPresetTree(
  preset: LayoutPresetId,
  slots: Panel[],
  rootSplitId: string | null
): PaneNode {
  let root: PaneNode;
  switch (preset) {
    case "single":
      // 根已是 split 时保留单 child 壳（与 normalizePaneTree 的壳约定一致）
      root = rootSplitId
        ? createSplit("horizontal", [slots[0]], [100])
        : slots[0];
      break;
    case "two-col":
      root = createSplit("horizontal", slots);
      break;
    case "three-col":
      root = createSplit("horizontal", slots);
      break;
    case "two-row":
      root = createSplit("vertical", slots);
      break;
    case "grid-2x2":
      root = createSplit("vertical", [
        createSplit("horizontal", [slots[0], slots[1]]),
        createSplit("horizontal", [slots[2], slots[3]]),
      ]);
      break;
    case "main-side":
      root = createSplit(
        "horizontal",
        [slots[0], createSplit("vertical", [slots[1], slots[2]])],
        [60, 40]
      );
      break;
  }
  if (rootSplitId && root.type === "split") {
    root.id = rootSplitId;
  }
  return root;
}

/** 跳过单 child split 壳，取结构上的有效节点（仅用于结构匹配，不修改树） */
function unwrapShell(node: PaneNode): PaneNode {
  let current = node;
  while (current.type === "split" && current.children.length === 1) {
    current = current.children[0];
  }
  return current;
}

/** 判断当前树结构是否恰好匹配某个预设（用于布局条高亮），不匹配返回 null */
export function matchLayoutPreset(root: PaneNode): LayoutPresetId | null {
  const node = unwrapShell(root);
  if (node.type === "panel") return "single";

  const children = node.children.map(unwrapShell);
  const allPanels = children.every((child) => child.type === "panel");

  if (node.direction === "horizontal") {
    if (children.length === 2 && allPanels) return "two-col";
    if (children.length === 3 && allPanels) return "three-col";
    if (
      children.length === 2
      && children[0].type === "panel"
      && children[1].type === "split"
      && children[1].direction === "vertical"
      && children[1].children.length === 2
      && children[1].children.map(unwrapShell).every((child) => child.type === "panel")
    ) {
      return "main-side";
    }
    return null;
  }

  if (children.length === 2 && allPanels) return "two-row";
  if (
    children.length === 2
    && children.every(
      (child) =>
        child.type === "split"
        && child.direction === "horizontal"
        && child.children.length === 2
        && child.children.map(unwrapShell).every((grand) => grand.type === "panel")
    )
  ) {
    return "grid-2x2";
  }
  return null;
}

// 仅用于快照/持久化加载：压平运行期积累的单 child split 壳链。
// 运行期不得调用（会触发上述 remount）；导出侧（partialize /
// exportLayoutSnapshotPayload）持有活树引用，也不得原地压平。
function flattenPaneTreeForImport(node: PaneNode): PaneNode {
  if (node.type === "panel") {
    for (const tab of node.tabs) {
      if (tab.contentType === "terminal" && tab.terminalRootPane) {
        tab.terminalRootPane = flattenTerminalPaneTreeForImport(tab.terminalRootPane);
      }
    }
    return node;
  }
  node.children = node.children.map((child) => flattenPaneTreeForImport(child));
  if (node.children.length === 1) return node.children[0];
  return node;
}

function flattenTerminalPaneTreeForImport(node: TerminalPaneNode): TerminalPaneNode {
  if (node.type === "leaf") return node;
  node.children = node.children.map((child) => flattenTerminalPaneTreeForImport(child));
  if (node.children.length === 1) return node.children[0];
  return node;
}

const PANES_DEBUG = import.meta.env.DEV;

function summarizePanel(node: PaneNode | null) {
  if (node?.type !== "panel") return null;
  return {
    paneId: node.id,
    activeTabId: node.activeTabId,
    tabs: node.tabs.map((tab) => ({
      tabId: tab.id,
      sessionId: tab.sessionId ?? null,
      cliTool: tab.cliTool ?? (tab.launchClaude ? "claude" : "none"),
      projectPath: tab.projectPath,
    })),
  };
}

function debugPanes(event: string, payload: Record<string, unknown>): void {
  if (!PANES_DEBUG) return;
  devDebugLog("panes-store-debug", event, payload);
}

const initialPanel = createPanel();
const initialLayout: LayoutEntry = {
  id: generateId("layout"),
  name: "布局 1",
  kind: "normal",
  rootPane: initialPanel,
  activePaneId: initialPanel.id,
};
const initialStarredLayout = createStarredLayout();

/** Clean non-restorable runtime state after layout rehydration. */
function cleanRehydratedPanes(node: PaneNode) {
  if (node.type === "panel") {
    for (const tab of node.tabs) {
      if (tab.contentType === "terminal") {
        syncTabTerminalState(tab);
        for (const leaf of collectTerminalLeaves(tab.terminalRootPane)) {
          // 老快照没有 leaf.launchId：迁移时补一个稳定值，首次真正创建 PTY
          // 时 TerminalView 仍会换成新的 one-shot launch id。
          leaf.launchId ??= generateId("launch");
          leaf.restoreMode = resolveRestoreMode({
            cliTool: inferCliTool(
              leaf.cliTool ?? tab.cliTool,
              leaf.launchClaude,
              tab.launchClaude,
              leaf.resumeId,
              tab.resumeId,
            ),
            resumeId: leaf.resumeId,
            hasRestorableSession: Boolean(
              leaf.sessionId || leaf.savedSessionId || leaf.restoring,
            ),
          });
          if (leaf.sessionId) {
            leaf.savedSessionId = leaf.sessionId;
            leaf.restoring = true;
          }
          leaf.sessionId = null;
          if (leaf.resumeId === "new") {
            leaf.resumeId = undefined;
          }
          // restore 路径不得重放 initialPrompt（clearTabInitialPrompt 失败时的兜底）
          leaf.launchExtras = stripInitialPrompt(leaf.launchExtras);
        }
        tab.launchExtras = stripInitialPrompt(tab.launchExtras);
        syncTabTerminalState(tab);
      }
      if (tab.contentType === "editor") {
        tab.dirty = false;
      }
    }
  } else {
    node.children.forEach(cleanRehydratedPanes);
  }
}


export const usePanesStore = create<PanesState>()(
  persist(
  immer((set, get) => ({
    rootPane: initialPanel,
    activePaneId: initialPanel.id,
    layouts: [initialLayout, initialStarredLayout],
    currentLayoutId: initialLayout.id,
    closedTabs: [],
    poppedOutTabs: new Set<string>(),

    allPanels: () => collectPanels(get().rootPane),

    allPanelsAcrossLayouts: () => {
      const panels: Panel[] = [];
      eachLayoutTree(get(), (_layout, tree) => {
        panels.push(...collectPanels(tree));
      });
      return panels;
    },

    activePane: () => {
      if (activeLayout(get())?.kind === "starred") return null;
      const pane = findPane(get().rootPane, get().activePaneId);
      return pane?.type === "panel" ? pane : null;
    },

    findPaneById: (paneId) => findPane(get().rootPane, paneId),

    findPaneAcrossLayouts: (paneId) => findPaneAcrossLayouts(get(), paneId),

    findTabAcrossLayouts: (tabId) => findTabAcrossLayouts(get(), tabId),

    findTabBySessionAcrossLayouts: (sessionId) => findTabBySessionAcrossLayouts(get(), sessionId),

    createLayout: (name) => {
      const id = generateId("layout");
      set((state) => {
        syncWorkingCopyToCurrentLayout(state);
        const rootPane = createPanel();
        const normalLayouts = state.layouts.filter(isNormalLayout);
        const layout: LayoutEntry = {
          id,
          name: (name?.trim() || nextLayoutName(normalLayouts)),
          kind: "normal",
          rootPane,
          activePaneId: rootPane.id,
          lastActiveAt: Date.now(),
        };
        const starredIndex = state.layouts.findIndex(isStarredLayout);
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
        const layout = state.layouts.find((item) => item.id === id);
        if (!layout || isStarredLayout(layout)) return;
        layout.name = trimmed;
      });
    },

    deleteLayout: (id) => {
      let deleted = false;
      let doomedTabIds: string[] = [];
      set((state) => {
        const index = state.layouts.findIndex((layout) => layout.id === id);
        if (index === -1) return;
        const deletingLayout = state.layouts[index];
        if (isStarredLayout(deletingLayout)) return;
        if (state.layouts.filter(isNormalLayout).length <= 1) return;

        syncWorkingCopyToCurrentLayout(state);
        const deletingCurrent = state.currentLayoutId === id;
        state.layouts.splice(index, 1);
        deleted = true;
        // owner 键卫星态只扫「从所有布局彻底消失」的标签——星标镜像同 id
        // 的标签可能仍活在别的布局，扫了会误清活标签的视图/注意状态。
        const survivors = new Set(
          state.layouts.flatMap((layout) =>
            layout.rootPane ? collectTabs(layout.rootPane).map((tab) => tab.id) : [],
          ),
        );
        doomedTabIds = (deletingLayout.rootPane ? collectTabs(deletingLayout.rootPane) : [])
          .map((tab) => tab.id)
          .filter((tabId) => !survivors.has(tabId));

        if (deletingCurrent) {
          const normalLayouts = state.layouts.filter(isNormalLayout);
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
        const target = state.layouts.find((layout) => layout.id === id);
        if (!target) return;
        syncWorkingCopyToCurrentLayout(state);
        state.currentLayoutId = id;
        state.rootPane = target.rootPane;
        state.activePaneId = target.activePaneId;
        target.lastActiveAt = Date.now();
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

    ensureStarredLayout: () => {
      const existing = get().layouts.find(isStarredLayout);
      if (existing) return existing.id;
      let id = "";
      set((state) => {
        id = ensureStarredLayoutInDraft(state);
      });
      return id;
    },

    listLayouts: () => projectedLayouts(get()),

    bindLayoutWorkspace: (layoutId, workspaceName) => {
      const trimmed = workspaceName.trim();
      if (!trimmed) return;
      set((state) => {
        const layout = state.layouts.find((item) => item.id === layoutId);
        if (!layout || isStarredLayout(layout)) return;
        layout.workspaceName = trimmed;
      });
    },

    unbindLayoutWorkspace: (layoutId) => {
      set((state) => {
        const layout = state.layouts.find((item) => item.id === layoutId);
        if (!layout || isStarredLayout(layout)) return;
        layout.workspaceName = undefined;
      });
    },

    autoBindLayoutWorkspaceFromTabs: () => {
      set((state) => {
        const layout = state.layouts.find((item) => item.id === state.currentLayoutId);
        if (!layout || isStarredLayout(layout) || layout.workspaceName?.trim()) return;
        const binding = getLayoutWorkspaceBinding({
          workspaceName: undefined,
          rootPane: state.rootPane,
        });
        if (binding) layout.workspaceName = binding.workspaceName;
      });
    },

    split: (paneId, direction) => {
      const directionMap: Record<SplitDirection, "horizontal" | "vertical"> = {
        right: "horizontal",
        down: "vertical",
      };
      const splitDirection = directionMap[direction];

      set((state) => {
        const parentResult = findParent(state.rootPane, paneId);
        if (!parentResult) return;

        const targetPane = findPane(state.rootPane, paneId);
        if (!targetPane || targetPane.type !== "panel") return;

        const newPane = createPanel();

        if (parentResult.parent === null) {
          const newSplit: SplitPane = {
            type: "split",
            id: generateId("split"),
            direction: splitDirection,
            children: [targetPane, newPane],
            sizes: [50, 50],
          };
          state.rootPane = newSplit;
        } else {
          const parent = parentResult.parent;
          const index = parentResult.index;

          if (parent.children.length === 1) {
            // 单 child 壳：直接改造壳（换方向 + 插入新 pane），不再包一层新 split，
            // 否则父 SplitView 中 key 变化会 remount 幸存终端。
            parent.direction = splitDirection;
            parent.children.push(newPane);
            parent.sizes = [50, 50];
          } else if (parent.direction === splitDirection) {
            parent.children.splice(index + 1, 0, newPane);
            const newSize = 100 / parent.children.length;
            parent.sizes = parent.children.map(() => newSize);
          } else {
            const newSplit: SplitPane = {
              type: "split",
              id: generateId("split"),
              direction: splitDirection,
              children: [targetPane, newPane],
              sizes: [50, 50],
            };
            parent.children[index] = newSplit;
          }
        }

        state.activePaneId = newPane.id;
      });
      notifyTerminalLayoutChanged("pane.split");
    },

    splitRight: (paneId) => get().split(paneId, "right"),
    splitDown: (paneId) => get().split(paneId, "down"),

    openSessionBesidePane: (paneId, direction, opts, layoutId) => {
      const directionMap: Record<SplitDirection, "horizontal" | "vertical"> = {
        right: "horizontal",
        down: "vertical",
      };

      set((state) => {
        const target = resolveLayoutWriteTarget(state, layoutId);
        if (!target) return;
        const tree = target.tree;

        // auto 的解析必须针对**目标布局**那棵树（以前是靠先切布局保证的）。
        const resolvedDirection =
          direction === "auto" ? resolveAutoDirection(tree, paneId) : direction;
        const splitDirection = directionMap[resolvedDirection];

        const targetPane = findPane(tree, paneId);
        const parentResult = findParent(tree, paneId);

        // 无法在该 pane 旁分屏（未找到 / 不是 panel / 找不到父）→ 退化为在该 pane
        // （或首个 panel）加标签，保证会话总能落地。
        if (!targetPane || targetPane.type !== "panel" || !parentResult) {
          const fallback =
            targetPane?.type === "panel" ? targetPane : collectPanels(tree)[0];
          if (!fallback) return;
          const tab = createTab(opts);
          fallback.tabs.push(tab);
          fallback.activeTabId = tab.id;
          target.setActivePaneId(fallback.id);
          return;
        }

        // 目标 pane 本就是空的（如新建布局的空窗格）→ 直接把会话开在里面，
        // 不必分裂出一个多余的空窗格。
        if (targetPane.tabs.length === 0) {
          const tab = createTab(opts);
          targetPane.tabs.push(tab);
          targetPane.activeTabId = tab.id;
          target.setActivePaneId(targetPane.id);
          return;
        }

        // 新窗格：建好就把新会话作为其唯一（激活）标签，避免先空屏再落会话。
        // 必须把会话标签传给 createPanel——无参调用会自带一个默认 "Terminal" 空标签。
        const newPane = createPanel(createTab(opts));

        // 插入 newPane 到 targetPane 旁边（复刻 split 的插入逻辑）。
        if (parentResult.parent === null) {
          target.setRoot({
            type: "split",
            id: generateId("split"),
            direction: splitDirection,
            children: [targetPane, newPane],
            sizes: [50, 50],
          });
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
            const newSplit: SplitPane = {
              type: "split",
              id: generateId("split"),
              direction: splitDirection,
              children: [targetPane, newPane],
              sizes: [50, 50],
            };
            parent.children[index] = newSplit;
          }
        }

        target.setActivePaneId(newPane.id);
      });
      get().autoBindLayoutWorkspaceFromTabs();
      // 只有动了当前布局才需要让在屏终端 refit；改别的布局的树不影响当前渲染
      if (!layoutId || layoutId === get().currentLayoutId) {
        notifyTerminalLayoutChanged("pane.split");
      }
    },

    // 六个关闭出口在 createPaneRemovalActions（文件底部 spread 挂载）。
    applyLayoutPreset: (preset) => {
      set((state) => {
        if (!activateFirstNormalLayout(state)) return;

        const slotCount = LAYOUT_PRESET_SLOTS[preset];
        const existingPanels = collectPanels(state.rootPane);
        const allTabs = existingPanels.flatMap((panel) => panel.tabs);

        // 记住重排前的激活 tab，重排后把焦点跟过去
        const prevActivePane = findPane(state.rootPane, state.activePaneId);
        const prevActiveTabId =
          prevActivePane?.type === "panel" ? prevActivePane.activeTabId : null;
        // 各 panel 的 activeTabId 集合：tab 被分走后优先保持原激活标签仍激活
        const prevActiveTabIds = new Set(
          existingPanels.map((panel) => panel.activeTabId)
        );

        // 顺序填充：前 N-1 格各一个 tab，剩余全部进最后一格；tabs 不足则留空格子
        const slotTabs: Tab[][] = Array.from({ length: slotCount }, () => []);
        allTabs.forEach((tab, index) => {
          slotTabs[Math.min(index, slotCount - 1)].push(tab);
        });

        // 复用现有 Panel id（按序），保住 React key 减少幸存终端 remount。
        // tabs 不足的格子留成空 Panel（tabs: []）：Panel.tsx 对无 activeTab 渲染
        // 空状态，openSessionBesidePane / addTab 均支持往空 pane 落会话。
        const slots: Panel[] = slotTabs.map((tabs, index) => {
          const reused = existingPanels[index];
          const active =
            tabs.find((tab) => reused && tab.id === reused.activeTabId)
            ?? tabs.find((tab) => prevActiveTabIds.has(tab.id))
            ?? tabs[0];
          return {
            type: "panel",
            id: reused?.id ?? generateId("pane"),
            tabs,
            activeTabId: active?.id ?? "",
          };
        });

        const rootSplitId = state.rootPane.type === "split" ? state.rootPane.id : null;
        state.rootPane = buildPresetTree(preset, slots, rootSplitId);

        const focusSlot =
          (prevActiveTabId
            && slots.find((slot) => slot.tabs.some((tab) => tab.id === prevActiveTabId)))
          || slots[0];
        state.activePaneId = focusSlot.id;
      });
      notifyTerminalLayoutChanged("layout.preset");
    },

    resizePanes: (paneId, sizes) => {
      set((state) => {
        const pane = findPane(state.rootPane, paneId);
        if (pane?.type === "split") {
          pane.sizes = sizes;
        }
      });
      notifyTerminalLayoutChanged("pane.resize");
    },

    addTab: (paneId, opts, layoutId) => {
      set((state) => {
        const target = resolveLayoutWriteTarget(state, layoutId);
        if (!target) return;
        const tree = target.tree;
        const fallbackPaneId = target.isCurrent ? state.activePaneId : "";
        const found = findPane(tree, paneId) ?? findPane(tree, fallbackPaneId);
        // 传入 split id（如壳状态下的 rootPane.id）时兜底到第一个 panel。
        const pane = found?.type === "panel" ? found : collectPanels(tree)[0];
        if (!pane) return;

        const newTab = createTab(opts);
        pane.tabs.push(newTab);
        pane.activeTabId = newTab.id;
      });
      get().autoBindLayoutWorkspaceFromTabs();
    },

    togglePinTab: (paneId, tabId) => {
      set((state) => {
        const pane = findPane(state.rootPane, paneId);
        if (pane?.type !== "panel") return;
        const tab = pane.tabs.find((t) => t.id === tabId);
        if (tab) tab.pinned = !tab.pinned;
      });
    },

    toggleStarTab: (tabId) => {
      set((state) => {
        const location = findTabAcrossLayouts(state, tabId);
        if (!location) return;
        location.tab.starred = !location.tab.starred;
        if (location.tab.starred) {
          ensureStarredLayoutInDraft(state);
        }
      });
    },

    starredTabs: () => {
      const shortcuts: StarredTabShortcut[] = [];
      eachLayoutTree(get(), (layout, tree) => {
        for (const panel of collectPanels(tree)) {
          for (const tab of panel.tabs) {
            if (tab.starred) {
              shortcuts.push({
                layoutId: layout.id,
                layoutName: layout.name,
                paneId: panel.id,
                tab,
              });
            }
          }
        }
      });
      return shortcuts;
    },

    openStarredTab: (tabId) => {
      const location = findTabAcrossLayouts(get(), tabId);
      if (!location) return false;
      get().switchLayout(location.layoutId);
      get().selectTab(location.panel.id, tabId);
      return true;
    },

    renameTab: (paneId, tabId, newTitle) => {
      set((state) => {
        const pane = findPane(state.rootPane, paneId);
        if (pane?.type !== "panel") return;
        const tab = pane.tabs.find((t) => t.id === tabId);
        if (tab) tab.title = newTitle;
      });
    },

    reorderTabs: (paneId, fromIndex, toIndex) => {
      set((state) => {
        const pane = findPane(state.rootPane, paneId);
        if (pane?.type !== "panel") return;
        if (fromIndex < 0 || fromIndex >= pane.tabs.length) return;
        if (toIndex < 0 || toIndex >= pane.tabs.length) return;

        const [movedTab] = pane.tabs.splice(fromIndex, 1);
        pane.tabs.splice(toIndex, 0, movedTab);
      });
    },

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

        const targetLayout = state.layouts.find((layout) => layout.id === toLayoutId);
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
          const sourceLayout = state.layouts.find((layout) => layout.id === sourceLocation.layoutId);
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

    selectTab: (paneId, tabId) => {
      let changed = false;
      set((state) => {
        const pane = findPane(state.rootPane, paneId);
        if (pane?.type !== "panel") return;
        changed = pane.activeTabId !== tabId || state.activePaneId !== paneId;
        pane.activeTabId = tabId;
        const tab = pane.tabs.find((item) => item.id === tabId);
        if (tab?.contentType === "terminal") {
          syncTabTerminalState(tab);
        }
        state.activePaneId = paneId;
      });
      if (changed) notifyTerminalLayoutChanged("tab.select");
    },

    setActivePane: (paneId) => {
      let changed = false;
      set((state) => {
        if (state.activePaneId === paneId) return;
        const pane = findPane(state.rootPane, paneId);
        if (pane?.type !== "panel") return;
        state.activePaneId = paneId;
        changed = true;
      });
      if (changed) notifyTerminalLayoutChanged("pane.activate");
    },

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
          : state.layouts.find((item) => item.id === location.layoutId);
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

    updateTabAgentResumeId: (ptySessionId, agentResumeId, resumeIdSource) => {
      let found = false;
      set((state) => {
        const update = (node: PaneNode): boolean => {
          if (node.type === "panel") {
            for (const tab of node.tabs) {
              if (tab.contentType === "terminal" && tab.terminalRootPane) {
                for (const leaf of collectTerminalLeaves(tab.terminalRootPane)) {
                  if (leaf.sessionId === ptySessionId) {
                    leaf.resumeId = agentResumeId;
                    if (resumeIdSource) leaf.resumeIdSource = resumeIdSource;
                    syncTabTerminalState(tab);
                    return true;
                  }
                }
              } else if (tab.sessionId === ptySessionId) {
                tab.resumeId = agentResumeId;
                if (resumeIdSource) tab.resumeIdSource = resumeIdSource;
                return true;
              }
            }
          } else {
            for (const child of node.children) {
              if (update(child)) return true;
            }
          }
          return false;
        };
        eachLayoutTree(state, (_layout, tree) => {
          if (update(tree)) {
            found = true;
          }
        });
      });
      return found;
    },

    updateTabClaudeSession: (ptySessionId, claudeSessionId) => {
      get().updateTabAgentResumeId(ptySessionId, claudeSessionId);
    },

    setTabResumeBinding: (tabId, resumeId, resumeIdSource) => {
      set((state) => {
        const location = findTabAcrossLayouts(state, tabId);
        if (!location || location.tab.contentType !== "terminal") return;
        const tab = location.tab;
        if (tab.terminalRootPane) {
          const leaves = collectTerminalLeaves(tab.terminalRootPane);
          const activeLeaf =
            (tab.activeTerminalPaneId
              ? leaves.find((leaf) => leaf.id === tab.activeTerminalPaneId)
              : null) ?? leaves[0];
          if (activeLeaf) {
            activeLeaf.resumeId = resumeId;
            activeLeaf.resumeIdSource = resumeId ? resumeIdSource : undefined;
          }
          syncTabTerminalState(tab);
        } else {
          tab.resumeId = resumeId;
          tab.resumeIdSource = resumeId ? resumeIdSource : undefined;
        }
      });
    },

    openProjectInPane: (paneId, opts) => {
      const { projectId, resumeId, cliTool } = opts;
      set((state) => {
        if (!activateFirstNormalLayout(state)) return;
        const pane = findPane(state.rootPane, paneId) ?? findPane(state.rootPane, state.activePaneId);
        if (pane?.type !== "panel") return;

        if (resumeId || (cliTool && cliTool !== "none")) {
          const newTab = createTab(opts);
          pane.tabs.push(newTab);
          pane.activeTabId = newTab.id;
          state.activePaneId = pane.id;
          return;
        }

        const existingTab = pane.tabs.find(
          (t) => t.projectId === projectId && !t.resumeId && !t.cliTool
        );
        if (existingTab) {
          pane.activeTabId = existingTab.id;
        } else {
          const activeTab = pane.tabs.find((t) => t.id === pane.activeTabId);
          if (activeTab && !activeTab.projectPath) {
            const tabIndex = pane.tabs.indexOf(activeTab);
            const newTab = createTab({ ...opts, resumeId: undefined });
            pane.tabs.splice(tabIndex, 1, newTab);
            pane.activeTabId = newTab.id;
          } else {
            const newTab = createTab({ ...opts, resumeId: undefined });
            pane.tabs.push(newTab);
            pane.activeTabId = newTab.id;
          }
        }
        state.activePaneId = pane.id;
      });
      get().autoBindLayoutWorkspaceFromTabs();
      // 打开项目/终端 tab 也要落快照——让手机镜像近实时看到新 tab。
      notifyTerminalLayoutChanged("project.open");
    },

    openProject: (opts) => {
      // 布局绑定落位：显式指定目标布局且非当前布局时，先切过去再落位
      const { targetLayoutId } = opts;
      if (targetLayoutId && targetLayoutId !== get().currentLayoutId) {
        const target = get().layouts.find(
          (layout) => layout.id === targetLayoutId && isNormalLayout(layout)
        );
        if (target) {
          get().switchLayout(targetLayoutId);
        }
      }
      if (activeLayout(get())?.kind === "starred") {
        const normal = firstNormalLayout(get().layouts);
        if (normal) {
          get().switchLayout(normal.id);
        }
      }
      const active = get().activePane();
      if (active) {
        get().openProjectInPane(active.id, opts);
      } else {
        // 壳状态下 rootPane 可能是单 child split，兜底到第一个 panel。
        const firstPanel = collectPanels(get().rootPane)[0];
        if (firstPanel) {
          get().openProjectInPane(firstPanel.id, opts);
        }
      }
    },

    nextTab: (paneId) => {
      let changed = false;
      set((state) => {
        const pane = findPane(state.rootPane, paneId);
        if (pane?.type !== "panel" || pane.tabs.length <= 1) return;
        const currentIndex = pane.tabs.findIndex((t) => t.id === pane.activeTabId);
        const nextIndex = (currentIndex + 1) % pane.tabs.length;
        changed = pane.activeTabId !== pane.tabs[nextIndex].id;
        pane.activeTabId = pane.tabs[nextIndex].id;
      });
      if (changed) notifyTerminalLayoutChanged("tab.next");
    },

    prevTab: (paneId) => {
      let changed = false;
      set((state) => {
        const pane = findPane(state.rootPane, paneId);
        if (pane?.type !== "panel" || pane.tabs.length <= 1) return;
        const currentIndex = pane.tabs.findIndex((t) => t.id === pane.activeTabId);
        const prevIndex = (currentIndex - 1 + pane.tabs.length) % pane.tabs.length;
        changed = pane.activeTabId !== pane.tabs[prevIndex].id;
        pane.activeTabId = pane.tabs[prevIndex].id;
      });
      if (changed) notifyTerminalLayoutChanged("tab.prev");
    },

    switchToTab: (paneId, index) => {
      let changed = false;
      set((state) => {
        const pane = findPane(state.rootPane, paneId);
        if (pane?.type !== "panel") return;
        if (index >= 0 && index < pane.tabs.length) {
          changed = pane.activeTabId !== pane.tabs[index].id;
          pane.activeTabId = pane.tabs[index].id;
        }
      });
      if (changed) notifyTerminalLayoutChanged("tab.switch-index");
    },

    minimizeTab: (paneId, tabId) => {
      set((state) => {
        const pane = findPane(state.rootPane, paneId);
        if (pane?.type !== "panel") return;
        const tab = pane.tabs.find((t) => t.id === tabId);
        if (!tab) return;
        tab.minimized = true;
        // If the active tab is minimized, switch to the next visible tab.
        if (pane.activeTabId === tabId) {
          const nextVisible = pane.tabs.find((t) => t.id !== tabId && !t.minimized);
          if (nextVisible) {
            pane.activeTabId = nextVisible.id;
          }
        }
      });
    },

    restoreTab: (paneId, tabId) => {
      set((state) => {
        const pane = findPane(state.rootPane, paneId);
        if (pane?.type !== "panel") return;
        const tab = pane.tabs.find((t) => t.id === tabId);
        if (!tab) return;
        tab.minimized = false;
        pane.activeTabId = tabId;
      });
    },

    reopenClosedTab: (paneId) => {
      const { closedTabs } = get();
      if (closedTabs.length === 0) return;

      const lastClosed = closedTabs[closedTabs.length - 1];
      set((state) => {
        state.closedTabs.pop();
        // 惰性裁剪兜底（严格上限在 removeTabsInternal 的 push 后）
        trimClosedTabs(state.closedTabs);
      });

      // 非终端撤销分流（docs/78）：browser/editor 各走自己的创建入口。
      if (reopenNonTerminalSnapshot(get(), lastClosed)) return;

      get().addTab(paneId, {
        projectId: lastClosed.projectId,
        projectPath: lastClosed.projectPath,
        resumeId: lastClosed.resumeId,
        workspaceName: lastClosed.workspaceName,
        providerId: lastClosed.providerId,
        modelId: lastClosed.modelId,
        providerSelection: lastClosed.providerSelection,
        launchProfileId: lastClosed.launchProfileId,
        workspacePath: lastClosed.workspacePath,
        workspaceSnapshotId: lastClosed.workspaceSnapshotId,
        // title/launchClaude 此前被丢弃（docs/68 §2.2）；写法对齐 Panel.handleCloneTab
        customTitle: lastClosed.title,
        cliTool: lastClosed.cliTool ?? (lastClosed.launchClaude ? "claude" : undefined),
        ssh: lastClosed.ssh,
        wsl: lastClosed.wsl,
        machineName: lastClosed.machineName,
        parentTabId: lastClosed.parentTabId,
      });

      restoreClosedTabIdentity(get(), paneId, lastClosed);
    },

    openMcpConfig: (projectPath, title) => {
      const active = get().activePane();
      if (!active) return;

      // Reuse the existing tab if the project is already open here.
      const existing = active.tabs.find(
        (t) => t.contentType === "mcp-config" && t.projectPath === projectPath
      );
      if (existing) {
        get().selectTab(active.id, existing.id);
        return;
      }

      set((state) => {
        const pane = findPane(state.rootPane, state.activePaneId);
        if (pane?.type !== "panel") return;
        const newTab: Tab = {
          id: generateId("tab"),
          title: `MCP - ${title}`,
          contentType: "mcp-config",
          projectId: "",
          projectPath,
          sessionId: null,
        };
        pane.tabs.push(newTab);
        pane.activeTabId = newTab.id;
      });
    },

    openSkillManager: (projectPath, title) => {
      const active = get().activePane();
      if (!active) return;

      const existing = active.tabs.find(
        (t) => t.contentType === "skill-manager" && t.projectPath === projectPath
      );
      if (existing) {
        get().selectTab(active.id, existing.id);
        return;
      }

      set((state) => {
        const pane = findPane(state.rootPane, state.activePaneId);
        if (pane?.type !== "panel") return;
        const newTab: Tab = {
          id: generateId("tab"),
          title: `Skill - ${title}`,
          contentType: "skill-manager",
          projectId: "",
          projectPath,
          sessionId: null,
        };
        pane.tabs.push(newTab);
        pane.activeTabId = newTab.id;
      });
    },

    openMemoryManager: (projectPath, title) => {
      const active = get().activePane();
      if (!active) return;

      const existing = active.tabs.find(
        (t) => t.contentType === "memory-manager" && t.projectPath === projectPath
      );
      if (existing) {
        get().selectTab(active.id, existing.id);
        return;
      }

      set((state) => {
        const pane = findPane(state.rootPane, state.activePaneId);
        if (pane?.type !== "panel") return;
        const newTab: Tab = {
          id: generateId("tab"),
          title: `Memory - ${title}`,
          contentType: "memory-manager",
          projectId: "",
          projectPath,
          sessionId: null,
        };
        pane.tabs.push(newTab);
        pane.activeTabId = newTab.id;
      });
    },
    ...createBrowserTabActions(set),
    openFileExplorer: (projectPath, title) => {
      const active = get().activePane();
      if (!active) return;

      const existing = active.tabs.find(
        (t) => t.contentType === "file-explorer" && t.projectPath === projectPath
      );
      if (existing) {
        get().selectTab(active.id, existing.id);
        return;
      }

      set((state) => {
        const pane = findPane(state.rootPane, state.activePaneId);
        if (pane?.type !== "panel") return;
        const newTab: Tab = {
          id: generateId("tab"),
          title: `Explorer - ${title}`,
          contentType: "file-explorer",
          projectId: "",
          projectPath,
          sessionId: null,
        };
        pane.tabs.push(newTab);
        pane.activeTabId = newTab.id;
      });
    },

    ...createEditorTabActions(set, get),

    ...createPaneRemovalActions(set, get),
    ...createBackendCloseActions(set),

    setTabDirty: (_paneId, tabId, dirty) => {
      set((state) => {
        const location = findTabAcrossLayouts(state, tabId);
        const tab = location?.tab;
        if (tab) tab.dirty = dirty;
      });
    },

    markTabPoppedOut: (tabId) => {
      set({ poppedOutTabs: new Set(get().poppedOutTabs).add(tabId) });
    },

    markTabReclaimed: (tabId) => {
      const next = new Set(get().poppedOutTabs);
      next.delete(tabId);
      set({ poppedOutTabs: next });
      set((state) => {
        // Bump reclaimKey so TerminalView remounts after a popped-out tab returns.
        const location = findTabAcrossLayouts(state, tabId);
        if (location) {
          location.tab.reclaimKey = (location.tab.reclaimKey ?? 0) + 1;
        }
      });
    },

    isTabPoppedOut: (tabId) => get().poppedOutTabs.has(tabId),

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

    reconnectTab: async (_paneId, tabId, terminalPaneId) => {
      try {
        await ensureListeners();
        await waitForTerminalRestoreBarrierWithDeadline();
        // 屏障完成后立即重读，避免 reconciliation 已认领/阻断该 leaf 后仍按旧快照重建。
        const location = findTabAcrossLayouts(get(), tabId);
        const tab = location?.tab;
        if (!tab || !tab.projectPath) return null;
        const leafId = terminalPaneId ?? tab.activeTerminalPaneId ?? "";
        const terminalLeaf = tab.contentType === "terminal" && tab.terminalRootPane
          ? findTerminalPane(tab.terminalRootPane, leafId)
          : null;
        const leaf = terminalLeaf?.type === "leaf" ? terminalLeaf : null;
        if (leaf?.restoreBlockedReason) return null;
        if (leaf?.sessionId && !leaf.disconnected) return leaf.sessionId;
        const launchId = generateId("launch");
        get().updateTerminalLaunchId(tabId, leafId, launchId);
        const sessionId = await terminalService.createSession({
          launchId,
          projectPath: tab.projectPath,
          cols: 80,
          rows: 24,
          workspaceName: leaf?.workspaceName ?? tab.workspaceName,
          providerId: leaf?.providerId ?? tab.providerId,
          modelId: leaf?.modelId ?? tab.modelId,
          providerSelection: leaf?.providerSelection ?? tab.providerSelection,
          launchProfileId: leaf?.launchProfileId ?? tab.launchProfileId,
          workspacePath: leaf?.workspacePath ?? tab.workspacePath,
          workspaceSnapshotId: leaf?.workspaceSnapshotId ?? tab.workspaceSnapshotId,
          cliTool: leaf?.cliTool ?? tab.cliTool,
          ssh: leaf?.ssh ?? tab.ssh,
          wsl: leaf?.wsl ?? tab.wsl,
          originLayoutId: location?.layoutId,
          originTabId: tabId,
          originTerminalPaneId: leaf?.id,
        });

        // 更新 tab 的 sessionId 和断连状态
        set((state) => {
          const currentLocation = findTabAcrossLayouts(state, tabId);
          const t = currentLocation?.tab;
          if (!t) return;
          if (t.contentType === "terminal" && t.terminalRootPane) {
            const currentLeaf = findTerminalPane(
              t.terminalRootPane,
              terminalPaneId ?? t.activeTerminalPaneId ?? ""
            );
            if (currentLeaf?.type === "leaf") {
              currentLeaf.sessionId = sessionId;
              currentLeaf.disconnected = false;
            }
            syncTabTerminalState(t);
          } else {
            t.sessionId = sessionId;
            t.disconnected = false;
          }
          // Restore the original SSH tab title after reconnection succeeds.
          if (t.ssh && t.machineName) {
            const name = t.projectPath.split(/[/\\]/).pop() || "Terminal";
            t.title = `[${t.machineName}] ${name}`;
          }
        });

        return sessionId;
      } catch (error) {
        console.error("[reconnectTab] Failed to reconnect:", error);
        return null;
      }
    },

    restoreLiveDaemonSessions: (statuses) => {
      const liveSessionIds = new Set(
        statuses
          .filter((status) => status.status !== "exited")
          .map((status) => status.sessionId)
      );
      if (liveSessionIds.size === 0) return 0;

      let restored = 0;
      set((state) => {
        eachLayoutTree(state, (_layout, tree) => {
          for (const panel of collectPanels(tree)) {
            for (const tab of panel.tabs) {
              if (tab.contentType !== "terminal" || !tab.terminalRootPane) continue;
              let changed = false;
              for (const leaf of collectTerminalLeaves(tab.terminalRootPane)) {
                const savedSessionId = leaf.savedSessionId;
                if (!leaf.restoring || !savedSessionId || !liveSessionIds.has(savedSessionId)) {
                  continue;
                }
                leaf.sessionId = savedSessionId;
                leaf.restoring = false;
                leaf.savedSessionId = undefined;
                leaf.restoreMode = "adopted";
                changed = true;
                restored += 1;
              }
              if (changed) {
                syncTabTerminalState(tab);
              }
            }
          }
        });
      });

      return restored;
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

    getRestorableTabs: () => {
      set((state) => {
        eachLayoutTree(state, (_layout, tree) => {
          for (const panel of collectPanels(tree)) {
            for (const tab of panel.tabs) {
              if (tab.contentType === "terminal") {
                syncTabTerminalState(tab);
              }
            }
          }
        });
      });

      const result: Array<{ tab: Tab; paneId: string; layoutId: string }> = [];
      eachLayoutTree(get(), (layout, tree) => {
        for (const panel of collectPanels(tree)) {
          for (const tab of panel.tabs) {
            if (tab.contentType === "terminal" && tab.projectPath) {
              result.push({ tab, paneId: panel.id, layoutId: layout.id });
            }
          }
        }
      });
      return result;
    },

    collectReferencedSessionIds: () => {
      const referenced = new Set<string>();
      const state = get();
      // 不用 eachLayoutTree：它跳过星标布局，而星标布局里的 tab 同样引用会话。
      for (const layout of state.layouts) {
        const tree = layout.id === state.currentLayoutId ? state.rootPane : layout.rootPane;
        if (!tree) continue;
        for (const panel of collectPanels(tree)) {
          for (const tab of panel.tabs) {
            if (tab.contentType !== "terminal") continue;
            if (tab.sessionId) referenced.add(tab.sessionId);
            if (tab.savedSessionId) referenced.add(tab.savedSessionId);
            for (const leaf of collectTerminalLeaves(tab.terminalRootPane)) {
              if (leaf.sessionId) referenced.add(leaf.sessionId);
              if (leaf.savedSessionId) referenced.add(leaf.savedSessionId);
            }
          }
        }
      }
      return referenced;
    },

    setBackgroundRestoreSession: (tabId, terminalPaneId, savedSessionId) => {
      set((state) => {
        const location = findTabAcrossLayouts(state, tabId);
        const tab = location?.tab;
        if (!tab || tab.contentType !== "terminal" || !tab.terminalRootPane) return;
        const leaf = findTerminalPane(tab.terminalRootPane, terminalPaneId);
        if (leaf?.type !== "leaf") return;
        // 后台已为该 leaf 建好会话：写成"可重连的 savedSession"并保持 restoring，
        // 用户切到该布局时 TerminalView 的 deferred 重恢复会 findLiveSavedSessionId 命中并 reattach（不重建）。
        leaf.savedSessionId = savedSessionId;
        leaf.restoring = true;
        leaf.sessionId = null;
        leaf.restoreBlockedReason = undefined;
        leaf.leaseReadOnly = false;
        syncTabTerminalState(tab);
      });
    },

    ...createTerminalColdRestoreActions({ set, findTab: findTabAcrossLayouts, syncTab: syncTabTerminalState, notifyLayoutChanged: notifyTerminalLayoutChanged }),

    setTerminalRestoreBlocked: (tabId, terminalPaneId, reason) => {
      set((state) => {
        const location = findTabAcrossLayouts(state, tabId);
        const tab = location?.tab;
        if (!tab || tab.contentType !== "terminal" || !tab.terminalRootPane) return;
        const leaf = findTerminalPane(tab.terminalRootPane, terminalPaneId);
        if (leaf?.type !== "leaf") return;
        leaf.restoreBlockedReason = reason;
        syncTabTerminalState(tab);
      });
    },

    setSessionLeaseReadOnly: (sessionId, readOnly) => {
      set((state) => {
        for (const layout of state.layouts) {
          const tree = layout.id === state.currentLayoutId ? state.rootPane : layout.rootPane;
          if (!tree) continue;
          for (const panel of collectPanels(tree)) {
            for (const tab of panel.tabs) {
              if (tab.contentType !== "terminal" || !tab.terminalRootPane) continue;
              let changed = false;
              for (const leaf of collectTerminalLeaves(tab.terminalRootPane)) {
                if (leaf.sessionId !== sessionId && leaf.savedSessionId !== sessionId) continue;
                leaf.leaseReadOnly = readOnly;
                changed = true;
              }
              if (changed) syncTabTerminalState(tab);
            }
          }
        }
      });
    },

    canCreateTerminalSession: (
      tabId,
      terminalPaneId,
      expectedSavedSessionId,
      allowLiveExpectedSession = false,
    ) => {
      const location = findTabAcrossLayouts(get(), tabId);
      const tab = location?.tab;
      if (!tab || tab.contentType !== "terminal" || !tab.terminalRootPane) return false;
      const leaf = findTerminalPane(tab.terminalRootPane, terminalPaneId);
      const savedSessionStatus = expectedSavedSessionId
        ? useTerminalStatusStore.getState().statusMap.get(expectedSavedSessionId)
        : undefined;
      return leaf?.type === "leaf"
        && !leaf.sessionId
        && !leaf.restoreBlockedReason
        && leaf.savedSessionId === expectedSavedSessionId
        && (
          allowLiveExpectedSession
          || !savedSessionStatus
          || savedSessionStatus.status === "exited"
        );
    },

    attachSessionToAnchor: (anchor) => {
      // 历史记录缺任一锚点维度时只允许用户显式接管，绝不做启动自动认领。
      if (
        !anchor.layoutId
        || !anchor.tabId
        || !anchor.terminalPaneId
        || !anchor.expectedProjectPath
      ) return false;
      const layoutId = anchor.layoutId;
      const terminalPaneId = anchor.terminalPaneId;
      const expectedProjectPath = anchor.expectedProjectPath;

      let attached = false;
      set((state) => {
        const location = findTabAcrossLayouts(state, anchor.tabId);
        if (!location) return;
        // 锚点带 layoutId 时必须同布局：tab id 理论上全局唯一，但布局快照互相
        // 覆盖过的历史数据里出现过跨布局同 id，宁可不认领。
        if (location.layoutId !== layoutId) return;

        const tab = location.tab;
        if (tab.contentType !== "terminal" || !tab.terminalRootPane) return;

        // 项目身份必须等价。直接比字符串会把 /mnt/d/x 与 D:\x 判成不同项目，
        // 所以走 projectIdentityKey（与 Rust 侧 canonical_project_path 对齐）。
        if (
          !tab.projectPath
          || !projectPathsEquivalent(expectedProjectPath, tab.projectPath)
        ) {
          return;
        }

        const leaves = collectTerminalLeaves(tab.terminalRootPane);
        const leaf = leaves.find((item) => item.id === terminalPaneId);
        if (!leaf) return;
        // 该格子已有活会话或另一个待恢复会话 → 不覆盖。
        if (leaf.sessionId || (leaf.savedSessionId && leaf.savedSessionId !== anchor.sessionId)) return;

        // 同一 PTY 可以已由目标 leaf 的 savedSessionId 引用（应用重启后的正常形态），
        // 但不得在任何其他 leaf/tab 中重复挂载。
        for (const layout of state.layouts) {
          const tree = layout.id === state.currentLayoutId ? state.rootPane : layout.rootPane;
          if (!tree) continue;
          for (const panel of collectPanels(tree)) {
            for (const candidateTab of panel.tabs) {
              if (candidateTab.contentType !== "terminal") continue;
              for (const candidateLeaf of collectTerminalLeaves(candidateTab.terminalRootPane)) {
                if (candidateTab.id === tab.id && candidateLeaf.id === leaf.id) continue;
                if (
                  candidateLeaf.sessionId === anchor.sessionId
                  || candidateLeaf.savedSessionId === anchor.sessionId
                ) return;
              }
            }
          }
        }

        leaf.savedSessionId = anchor.sessionId;
        leaf.restoring = true;
        leaf.sessionId = null;
        leaf.restoreMode = "adopted";
        leaf.restoreBlockedReason = undefined;
        leaf.leaseReadOnly = false;
        syncTabTerminalState(tab);
        attached = true;
      });

      return attached;
    },

    adoptSession: (sessionId, meta) => {
      // 已被本实例某个 tab 引用 → 不重复建，直接把既有 tab 交回给调用方聚焦。
      const existing = get().findTabBySessionAcrossLayouts(sessionId);
      if (existing) return existing.tab.id;

      let adoptedTabId: string | null = null;
      set((state) => {
        if (!activateFirstNormalLayout(state)) return;
        const found = findPane(state.rootPane, state.activePaneId);
        const pane = found?.type === "panel" ? found : collectPanels(state.rootPane)[0];
        if (!pane) return;

        const tab = createTab({
          projectId: meta.projectId ?? sessionId,
          projectPath: meta.projectPath,
          workspaceName: meta.workspaceName,
          workspacePath: meta.workspacePath,
          workspaceSnapshotId: meta.workspaceSnapshotId,
          providerId: meta.providerId,
          modelId: meta.modelId,
          providerSelection: meta.providerSelection,
          launchProfileId: meta.launchProfileId,
          cliTool: meta.cliTool,
          resumeId: meta.resumeId,
          customTitle: meta.customTitle,
          ssh: meta.ssh,
          wsl: meta.wsl,
        });
        const leaf = tab.terminalRootPane;
        if (leaf?.type !== "leaf") return;
        // 与 setBackgroundRestoreSession 同形：写成"可重连的 savedSession"，
        // 由 TerminalView 的恢复路径 reattach 到这条已存在的 PTY，不新建。
        leaf.savedSessionId = sessionId;
        leaf.restoring = true;
        leaf.sessionId = null;
        leaf.restoreMode = "adopted";
        syncTabTerminalState(tab);

        pane.tabs.push(tab);
        pane.activeTabId = tab.id;
        state.activePaneId = pane.id;
        adoptedTabId = tab.id;
      });

      if (adoptedTabId) get().autoBindLayoutWorkspaceFromTabs();
      return adoptedTabId;
    },
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
