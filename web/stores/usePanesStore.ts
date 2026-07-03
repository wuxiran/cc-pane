import { create } from "zustand";
import { persist } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";
import type { Draft } from "immer";
import { useEditorTabsStore } from "./useEditorTabsStore";
import { useActivityBarStore } from "./useActivityBarStore";
import { useFullscreenStore } from "./useFullscreenStore";
import { terminalService, ensureListeners } from "@/services/terminalService";
import { devDebugLog } from "@/utils/devLogger";
import type {
  PaneNode,
  Panel,
  SplitPane,
  LayoutEntry,
  Tab,
  SplitDirection,
  CliTool,
  SshConnectionInfo,
  WslLaunchInfo,
  TerminalPaneNode,
  TerminalPaneLeaf,
  TerminalPaneSplit,
  TerminalStatusInfo,
  LayoutSnapshotPayload,
} from "@/types";

// 生成唯一 ID
function generateId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export const TERMINAL_LAYOUT_CHANGED_EVENT = "cc-panes:terminal-layout-changed";

function notifyTerminalLayoutChanged(reason: string): void {
  if (typeof window === "undefined") return;
  const dispatch = () => {
    window.dispatchEvent(
      new CustomEvent(TERMINAL_LAYOUT_CHANGED_EVENT, {
        detail: { reason },
      })
    );
  };

  if (typeof window.requestAnimationFrame === "function") {
    window.requestAnimationFrame(dispatch);
    return;
  }

  window.setTimeout(dispatch, 0);
}

// 创建新的面板
function createPanel(tab?: Tab): Panel {
  const id = generateId("pane");
  const defaultTab: Tab = tab || createTab({
    projectId: "",
    projectPath: "",
    customTitle: "Terminal",
  });
  return {
    type: "panel",
    id,
    tabs: [defaultTab],
    activeTabId: defaultTab.id,
  };
}

interface CreateTabOptions {
  projectId: string;
  projectPath: string;
  sessionId?: string;
  resumeId?: string;
  workspaceName?: string;
  providerId?: string;
  providerSelection?: Tab["providerSelection"];
  launchProfileId?: string;
  workspacePath?: string;
  workspaceSnapshotId?: string;
  cliTool?: CliTool;
  customTitle?: string;
  ssh?: SshConnectionInfo;
  wsl?: WslLaunchInfo;
  machineName?: string;
  /** Parent tab id for hierarchical numbering (#N.M). Top-level tabs omit it. */
  parentTabId?: string;
}

function createTab(opts: CreateTabOptions): Tab {
  const { projectId, projectPath, sessionId, resumeId, workspaceName, providerId, providerSelection, launchProfileId, workspacePath, workspaceSnapshotId, cliTool, customTitle, ssh, wsl, machineName, parentTabId } = opts;
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
    sessionId: sessionId ?? null,
    resumeId,
    workspaceName,
    providerId,
    providerSelection,
    launchProfileId,
    workspacePath,
    workspaceSnapshotId,
    cliTool,
    launchClaude: (cliTool && cliTool !== "none") || undefined,
    ssh,
    wsl,
    machineName,
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
  };
}

function cloneTerminalLeaf(source: TerminalPaneLeaf): TerminalPaneLeaf {
  return {
    ...source,
    id: generateId("terminal-pane"),
    sessionId: null,
    disconnected: false,
    restoring: false,
    savedSessionId: undefined,
  };
}

function findTerminalPane(node: TerminalPaneNode, paneId: string): TerminalPaneNode | null {
  if (node.id === paneId) return node;
  if (node.type === "split") {
    for (const child of node.children) {
      const found = findTerminalPane(child, paneId);
      if (found) return found;
    }
  }
  return null;
}

function findTerminalPaneParent(
  node: TerminalPaneNode,
  paneId: string,
  parent: TerminalPaneSplit | null = null
): { parent: TerminalPaneSplit | null; index: number } | null {
  if (node.id === paneId) {
    return { parent, index: parent ? parent.children.indexOf(node) : -1 };
  }
  if (node.type === "split") {
    for (let i = 0; i < node.children.length; i += 1) {
      const result = findTerminalPaneParent(node.children[i], paneId, node);
      if (result) return result;
    }
  }
  return null;
}

function collectTerminalLeaves(node?: TerminalPaneNode): TerminalPaneLeaf[] {
  if (!node) return [];
  if (node.type === "leaf") return [node];
  return node.children.flatMap(collectTerminalLeaves);
}

function syncTabTerminalState(tab: Tab): void {
  if (tab.contentType !== "terminal") return;

  if (!tab.terminalRootPane) {
    const fallbackLeaf: TerminalPaneLeaf = {
      type: "leaf",
      id: generateId("terminal-pane"),
      sessionId: tab.sessionId ?? null,
      resumeId: tab.resumeId,
      resumeIdSource: tab.resumeIdSource,
      workspaceName: tab.workspaceName,
      providerId: tab.providerId,
      providerSelection: tab.providerSelection,
      launchProfileId: tab.launchProfileId,
      workspacePath: tab.workspacePath,
      workspaceSnapshotId: tab.workspaceSnapshotId,
      cliTool: tab.cliTool,
      launchClaude: tab.launchClaude,
      ssh: tab.ssh,
      wsl: tab.wsl,
      machineName: tab.machineName,
      disconnected: tab.disconnected,
      restoring: tab.restoring,
      savedSessionId: tab.savedSessionId,
    };
    tab.terminalRootPane = fallbackLeaf;
    tab.activeTerminalPaneId = fallbackLeaf.id;
  }

  const leaves = collectTerminalLeaves(tab.terminalRootPane);
  if (leaves.length === 0) return;

  const activeLeaf =
    (tab.activeTerminalPaneId
      ? leaves.find((leaf) => leaf.id === tab.activeTerminalPaneId)
      : null) ?? leaves[0];

  tab.activeTerminalPaneId = activeLeaf.id;
  tab.sessionId = activeLeaf.sessionId;
  tab.resumeId = activeLeaf.resumeId;
  tab.resumeIdSource = activeLeaf.resumeIdSource;
  tab.workspaceName = activeLeaf.workspaceName;
  tab.providerId = activeLeaf.providerId;
  tab.providerSelection = activeLeaf.providerSelection;
  tab.launchProfileId = activeLeaf.launchProfileId;
  tab.workspacePath = activeLeaf.workspacePath;
  tab.workspaceSnapshotId = activeLeaf.workspaceSnapshotId;
  tab.cliTool = activeLeaf.cliTool;
  tab.launchClaude = activeLeaf.launchClaude;
  tab.ssh = activeLeaf.ssh;
  tab.wsl = activeLeaf.wsl;
  tab.machineName = activeLeaf.machineName;
  tab.disconnected = activeLeaf.disconnected;
  tab.restoring = activeLeaf.restoring;
  tab.savedSessionId = activeLeaf.savedSessionId;
}

function findTabLocation(rootPane: PaneNode, tabId: string): { panel: Panel; tab: Tab } | null {
  for (const panel of collectPanels(rootPane)) {
    const tab = panel.tabs.find((item) => item.id === tabId);
    if (tab) return { panel, tab };
  }
  return null;
}

type PanesDraft = Draft<PanesState>;
type LayoutDraft = Draft<LayoutEntry>;
type PaneNodeDraft = Draft<PaneNode>;
type PanelDraft = Draft<Panel>;
type TabDraft = Draft<Tab>;

interface TabAcrossLayoutsLocation {
  layoutId: string;
  layoutName: string;
  tree: PaneNode;
  panel: Panel;
  tab: Tab;
}

interface PaneAcrossLayoutsLocation {
  layoutId: string;
  tree: PaneNode;
  pane: PaneNode;
}

interface DraftTabAcrossLayoutsLocation {
  layoutId: string;
  layoutName: string;
  tree: PaneNodeDraft;
  panel: PanelDraft;
  tab: TabDraft;
}

export interface StarredTabShortcut {
  layoutId: string;
  layoutName: string;
  paneId: string;
  tab: Tab;
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

function isStarredLayout(layout: Pick<LayoutEntry, "kind">): boolean {
  return layout.kind === "starred";
}

function isNormalLayout(layout: Pick<LayoutEntry, "kind">): boolean {
  return !isStarredLayout(layout);
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

function firstNormalLayout(layouts: LayoutEntry[]): LayoutEntry | undefined {
  return layouts.find(isNormalLayout);
}

function activeLayout(state: PanesState | PanesDraft): LayoutEntry | LayoutDraft | undefined {
  return state.layouts.find((layout) => layout.id === state.currentLayoutId);
}

function activateFirstNormalLayout(state: PanesDraft): boolean {
  const current = activeLayout(state);
  if (current && isNormalLayout(current)) return true;
  const normal = firstNormalLayout(state.layouts);
  if (!normal) return false;
  state.currentLayoutId = normal.id;
  state.rootPane = normal.rootPane;
  state.activePaneId = normal.activePaneId;
  return true;
}

function nextLayoutName(layouts: Array<Pick<LayoutEntry, "name">>): string {
  const used = new Set(layouts.map((layout) => layout.name.trim()));
  let index = layouts.length + 1;
  while (used.has(`布局 ${index}`)) {
    index += 1;
  }
  return `布局 ${index}`;
}

function layoutTree(
  state: PanesState | PanesDraft,
  layoutId: string
): PaneNode | PaneNodeDraft | null {
  const layout = state.layouts.find((item) => item.id === layoutId);
  if (!layout || isStarredLayout(layout)) return null;
  if (layoutId === state.currentLayoutId) return state.rootPane;
  return layout.rootPane;
}

function eachLayoutTree(state: PanesState, fn: (layout: LayoutEntry, tree: PaneNode) => void): void;
function eachLayoutTree(
  state: PanesDraft,
  fn: (layout: LayoutDraft, tree: PaneNodeDraft) => void
): void;
function eachLayoutTree(
  state: PanesState | PanesDraft,
  fn: (layout: LayoutEntry | LayoutDraft, tree: PaneNode | PaneNodeDraft) => void
): void {
  for (const layout of state.layouts) {
    if (isStarredLayout(layout)) continue;
    const tree = layoutTree(state, layout.id);
    if (tree) {
      fn(layout, tree);
    }
  }
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

/// 跨全部布局按 filePath 找 editor tab（分屏区文件去重/关闭/查询共用）
function findEditorTabByPathAcrossLayouts(
  state: PanesState,
  filePath: string
): TabAcrossLayoutsLocation | null {
  let found: TabAcrossLayoutsLocation | null = null;
  eachLayoutTree(state, (layout, tree) => {
    if (found) return;
    for (const panel of collectPanels(tree)) {
      const tab = panel.tabs.find(
        (item) => item.contentType === "editor" && item.filePath === filePath
      );
      if (tab) {
        found = { layoutId: layout.id, layoutName: layout.name, tree, panel, tab };
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

function syncWorkingCopyToCurrentLayout(state: PanesDraft): void {
  const current = activeLayout(state);
  if (!current || isStarredLayout(current)) return;
  current.rootPane = state.rootPane;
  current.activePaneId = state.activePaneId;
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

function findSessionInTab(tab: Tab, sessionId: string): TerminalPaneLeaf | null {
  if (tab.contentType === "terminal" && tab.terminalRootPane) {
    return collectTerminalLeaves(tab.terminalRootPane)
      .find((leaf) => leaf.sessionId === sessionId) ?? null;
  }
  return tab.sessionId === sessionId
    ? {
        type: "leaf",
        id: tab.id,
        sessionId,
      }
    : null;
}

function closeTabInTree(rootPane: PaneNode, paneId: string, tabId: string): PaneNode {
  const pane = findPane(rootPane, paneId);
  if (pane?.type !== "panel") return rootPane;
  const idx = pane.tabs.findIndex((tab) => tab.id === tabId);
  if (idx === -1 || pane.tabs[idx].pinned) return rootPane;

  if (pane.tabs.length > 1) {
    pane.tabs.splice(idx, 1);
    if (pane.activeTabId === tabId) {
      const nextIdx = Math.min(idx, pane.tabs.length - 1);
      pane.activeTabId = pane.tabs[nextIdx].id;
    }
    return rootPane;
  }

  const parentResult = findParent(rootPane, paneId);
  if (!parentResult) return rootPane;

  if (parentResult.parent === null) {
    return createPanel();
  }

  const parent = parentResult.parent;
  parent.children.splice(parentResult.index, 1);
  parent.sizes.splice(parentResult.index, 1);
  const total = parent.sizes.reduce((sum, size) => sum + size, 0);
  parent.sizes = total > 0
    ? parent.sizes.map((size) => (size / total) * 100)
    : parent.sizes.map(() => 100 / parent.sizes.length);

  return normalizePaneTree(rootPane);
}

function closeTerminalLeafInTab(tab: Tab, terminalPaneId: string): boolean {
  if (tab.contentType !== "terminal" || !tab.terminalRootPane) return false;
  const leaves = collectTerminalLeaves(tab.terminalRootPane);
  if (leaves.length <= 1) return false;

  const parentResult = findTerminalPaneParent(tab.terminalRootPane, terminalPaneId);
  if (!parentResult || parentResult.parent === null) return false;

  const parent = parentResult.parent;
  parent.children.splice(parentResult.index, 1);
  parent.sizes.splice(parentResult.index, 1);

  if (parent.children.length === 1) {
    const gpResult = findTerminalPaneParent(tab.terminalRootPane, parent.id);
    if (!gpResult || gpResult.parent === null) {
      tab.terminalRootPane = parent.children[0];
    } else {
      gpResult.parent.children[gpResult.index] = parent.children[0];
    }
  } else {
    const total = parent.sizes.reduce((sum, size) => sum + size, 0);
    parent.sizes = total > 0
      ? parent.sizes.map((size) => (size / total) * 100)
      : parent.sizes.map(() => 100 / parent.sizes.length);
  }

  const nextLeaves = collectTerminalLeaves(tab.terminalRootPane);
  tab.activeTerminalPaneId = nextLeaves[Math.min(parentResult.index, nextLeaves.length - 1)]?.id;
  syncTabTerminalState(tab);
  return true;
}

function findPane(node: PaneNode, paneId: string): PaneNode | null {
  if (node.id === paneId) return node;
  if (node.type === "split") {
    for (const child of node.children) {
      const found = findPane(child, paneId);
      if (found) return found;
    }
  }
  return null;
}

// 查找父节点
function findParent(
  node: PaneNode,
  paneId: string,
  parent: SplitPane | null = null
): { parent: SplitPane | null; index: number } | null {
  if (node.id === paneId) {
    return { parent, index: parent ? parent.children.indexOf(node) : -1 };
  }
  if (node.type === "split") {
    for (let i = 0; i < node.children.length; i++) {
      const result = findParent(node.children[i], paneId, node);
      if (result) return result;
    }
  }
  return null;
}

// Flatten all panels in the pane tree.
function collectPanels(node: PaneNode): Panel[] {
  if (node.type === "panel") return [node];
  return node.children.flatMap(collectPanels);
}

function normalizePaneTree(root: PaneNode): PaneNode {
  if (root.type === "panel") return root;

  root.children = root.children.map((child) => normalizePaneTree(child));

  if (root.children.length === 0) {
    return createPanel();
  }

  if (root.children.length === 1) {
    return root.children[0];
  }

  const total = root.sizes.reduce((sum, size) => sum + size, 0);
  root.sizes = total > 0
    ? root.sizes.map((size) => (size / total) * 100)
    : root.children.map(() => 100 / root.children.length);

  return root;
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

/** Snapshot of a closed tab so it can be reopened later. */
interface ClosedTabSnapshot {
  projectId: string;
  projectPath: string;
  title: string;
  resumeId?: string;
  workspaceName?: string;
  providerId?: string;
  providerSelection?: Tab["providerSelection"];
  launchProfileId?: string;
  workspacePath?: string;
  workspaceSnapshotId?: string;
  launchClaude?: boolean;
  cliTool?: CliTool;
  ssh?: SshConnectionInfo;
  wsl?: WslLaunchInfo;
  machineName?: string;
}

interface PanesState {
  rootPane: PaneNode;
  activePaneId: string;
  layouts: LayoutEntry[];
  currentLayoutId: string;
  closedTabs: ClosedTabSnapshot[];
  poppedOutTabs: Set<string>;

  // Derived helpers
  allPanels: () => Panel[];
  allPanelsAcrossLayouts: () => Panel[];
  activePane: () => Panel | null;
  findPaneById: (paneId: string) => PaneNode | null;
  findPaneAcrossLayouts: (paneId: string) => PaneAcrossLayoutsLocation | null;
  findTabAcrossLayouts: (tabId: string) => TabAcrossLayoutsLocation | null;
  findTabBySessionAcrossLayouts: (sessionId: string) => TabAcrossLayoutsLocation | null;

  // Layouts
  createLayout: (name?: string) => string;
  renameLayout: (id: string, name: string) => void;
  deleteLayout: (id: string) => void;
  switchLayout: (id: string) => void;
  switchLayoutByIndex: (index: number) => void;
  reorderLayouts: (fromIndex: number, toIndex: number) => void;
  ensureStarredLayout: () => string;
  listLayouts: () => LayoutEntry[];

  // Pane layout
  split: (paneId: string, direction: SplitDirection) => void;
  splitRight: (paneId: string) => void;
  splitDown: (paneId: string) => void;
  closePane: (paneId: string) => void;
  resizePanes: (paneId: string, sizes: number[]) => void;

  // Tabs
  addTab: (paneId: string, opts: CreateTabOptions) => void;
  closeTab: (paneId: string, tabId: string) => void;
  togglePinTab: (paneId: string, tabId: string) => void;
  toggleStarTab: (tabId: string) => void;
  starredTabs: () => StarredTabShortcut[];
  openStarredTab: (tabId: string) => boolean;
  renameTab: (paneId: string, tabId: string, newTitle: string) => void;
  reorderTabs: (paneId: string, fromIndex: number, toIndex: number) => void;
  moveTab: (fromPaneId: string, toPaneId: string, tabId: string, toIndex?: number) => void;
  moveTabToLayoutPane: (
    fromPaneId: string,
    toLayoutId: string,
    tabId: string,
    toPaneId?: string,
    toIndex?: number
  ) => void;
  splitAndMoveTab: (paneId: string, tabId: string, direction: SplitDirection) => void;
  closeTabsToLeft: (paneId: string, tabId: string) => void;
  closeTabsToRight: (paneId: string, tabId: string) => void;
  closeOtherTabs: (paneId: string, tabId: string) => void;
  selectTab: (paneId: string, tabId: string) => void;
  setActivePane: (paneId: string) => void;
  updateTabSession: (paneId: string, tabId: string, sessionId: string, terminalPaneId?: string) => void;
  setActiveTerminalPane: (tabId: string, terminalPaneId: string) => void;
  splitTerminalPane: (tabId: string, terminalPaneId: string, direction: SplitDirection) => void;
  closeTerminalPane: (tabId: string, terminalPaneId: string) => void;
  resizeTerminalPanes: (tabId: string, terminalPaneId: string, sizes: number[]) => void;
  openProject: (opts: CreateTabOptions) => void;
  openProjectInPane: (paneId: string, opts: CreateTabOptions) => void;
  nextTab: (paneId: string) => void;
  prevTab: (paneId: string) => void;
  switchToTab: (paneId: string, index: number) => void;
  minimizeTab: (paneId: string, tabId: string) => void;
  restoreTab: (paneId: string, tabId: string) => void;
  reopenClosedTab: (paneId: string) => void;
  openMcpConfig: (projectPath: string, title: string) => void;
  openSkillManager: (projectPath: string, title: string) => void;
  openMemoryManager: (projectPath: string, title: string) => void;
  openFileExplorer: (projectPath: string, title: string) => void;
  openEditor: (projectPath: string, filePath: string, title: string) => void;
  /** 跨全部布局关闭指定文件的 editor tab（MCP close_file 用） */
  closeEditorTabsByPath: (filePath: string) => void;
  /** 跨全部布局枚举分屏区 editor tab（MCP list_open_files 用） */
  listEditorTabsAcrossLayouts: () => Array<{
    filePath: string;
    projectPath: string;
    title: string;
    dirty: boolean;
    pinned: boolean;
    active: boolean;
  }>;
  setTabDirty: (paneId: string, tabId: string, dirty: boolean) => void;
  markTabPoppedOut: (tabId: string) => void;
  markTabReclaimed: (tabId: string) => void;
  isTabPoppedOut: (tabId: string) => boolean;
  /** 返回是否命中某个 tab（事件可能早于 tab.sessionId 写入到达，未命中时调用方应重试） */
  updateTabAgentResumeId: (ptySessionId: string, agentResumeId: string, resumeIdSource?: string) => boolean;
  /** 手动绑定/换绑某个 tab 的会话 resume id（SessionBindDialog 用，source=manual） */
  setTabResumeBinding: (tabId: string, resumeId: string | undefined, resumeIdSource?: string) => void;
  /** @deprecated Use updateTabAgentResumeId; kept for persisted callers and older UI code. */
  updateTabClaudeSession: (ptySessionId: string, claudeSessionId: string) => void;
  setTabDisconnected: (paneId: string, tabId: string, disconnected: boolean, terminalPaneId?: string) => void;
  reconnectTab: (paneId: string, tabId: string, terminalPaneId?: string) => Promise<string | null>;
  closeTabBySessionId: (sessionId: string) => void;
  restoreLiveDaemonSessions: (statuses: TerminalStatusInfo[]) => number;
  exportLayoutSnapshotPayload: () => LayoutSnapshotPayload;
  applyLayoutSnapshotPayload: (payload: LayoutSnapshotPayload) => boolean;
  /** Clear restoring metadata after a terminal tab finishes recovery. */
  clearRestoring: (paneId: string, tabId: string, terminalPaneId?: string) => void;
  /** Collect terminal tabs that can be restored after restart. */
  getRestorableTabs: () => Array<{ tab: Tab; paneId: string; layoutId: string }>;
  setBackgroundRestoreSession: (tabId: string, savedSessionId: string) => void;
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
          if (leaf.sessionId) {
            leaf.savedSessionId = leaf.sessionId;
            leaf.restoring = true;
          }
          leaf.sessionId = null;
          if (leaf.resumeId === "new") {
            leaf.resumeId = undefined;
          }
        }
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

          if (parent.direction === splitDirection) {
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

    closePane: (paneId) => {
      // 保存可恢复标签
      const closingPane = findPane(get().rootPane, paneId);
      if (closingPane?.type === "panel") {
        const recoverableTabs: ClosedTabSnapshot[] = closingPane.tabs
          .filter((t) => t.projectPath && t.contentType === "terminal")
          .map((t) => ({
            projectId: t.projectId,
            projectPath: t.projectPath,
            title: t.title,
            resumeId: t.resumeId,
            workspaceName: t.workspaceName,
            providerId: t.providerId,
            providerSelection: t.providerSelection,
            launchProfileId: t.launchProfileId,
            workspacePath: t.workspacePath,
            workspaceSnapshotId: t.workspaceSnapshotId,
            launchClaude: t.launchClaude,
            cliTool: t.cliTool,
            ssh: t.ssh,
            wsl: t.wsl,
            machineName: t.machineName,
          }));
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

    resizePanes: (paneId, sizes) => {
      set((state) => {
        const pane = findPane(state.rootPane, paneId);
        if (pane?.type === "split") {
          pane.sizes = sizes;
        }
      });
      notifyTerminalLayoutChanged("pane.resize");
    },

    addTab: (paneId, opts) => {
      set((state) => {
        if (!activateFirstNormalLayout(state)) return;
        const pane = findPane(state.rootPane, paneId) ?? findPane(state.rootPane, state.activePaneId);
        if (pane?.type !== "panel") return;

        const newTab = createTab(opts);
        pane.tabs.push(newTab);
        pane.activeTabId = newTab.id;
      });
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

      // closePane uses its own state update, so do this after the move completes.
      const fromPane = findPane(get().rootPane, fromPaneId);
      if (fromPane?.type === "panel" && fromPane.tabs.length === 0) {
        debugPanes("moveTab.close-empty-pane", {
          paneId: fromPaneId,
          tabId,
        });
        get().closePane(fromPaneId);

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

      if (closeEmptyCurrentSource) {
        get().closePane(fromPaneId);
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

    closeTab: (paneId, tabId) => {
      const snapshot = get();
      const snapPane = findPane(snapshot.rootPane, paneId);
      if (snapPane?.type !== "panel") return;
      const snapTab = snapPane.tabs.find((t) => t.id === tabId);
      if (!snapTab || snapTab.pinned) return;

      // 保存可恢复标签
      if (snapTab.projectPath && snapTab.contentType === "terminal") {
        set((state) => {
          state.closedTabs.push({
            projectId: snapTab.projectId,
            projectPath: snapTab.projectPath,
            title: snapTab.title,
            resumeId: snapTab.resumeId,
            workspaceName: snapTab.workspaceName,
            providerId: snapTab.providerId,
            providerSelection: snapTab.providerSelection,
            launchProfileId: snapTab.launchProfileId,
            workspacePath: snapTab.workspacePath,
            workspaceSnapshotId: snapTab.workspaceSnapshotId,
            launchClaude: snapTab.launchClaude,
            cliTool: snapTab.cliTool,
            ssh: snapTab.ssh,
            wsl: snapTab.wsl,
            machineName: snapTab.machineName,
          });
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
        syncTabTerminalState(tab);
      });
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

        if (parent.children.length === 1) {
          const gpResult = findTerminalPaneParent(tab.terminalRootPane, parent.id);
          if (!gpResult || gpResult.parent === null) {
            tab.terminalRootPane = parent.children[0];
          } else {
            gpResult.parent.children[gpResult.index] = parent.children[0];
          }
        } else {
          const total = parent.sizes.reduce((sum, size) => sum + size, 0);
          parent.sizes = parent.sizes.map((size) => (size / total) * 100);
        }

        const nextLeaves = collectTerminalLeaves(tab.terminalRootPane);
        tab.activeTerminalPaneId = nextLeaves[Math.min(parentResult.index, nextLeaves.length - 1)]?.id;
        syncTabTerminalState(tab);
      });
      notifyTerminalLayoutChanged("terminal.close");
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
    },

    openProject: (opts) => {
      if (activeLayout(get())?.kind === "starred") {
        const normal = firstNormalLayout(get().layouts);
        if (normal) {
          get().switchLayout(normal.id);
        }
      }
      const active = get().activePane();
      if (active) {
        get().openProjectInPane(active.id, opts);
      } else if (get().rootPane.type === "panel") {
        get().openProjectInPane(get().rootPane.id, opts);
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
      });

      get().addTab(paneId, {
        projectId: lastClosed.projectId,
        projectPath: lastClosed.projectPath,
        resumeId: lastClosed.resumeId,
        workspaceName: lastClosed.workspaceName,
        providerId: lastClosed.providerId,
        providerSelection: lastClosed.providerSelection,
        launchProfileId: lastClosed.launchProfileId,
        workspacePath: lastClosed.workspacePath,
        workspaceSnapshotId: lastClosed.workspaceSnapshotId,
        cliTool: lastClosed.cliTool,
        ssh: lastClosed.ssh,
        wsl: lastClosed.wsl,
        machineName: lastClosed.machineName,
      });
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

    openEditor: (projectPath, filePath, title) => {
      // Files 视图不渲染分屏区：留在该视图的编辑面板内打开
      // （useEditorTabsStore.openFile 自带去重与 recentFiles 登记）。
      const activity = useActivityBarStore.getState();
      if (activity.appViewMode === "files") {
        useEditorTabsStore.getState().openFile(projectPath, filePath, title);
        return;
      }

      // 分屏区路径也要登记最近文件（RecentFilesPicker 数据源在 useEditorTabsStore）
      useEditorTabsStore
        .getState()
        .addRecent({ filePath, projectPath, title, openedAt: Date.now() });

      // home/todo/providers 等视图看不到分屏区：切回 panes 保证"打开必可见"
      if (activity.appViewMode !== "panes") {
        activity.setAppViewMode("panes");
      }

      // 跨全部布局按 filePath 去重：同一文件双缓冲编辑会互相覆盖，聚焦已有 tab
      const found = findEditorTabByPathAcrossLayouts(get(), filePath);
      if (found) {
        if (found.layoutId !== get().currentLayoutId) {
          get().switchLayout(found.layoutId);
        }
        get().selectTab(found.panel.id, found.tab.id);
        return;
      }

      set((state) => {
        const pane = findPane(state.rootPane, state.activePaneId);
        if (pane?.type !== "panel") return;
        const newTab: Tab = {
          id: generateId("tab"),
          title,
          contentType: "editor",
          projectId: "",
          projectPath,
          sessionId: null,
          filePath,
        };
        pane.tabs.push(newTab);
        pane.activeTabId = newTab.id;
      });
    },

    closeEditorTabsByPath: (filePath) => {
      // 当前布局：走 closeTab（保持 activeTab 收敛等既有语义）
      for (const panel of collectPanels(get().rootPane)) {
        const tab = panel.tabs.find(
          (t) => t.contentType === "editor" && t.filePath === filePath
        );
        if (tab) get().closeTab(panel.id, tab.id);
      }
      // 其他布局：直接从各自布局树移除
      set((state) => {
        for (const layout of state.layouts) {
          if (layout.id === state.currentLayoutId || isStarredLayout(layout)) continue;
          for (const panel of collectPanels(layout.rootPane)) {
            const idx = panel.tabs.findIndex(
              (t) => t.contentType === "editor" && t.filePath === filePath
            );
            if (idx === -1) continue;
            panel.tabs.splice(idx, 1);
            if (panel.activeTabId && !panel.tabs.some((t) => t.id === panel.activeTabId)) {
              panel.activeTabId = panel.tabs[panel.tabs.length - 1]?.id ?? null;
            }
          }
        }
      });
    },

    listEditorTabsAcrossLayouts: () => {
      const state = get();
      const result: Array<{
        filePath: string;
        projectPath: string;
        title: string;
        dirty: boolean;
        pinned: boolean;
        active: boolean;
      }> = [];
      eachLayoutTree(state, (layout, tree) => {
        for (const panel of collectPanels(tree)) {
          for (const t of panel.tabs) {
            if (t.contentType !== "editor" || !t.filePath) continue;
            result.push({
              filePath: t.filePath,
              projectPath: t.projectPath,
              title: t.title,
              dirty: t.dirty ?? false,
              pinned: t.pinned ?? false,
              active:
                layout.id === state.currentLayoutId &&
                panel.activeTabId === t.id &&
                state.activePaneId === panel.id,
            });
          }
        }
      });
      return result;
    },

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
      // 从 Tab 数据中提取创建参数
      const snapshot = get();
      const location = findTabAcrossLayouts(snapshot, tabId);
      const tab = location?.tab;
      if (!tab || !tab.projectPath) return null;
      const terminalLeaf =
        tab.contentType === "terminal" && tab.terminalRootPane
          ? findTerminalPane(tab.terminalRootPane, terminalPaneId ?? tab.activeTerminalPaneId ?? "")
          : null;
      const leaf = terminalLeaf?.type === "leaf" ? terminalLeaf : null;

      try {
        await ensureListeners();
        const sessionId = await terminalService.createSession({
          projectPath: tab.projectPath,
          cols: 80,
          rows: 24,
          workspaceName: leaf?.workspaceName ?? tab.workspaceName,
          providerId: leaf?.providerId ?? tab.providerId,
          providerSelection: leaf?.providerSelection ?? tab.providerSelection,
          launchProfileId: leaf?.launchProfileId ?? tab.launchProfileId,
          workspacePath: leaf?.workspacePath ?? tab.workspacePath,
          workspaceSnapshotId: leaf?.workspaceSnapshotId ?? tab.workspaceSnapshotId,
          cliTool: leaf?.cliTool ?? tab.cliTool,
          ssh: leaf?.ssh ?? tab.ssh,
          wsl: leaf?.wsl ?? tab.wsl,
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

    closeTabBySessionId: (sessionId) => {
      set((state) => {
        let handled = false;
        eachLayoutTree(state, (layout, tree) => {
          if (handled) return;
          for (const panel of collectPanels(tree)) {
            const tab = panel.tabs.find((item) => Boolean(findSessionInTab(item, sessionId)));
            if (!tab) continue;
            const leaf = findSessionInTab(tab, sessionId);
            if (leaf && closeTerminalLeafInTab(tab, leaf.id)) {
              handled = true;
              return;
            }
            const nextTree = closeTabInTree(tree, panel.id, tab.id);
            if (layout.id === state.currentLayoutId) {
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
            handled = true;
            return;
          }
        });
      });
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
        schemaVersion: 1,
        layouts: projectedLayouts(state, { includeStarred: true }),
        currentLayoutId: state.currentLayoutId,
      };
    },

    applyLayoutSnapshotPayload: (payload) => {
      if (!payload || !Array.isArray(payload.layouts)) return false;
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
            }
            syncTabTerminalState(tab);
          } else {
            tab.restoring = false;
            tab.savedSessionId = undefined;
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

    setBackgroundRestoreSession: (tabId, savedSessionId) => {
      set((state) => {
        const location = findTabAcrossLayouts(state, tabId);
        const tab = location?.tab;
        if (!tab || tab.contentType !== "terminal" || !tab.terminalRootPane) return;
        const leaf = findTerminalPane(tab.terminalRootPane, tab.activeTerminalPaneId ?? "");
        if (leaf?.type !== "leaf") return;
        // 后台已为该 tab 建好会话：写成"可重连的 savedSession"并保持 restoring，
        // 用户切到该布局时 TerminalView 的 deferred 重恢复会 findLiveSavedSessionId 命中并 reattach（不重建）。
        leaf.savedSessionId = savedSessionId;
        leaf.restoring = true;
        leaf.sessionId = null;
        syncTabTerminalState(tab);
      });
    },
  })),
  {
    name: "cc-panes-layout",
    version: 4,
    migrate: (persistedState, version) => {
      const state = persistedState as Record<string, unknown>;
      if (version < 2) {
        // v1 -> v2: migrate launchClaude=true tabs to cliTool="claude"
        function migrateNode(node: PaneNode) {
          if (node.type === "panel") {
            for (const tab of node.tabs) {
              if (!tab.cliTool && tab.launchClaude) {
                tab.cliTool = "claude";
              }
            }
          } else {
            node.children.forEach(migrateNode);
          }
        }
        if (state.rootPane) {
          migrateNode(state.rootPane as PaneNode);
        }
      }
      if (version < 3 && state.rootPane) {
        const migrateTerminalTabs = (node: PaneNode) => {
          if (node.type === "panel") {
            for (const tab of node.tabs) {
              if (tab.contentType === "terminal") {
                syncTabTerminalState(tab);
              }
            }
          } else {
            node.children.forEach(migrateTerminalTabs);
          }
        };
        migrateTerminalTabs(state.rootPane as PaneNode);
      }
      if (version < 4 && state.rootPane) {
        const rootPane = state.rootPane as PaneNode;
        const activePaneId = typeof state.activePaneId === "string"
          ? state.activePaneId
          : collectPanels(rootPane)[0]?.id ?? rootPane.id;
        state.layouts = [{
          id: generateId("layout"),
          name: "布局 1",
          kind: "normal",
          rootPane,
          activePaneId,
        }];
        state.currentLayoutId = (state.layouts as LayoutEntry[])[0].id;
        delete state.rootPane;
        delete state.activePaneId;
      }
      return state;
    },
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
