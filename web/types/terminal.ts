import type { LaunchProviderSelection } from "./launch-profile";

/**
 * 标签与终端相关类型定义
 */

/** CLI 工具类型（已知值自动补全 + 允许任意字符串） */
export type KnownCliTool =
  | "none"
  | "claude"
  | "codex"
  | "gemini"
  | "kimi"
  | "glm"
  | "opencode"
  | "cursor"
  | "grok";
export type CliTool = KnownCliTool | (string & {});

/** CLI 工具元信息（来自 Rust cc-cli-adapters crate） */
export interface CliToolInfo {
  id: string;
  displayName: string;
  executable: string;
  versionArgs: string[];
  installed: boolean;
  version: string | null;
  path: string | null;
  capabilities?: CliToolCapabilities | null;
}

/** CLI 工具能力声明 */
export interface CliToolCapabilities {
  supportsProvider: boolean;
  supportsResume: boolean;
  supportsMcp: boolean;
  supportsSystemPrompt: boolean;
  supportsWorkspace: boolean;
  supportsProjectHooks: boolean;
  supportsIssuedSessionId?: boolean;
  compatibleProviderTypes: string[];
}

/** effort 六档中的显式五档（undefined = default，不注入） */
export type LaunchEffort = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * per-launch adapter 选项（与 Rust CreateSessionRequest.adapterOptions 约定键对齐）：
 * claude 侧 effort 经 MAX_THINKING_TOKENS env 注入，codex 侧走 `-c model_reasoning_effort`。
 */
export interface LaunchAdapterOptions {
  effort?: LaunchEffort;
  extraArgs?: string[];
  verbose?: boolean;
  maxTurns?: number;
}

/**
 * 启动器附加参数聚合对象（Tab/TerminalPaneLeaf 透传用，避免字段平铺爆炸）。
 * yolo：undefined = 跟随 launch profile，true = 本次强制 YOLO。
 * initialPrompt 仅首次启动生效，session 创建成功后由 clearTabInitialPrompt 清除防重放。
 */
export interface LaunchExtras {
  skipMcp?: boolean;
  appendSystemPrompt?: string;
  initialPrompt?: string;
  yolo?: boolean;
  adapterOptions?: LaunchAdapterOptions;
}

export interface TerminalLaunchError {
  code?: string;
  message: string;
  params?: Record<string, string>;
}

/** WSL 启动信息 */
export interface WslLaunchInfo {
  remotePath: string;
  distro?: string;
}

export type TerminalPaneNode = TerminalPaneLeaf | TerminalPaneSplit;

export interface TerminalPaneLeaf {
  type: "leaf";
  id: string;
  /** Live PTY session id owned by CC-Panes. */
  sessionId: string | null;
  /** Agent conversation resume id, e.g. Claude/Codex resume UUID. */
  resumeId?: string;
  /** resumeId 的来源：issued / osc-title / hook / backfill / rescue / manual */
  resumeIdSource?: string;
  workspaceName?: string;
  providerId?: string;
  providerSelection?: LaunchProviderSelection;
  launchProfileId?: string;
  workspacePath?: string;
  workspaceSnapshotId?: string;
  launchClaude?: boolean;
  cliTool?: CliTool;
  ssh?: import("./workspace").SshConnectionInfo;
  wsl?: WslLaunchInfo;
  machineName?: string;
  disconnected?: boolean;
  restoring?: boolean;
  savedSessionId?: string;
  launchExtras?: LaunchExtras;
  launchError?: TerminalLaunchError;
  launchAttempt?: number;
}

export interface TerminalPaneSplit {
  type: "split";
  id: string;
  direction: "horizontal" | "vertical";
  children: TerminalPaneNode[];
  sizes: number[];
}

/** 通用标签 */
export interface Tab {
  id: string;
  title: string;
  contentType: "terminal" | "mcp-config" | "skill-manager" | "memory-manager" | "file-explorer" | "editor";
  projectId: string;
  projectPath: string;
  /** Live PTY session id owned by CC-Panes. */
  sessionId: string | null;
  pinned?: boolean;
  starred?: boolean;
  minimized?: boolean;
  /** Agent conversation resume id, e.g. Claude/Codex resume UUID. */
  resumeId?: string;
  /** resumeId 的来源：issued / osc-title / hook / backfill / rescue / manual */
  resumeIdSource?: string;
  workspaceName?: string;
  providerId?: string;
  providerSelection?: LaunchProviderSelection;
  launchProfileId?: string;
  workspacePath?: string;
  workspaceSnapshotId?: string;
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
  terminalRootPane?: TerminalPaneNode;
  activeTerminalPaneId?: string;
  launchExtras?: LaunchExtras;
  launchError?: TerminalLaunchError;
  launchAttempt?: number;
  /**
   * Parent tab id when this tab was created by `launch_task` from another
   * cc-panes-managed Claude instance. Drives hierarchical numbering
   * (`#N.M`, `#N.M.K`). Top-level tabs leave it unset.
   */
  parentTabId?: string;
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
  launchId?: string;
  projectPath: string;
  cols: number;
  rows: number;
  workspaceName?: string;
  providerId?: string;
  providerSelection?: LaunchProviderSelection;
  launchProfileId?: string;
  workspacePath?: string;
  workspaceSnapshotId?: string;
  launchClaude?: boolean;
  cliTool?: CliTool;
  resumeId?: string;
  skipMcp?: boolean;
  appendSystemPrompt?: string;
  /** 首启注入的用户 prompt（位置参数）；restore/reattach 路径不得携带 */
  initialPrompt?: string;
  /** per-launch YOLO 覆盖：undefined = 跟随 launch profile */
  yoloMode?: boolean;
  adapterOptions?: LaunchAdapterOptions;
  ssh?: import("./workspace").SshConnectionInfo;
  wsl?: WslLaunchInfo;
}

/** 打开终端的选项 */
export interface OpenTerminalOptions {
  path: string;
  workspaceName?: string;
  providerId?: string;
  providerSelection?: LaunchProviderSelection;
  launchProfileId?: string;
  workspacePath?: string;
  workspaceSnapshotId?: string;
  cliTool?: CliTool;
  resumeId?: string;
  ssh?: import("./workspace").SshConnectionInfo;
  wsl?: WslLaunchInfo;
  machineName?: string;
  /** 显式指定落位布局；缺省时由 workspaceName 经 findLayoutForWorkspace 推导 */
  targetLayoutId?: string;
  skipMcp?: boolean;
  appendSystemPrompt?: string;
  initialPrompt?: string;
  /** per-launch YOLO 覆盖：undefined = 跟随 launch profile */
  yolo?: boolean;
  adapterOptions?: LaunchAdapterOptions;
}

/** 终端输出事件 */
export interface TerminalOutput {
  sessionId: string;
  data: string;
}

/** 最近终端输出快照 */
export interface TerminalSessionOutput {
  sessionId: string;
  lines: string[];
}

/**
 * kill 来源（与 Rust `KillReason` 的 kebab-case 序列化对齐）。
 * user-close/mcp → 前端关标签；orphan-reclaim/daemon-reaper → 保留标签显示退出。
 */
export type KillReason =
  | "user-close"
  | "mcp"
  | "orphan-reclaim"
  | "daemon-reaper"
  | "unknown";

/** session-killed 事件载荷；reason 缺失表示旧后端（按关标签处理） */
export interface SessionKilledPayload {
  sessionId: string;
  reason?: KillReason | (string & {});
}

/** 终端调整大小请求 */
export interface ResizeRequest {
  sessionId: string;
  cols: number;
  rows: number;
}
