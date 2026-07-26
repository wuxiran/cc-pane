/**
 * 终端会话恢复相关类型定义
 */

/** 保存的终端会话元数据（与 Rust SavedSession 对应） */
export interface SavedSession {
  workspaceSnapshotId?: string;
  sessionId: string;
  tabId: string;
  paneId: string;
  /** 终端 tab 内的分屏 leaf id；与 tabId + layoutId 构成精确挂载锚点 */
  terminalPaneId?: string;
  /** 所属布局 id */
  layoutId?: string;
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
  /** WSL 启动配置 JSON（distro + remotePath）；缺失时不允许接管 */
  wslConfig?: string;
  machineName?: string;
  observerInstanceId?: string;
  daemonGeneration?: number;
  birthNonce?: string;
  originInstanceId?: string;
  originLayoutId?: string;
  originTabId?: string;
  originTerminalPaneId?: string;
  customTitle?: string;
  createdAt: string;
  savedAt: string;
  hasOutput: boolean;
}

export interface TerminalSessionProvenance {
  sessionId: string;
  daemonGeneration: number;
  birthNonce: string;
  originInstanceId?: string;
  originLayoutId?: string;
  originTabId?: string;
  originTerminalPaneId?: string;
  projectPath: string;
  runtimeKind: string;
  cliTool: string;
  resumeId?: string;
  createdAtMs: number;
}

export interface TerminalAdoptionSnapshot {
  claimsSupported: boolean;
  daemonGeneration?: number;
  ownerInstanceId?: string;
  capturedAtMs: number;
  complete: boolean;
  sessions: import("./settings").TerminalStatusInfo[];
  claims: Record<string, string>;
  provenance: Record<string, TerminalSessionProvenance>;
}
