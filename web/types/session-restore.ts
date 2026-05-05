/**
 * 终端会话恢复相关类型定义
 */

/** 保存的终端会话元数据（与 Rust SavedSession 对应） */
export interface SavedSession {
  workspaceSnapshotId?: string;
  sessionId: string;
  tabId: string;
  paneId: string;
  projectPath: string;
  workspaceName?: string;
  workspacePath?: string;
  providerId?: string;
  providerSelection?: import("./launch-profile").LaunchProviderSelection;
  launchProfileId?: string;
  cliTool: string;
  runtimeKind?: string;
  resumeId?: string;
  sshConfig?: string;
  customTitle?: string;
  createdAt: string;
  savedAt: string;
  hasOutput: boolean;
}
