import type { TerminalViewHandle } from "@/components/panes/TerminalView";
import type { LayoutEntry, PaneNode, Tab, Workspace, WorkspaceProject } from "@/types";

export type ViewId = "workspaces" | "layouts" | "terminal";

export interface OpenedWorkspaceProject {
  workspaceName: string;
  workspaceRootPath?: string;
  projectName: string;
  projectPath: string;
}

export interface MobileTerminalState {
  paneId: string;
  tab: Tab;
  onSessionCreated: (sessionId: string, terminalPaneId?: string) => void;
  onSessionExited?: (exitCode: number, terminalPaneId?: string) => void;
  onTerminalRef: (terminalPaneId: string, ref: TerminalViewHandle | null) => void;
  onReconnect?: (terminalPaneId: string) => Promise<string | null>;
  onWrite: (sessionId: string, data: string) => Promise<void>;
  onSubmit: (sessionId: string, text: string) => Promise<void>;
}

export interface MobileWorkspaceActions {
  onToggleWorkspacePinned?: (workspace: Workspace) => Promise<void>;
  onToggleWorkspaceHidden?: (workspace: Workspace) => Promise<void>;
  onOpenWorkspaceFolder?: (workspace: Workspace) => Promise<void>;
  onOpenWorkspaceFileBrowser?: (workspace: Workspace) => void;
  onSetWorkspaceAlias?: (workspace: Workspace, alias: string | null) => Promise<void>;
  onRenameWorkspace?: (workspace: Workspace, name: string) => Promise<void>;
  onDeleteWorkspace?: (workspace: Workspace) => Promise<void>;
}

export interface MobilePrototypeProps extends MobileWorkspaceActions {
  workspaces?: Workspace[];
  workspacesLoading?: boolean;
  terminal?: MobileTerminalState | null;
  layouts?: LayoutEntry[];
  currentLayoutId?: string;
  rootPane?: PaneNode;
  activePaneId?: string;
  onLoadWorkspaces?: () => void | Promise<void>;
  onOpenProject?: (workspace: Workspace, project: WorkspaceProject) => void;
  onSwitchLayout?: (layoutId: string) => void;
  onSelectPane?: (paneId: string) => void;
  onSelectTab?: (paneId: string, tabId: string) => void;
}
