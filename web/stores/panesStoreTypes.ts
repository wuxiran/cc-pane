import type { Draft } from "immer";

import type {
  AutoSplitDirection,
  CliTool,
  LayoutEntry,
  LayoutSnapshotPayload,
  LaunchExtras,
  PaneNode,
  Panel,
  SplitDirection,
  SshConnectionInfo,
  Tab,
  TerminalPaneNode,
  TerminalRestoreBlockedReason,
  TerminalStatusInfo,
  WslLaunchInfo,
} from "@/types";
import type { LayoutPresetId } from "@/types/pane";
import type { DestroyReason } from "@/lib/tabLifecycle/destroyPipeline";
import type { TabViewState } from "@/lib/tabLifecycle/tabViewState";
import type { BrowserTabActions } from "./browserTabActions";

export interface CreateTabOptions {
  projectId: string;
  projectPath: string;
  /** One-shot identity already used when the caller created the PTY before opening the tab. */
  launchId?: string;
  sessionId?: string;
  resumeId?: string;
  workspaceName?: string;
  providerId?: string;
  modelId?: string;
  providerSelection?: Tab["providerSelection"];
  launchProfileId?: string;
  workspacePath?: string;
  workspaceSnapshotId?: string;
  cliTool?: CliTool;
  customTitle?: string;
  ssh?: SshConnectionInfo;
  wsl?: WslLaunchInfo;
  machineName?: string;
  parentTabId?: string;
  targetLayoutId?: string;
  launchExtras?: LaunchExtras;
}

export interface AdoptSessionMeta {
  projectPath: string;
  projectId?: string;
  workspaceName?: string;
  workspacePath?: string;
  workspaceSnapshotId?: string;
  providerId?: string;
  modelId?: string;
  providerSelection?: Tab["providerSelection"];
  launchProfileId?: string;
  cliTool?: CliTool;
  resumeId?: string;
  customTitle?: string;
  ssh?: SshConnectionInfo;
  wsl?: WslLaunchInfo;
}

export interface SessionAnchor {
  sessionId: string;
  layoutId?: string;
  tabId: string;
  terminalPaneId?: string;
  expectedProjectPath?: string;
}

export interface TabAcrossLayoutsLocation {
  layoutId: string;
  layoutName: string;
  tree: PaneNode;
  panel: Panel;
  tab: Tab;
}

export interface PaneAcrossLayoutsLocation {
  layoutId: string;
  tree: PaneNode;
  pane: PaneNode;
}

export type LayoutDraft = Draft<LayoutEntry>;
export type PaneNodeDraft = Draft<PaneNode>;
export type PanelDraft = Draft<Panel>;
export type TabDraft = Draft<Tab>;

export interface DraftTabAcrossLayoutsLocation {
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

export interface CloseTabBySessionIdResult {
  closed: number;
}

/** removeTabsInternal 的调用方选项。 */
export interface RemoveTabsInternalOptions {
  /**
   * 已由调用方保护、不得 kill 的会话集合（snapshot-apply 差集复核用）。
   * 树操作阶段不读——只在回收管线（destroyPipeline.commitResourceDestroy）消费。
   */
  protectSessionIds?: ReadonlySet<string>;
}

export interface ClosedTabSnapshot {
  projectId: string;
  projectPath: string;
  title: string;
  resumeId?: string;
  workspaceName?: string;
  providerId?: string;
  modelId?: string;
  providerSelection?: Tab["providerSelection"];
  launchProfileId?: string;
  workspacePath?: string;
  workspaceSnapshotId?: string;
  launchClaude?: boolean;
  cliTool?: CliTool;
  ssh?: SshConnectionInfo;
  wsl?: WslLaunchInfo;
  machineName?: string;
  /**
   * 以下三个是「标签在布局里的身份」，不是创建参数（docs/78）。
   * 不存它们的话，撤销出来的标签会丢掉置顶/星标状态与父子关系——
   * 用户看到的是「恢复了，但不是原来那个」。
   */
  pinned?: boolean;
  starred?: boolean;
  parentTabId?: string;
  /**
   * 启动附加项（yolo / skipMcp / appendSystemPrompt / adapterOptions）。
   * initialPrompt 在存快照时就已剥掉——撤销出来的会话不得重放首启 prompt。
   */
  launchExtras?: LaunchExtras;
  /**
   * 分屏结构（docs/78 批4）。只有多格 tab 才存：单格由 addTab 自然重建。
   * 存的是**已过重置清单**的树（resetTerminalTreeForRelaunch），里面绝无
   * 活会话字段——撤销恢复的是「布局与启动身份」，不是死掉的 PTY。
   */
  terminalRootPane?: TerminalPaneNode;
  /**
   * 非终端标签的撤销（docs/78）。缺省 = terminal（历史快照兼容）。
   * browser 存 URL、editor 存 filePath。
   */
  contentType?: "terminal" | "browser" | "editor";
  browserUrl?: string;
  filePath?: string;
  /**
   * 组件级视图状态（docs/78 批4 的 onPersist）：editor 光标等。
   * 与上面的字段分工——那些是标签数据（组件没挂载也读得到），这个只活在
   * 组件实例里，由组件上报到 lib/tabLifecycle/tabViewState。
   */
  viewState?: TabViewState;
}

export interface PanesState extends BrowserTabActions {
  rootPane: PaneNode;
  activePaneId: string;
  layouts: LayoutEntry[];
  currentLayoutId: string;
  closedTabs: ClosedTabSnapshot[];
  poppedOutTabs: Set<string>;
  allPanels: () => Panel[];
  allPanelsAcrossLayouts: () => Panel[];
  activePane: () => Panel | null;
  findPaneById: (paneId: string) => PaneNode | null;
  findPaneAcrossLayouts: (paneId: string) => PaneAcrossLayoutsLocation | null;
  findTabAcrossLayouts: (tabId: string) => TabAcrossLayoutsLocation | null;
  findTabBySessionAcrossLayouts: (sessionId: string) => TabAcrossLayoutsLocation | null;
  createLayout: (name?: string) => string;
  renameLayout: (id: string, name: string) => void;
  deleteLayout: (id: string) => void;
  switchLayout: (id: string) => void;
  switchLayoutByIndex: (index: number) => void;
  reorderLayouts: (fromIndex: number, toIndex: number) => void;
  ensureStarredLayout: () => string;
  listLayouts: () => LayoutEntry[];
  bindLayoutWorkspace: (layoutId: string, workspaceName: string) => void;
  unbindLayoutWorkspace: (layoutId: string) => void;
  autoBindLayoutWorkspaceFromTabs: () => void;
  split: (paneId: string, direction: SplitDirection) => void;
  splitRight: (paneId: string) => void;
  splitDown: (paneId: string) => void;
  resizePanes: (paneId: string, sizes: number[]) => void;
  applyLayoutPreset: (preset: LayoutPresetId) => void;
  /** layoutId 省略 = 当前布局。传入时往该布局的树里写，不切换当前布局。 */
  addTab: (paneId: string, opts: CreateTabOptions, layoutId?: string) => void;
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
    toIndex?: number,
  ) => void;
  splitAndMoveTab: (paneId: string, tabId: string, direction: SplitDirection) => void;
  /** layoutId 省略 = 当前布局。传入时在该布局里分屏，不切换当前布局。 */
  openSessionBesidePane: (
    paneId: string,
    direction: AutoSplitDirection,
    opts: CreateTabOptions,
    layoutId?: string,
  ) => void;
  /**
   * 唯一逐-tab 销毁出口（docs/78）：资源回收（destroyPipeline.commitResourceDestroy）+ 树 splice + closedTabs +
   * poppedOut/fullscreen 附属清理；资源回收由 destroyPipeline.commitResourceDestroy 执行。
   * 幂等——找不到的 tabId 静默跳过。
   */
  removeTabsInternal: (
    tabIds: string[],
    reason: DestroyReason,
    opts?: RemoveTabsInternalOptions,
  ) => void;
  /** 「关一格」：关掉分屏 tab 里的一个终端 leaf（最后一格不关，调用方改走 removeTabsInternal）。 */
  removeTerminalLeafInternal: (
    tabId: string,
    terminalPaneId: string,
    reason: DestroyReason,
  ) => void;
  /**
   * 纯树操作、**零销毁语义**：只收「tab 已全部搬走」的空 pane（moveTab 系专用）。
   * 非空 pane 一律 no-op + dev 告警——这是硬守卫，防止搬空 pane 的路径
   * 沾上杀会话副作用后拖动标签误杀会话。
   */
  removeEmptyPane: (paneId: string) => void;
  selectTab: (paneId: string, tabId: string) => void;
  setActivePane: (paneId: string) => void;
  updateTabSession: (
    paneId: string,
    tabId: string,
    sessionId: string,
    terminalPaneId?: string,
  ) => void;
  /** Persist the launch identity that will be used for the next PTY creation. */
  updateTerminalLaunchId: (tabId: string, terminalPaneId: string, launchId: string) => void;
  setTerminalLaunchError: (
    tabId: string,
    terminalPaneId: string,
    error: import("@/types").TerminalLaunchError,
  ) => void;
  retryTerminalLaunch: (tabId: string, terminalPaneId: string) => void;
  removeTerminalLaunch: (tabId: string, terminalPaneId: string) => void;
  setActiveTerminalPane: (tabId: string, terminalPaneId: string) => void;
  splitTerminalPane: (tabId: string, terminalPaneId: string, direction: SplitDirection) => void;
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
  /**
   * 打开编辑器标签。`layoutId` 缺省 = 当前布局；MCP 调用方所在布局由调用者传入，
   * 避免标签落进用户此刻正看着的布局。返回标签最终所在布局 id（Files 视图分支返回 null）。
   */
  openEditor: (
    projectPath: string,
    filePath: string,
    title: string,
    layoutId?: string,
    /** forcePaneTab：无视 Files 视图分支，强制落成分屏区 tab（分屏区内的新建入口用） */
    options?: { forcePaneTab?: boolean },
  ) => string | null;
  closeEditorTabsByPath: (filePath: string) => void;
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
  updateTabAgentResumeId: (
    ptySessionId: string,
    agentResumeId: string,
    resumeIdSource?: string,
  ) => boolean;
  setTabResumeBinding: (
    tabId: string,
    resumeId: string | undefined,
    resumeIdSource?: string,
  ) => void;
  updateTabClaudeSession: (ptySessionId: string, claudeSessionId: string) => void;
  setTabDisconnected: (
    paneId: string,
    tabId: string,
    disconnected: boolean,
    terminalPaneId?: string,
  ) => void;
  reconnectTab: (paneId: string, tabId: string, terminalPaneId?: string) => Promise<string | null>;
  closeTabBySessionId: (sessionId: string) => CloseTabBySessionIdResult;
  restoreLiveDaemonSessions: (statuses: TerminalStatusInfo[]) => number;
  exportLayoutSnapshotPayload: () => LayoutSnapshotPayload;
  applyLayoutSnapshotPayload: (payload: LayoutSnapshotPayload) => boolean;
  clearRestoring: (paneId: string, tabId: string, terminalPaneId?: string) => void;
  clearTabInitialPrompt: (tabId: string) => void;
  getRestorableTabs: () => Array<{ tab: Tab; paneId: string; layoutId: string }>;
  setBackgroundRestoreSession: (
    tabId: string,
    terminalPaneId: string,
    savedSessionId: string,
  ) => void;
  /** Detach a blocked legacy-daemon session before explicitly cold-restoring it. */
  beginTerminalColdRestore: (tabId: string, terminalPaneId: string) => string | null;
  /** Commit or roll back the explicit cold restore after the old PTY kill resolves. */
  finishTerminalColdRestore: (
    tabId: string,
    terminalPaneId: string,
    previousSessionId: string,
    succeeded: boolean,
  ) => void;
  setTerminalRestoreBlocked: (
    tabId: string,
    terminalPaneId: string,
    reason: TerminalRestoreBlockedReason | undefined,
  ) => void;
  setSessionLeaseReadOnly: (sessionId: string, readOnly: boolean) => void;
  canCreateTerminalSession: (
    tabId: string,
    terminalPaneId: string,
    expectedSavedSessionId?: string,
    allowLiveExpectedSession?: boolean,
  ) => boolean;
  adoptSession: (sessionId: string, meta: AdoptSessionMeta) => string | null;
  attachSessionToAnchor: (anchor: SessionAnchor) => boolean;
  collectReferencedSessionIds: () => Set<string>;
}

export type PanesDraft = Draft<PanesState>;
