/**
 * 标签与终端相关类型定义
 */

/** CLI 工具类型（已知值自动补全 + 允许任意字符串） */
export type KnownCliTool = "none" | "claude" | "codex" | "gemini" | "opencode";
export type CliTool = KnownCliTool | (string & {});

/** CLI 工具元信息（来自 Rust cc-cli-adapters crate） */
export interface CliToolInfo {
  id: string;
  displayName: string;
  executable: string;
  installed: boolean;
  version: string | null;
  path: string | null;
}

/** CLI 工具能力声明 */
export interface CliToolCapabilities {
  supportsProvider: boolean;
  supportsResume: boolean;
  supportsMcp: boolean;
  supportsSystemPrompt: boolean;
  supportsWorkspace: boolean;
  compatibleProviderTypes: string[];
}

/** WSL 启动信息 */
export interface WslLaunchInfo {
  remotePath: string;
  distro?: string;
}

/** 通用标签 */
export interface Tab {
  id: string;
  title: string;
  contentType: "terminal" | "mcp-config" | "skill-manager" | "memory-manager" | "file-explorer" | "editor";
  projectId: string;
  projectPath: string;
  sessionId: string | null;
  pinned?: boolean;
  minimized?: boolean;
  resumeId?: string;
  workspaceName?: string;
  providerId?: string;
  workspacePath?: string;
  launchClaude?: boolean;
  cliTool?: CliTool;
  filePath?: string;
  dirty?: boolean;
  reclaimKey?: number;
  ssh?: import("./workspace").SshConnectionInfo;
  wsl?: WslLaunchInfo;
  machineName?: string;
  disconnected?: boolean;
  restoring?: boolean;
  savedSessionId?: string;
}

/** 终端会话状态 */
export interface TerminalSession {
  id: string;
  projectPath: string;
  cols: number;
  rows: number;
  running: boolean;
}

/** 创建终端会话请求 */
export interface CreateSessionRequest {
  projectPath: string;
  cols: number;
  rows: number;
  workspaceName?: string;
  providerId?: string;
  workspacePath?: string;
  launchClaude?: boolean;
  cliTool?: CliTool;
  resumeId?: string;
  skipMcp?: boolean;
  appendSystemPrompt?: string;
  ssh?: import("./workspace").SshConnectionInfo;
  wsl?: WslLaunchInfo;
}

/** 打开终端的选项 */
export interface OpenTerminalOptions {
  path: string;
  workspaceName?: string;
  providerId?: string;
  workspacePath?: string;
  cliTool?: CliTool;
  resumeId?: string;
  ssh?: import("./workspace").SshConnectionInfo;
  wsl?: WslLaunchInfo;
  machineName?: string;
}

/** 终端输出事件 */
export interface TerminalOutput {
  sessionId: string;
  data: string;
}

/** 终端调整大小请求 */
export interface ResizeRequest {
  sessionId: string;
  cols: number;
  rows: number;
}
