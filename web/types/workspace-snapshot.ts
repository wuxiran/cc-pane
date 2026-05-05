export interface WorkspaceSnapshotEntry {
  ptySessionId: string;
  tabId: string;
  paneId: string;
  projectPath: string;
  providerId?: string | null;
  providerSelection?: import("./launch-profile").LaunchProviderSelection | null;
  launchProfileId?: string | null;
  agentTool: string;
  runtimeKind?: string | null;
  agentResumeId?: string | null;
  customTitle?: string | null;
  createdAt: string;
  savedAt: string;
}

export interface WorkspaceSnapshot {
  id: string;
  workspaceId: string;
  workspaceName?: string | null;
  workspacePath?: string | null;
  title: string;
  createdAt: string;
  savedAt: string;
  entries: WorkspaceSnapshotEntry[];
}

export interface WorkspaceSnapshotSummary {
  id: string;
  workspaceId: string;
  workspaceName?: string | null;
  workspacePath?: string | null;
  title: string;
  createdAt: string;
  savedAt: string;
  entryCount: number;
}
