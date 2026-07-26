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
  TerminalRestoreBlockedReason,
  TerminalStatusInfo,
  WslLaunchInfo,
} from "@/types";
import type { LayoutPresetId } from "@/types/pane";
import type { BrowserTabActions } from "./browserTabActions";

export interface CreateTabOptions {
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
  blockedByPinned: number;
}

export interface ClosedTabSnapshot {
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
  closePane: (paneId: string) => void;
  resizePanes: (paneId: string, sizes: number[]) => void;
  applyLayoutPreset: (preset: LayoutPresetId) => void;
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
    toIndex?: number,
  ) => void;
  splitAndMoveTab: (paneId: string, tabId: string, direction: SplitDirection) => void;
  openSessionBesidePane: (
    paneId: string,
    direction: AutoSplitDirection,
    opts: CreateTabOptions,
  ) => void;
  closeTabsToLeft: (paneId: string, tabId: string) => void;
  closeTabsToRight: (paneId: string, tabId: string) => void;
  closeOtherTabs: (paneId: string, tabId: string) => void;
  selectTab: (paneId: string, tabId: string) => void;
  setActivePane: (paneId: string) => void;
  updateTabSession: (
    paneId: string,
    tabId: string,
    sessionId: string,
    terminalPaneId?: string,
  ) => void;
  setTerminalLaunchError: (
    tabId: string,
    terminalPaneId: string,
    error: import("@/types").TerminalLaunchError,
  ) => void;
  retryTerminalLaunch: (tabId: string, terminalPaneId: string) => void;
  removeTerminalLaunch: (tabId: string, terminalPaneId: string) => void;
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
  setTerminalRestoreBlocked: (
    tabId: string,
    terminalPaneId: string,
    reason: TerminalRestoreBlockedReason | undefined,
  ) => void;
  setSessionLeaseReadOnly: (sessionId: string, readOnly: boolean) => void;
  canCreateTerminalSession: (tabId: string, terminalPaneId: string) => boolean;
  adoptSession: (sessionId: string, meta: AdoptSessionMeta) => string | null;
  attachSessionToAnchor: (anchor: SessionAnchor) => boolean;
  collectReferencedSessionIds: () => Set<string>;
}

export type PanesDraft = Draft<PanesState>;
