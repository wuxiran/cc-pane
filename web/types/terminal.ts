import type { LaunchProviderSelection } from "./launch-profile";

/**
 * 标签与终端相关类型定义
 */

/**
 * 已知 CLI 工具的**运行时**清单，与 Rust 侧 `CliTool::ALL` 一一对应。
 *
 * 类型从这里派生而不是反过来：新增 CLI 时只改这一处，穷举守卫测试
 * （`cliToolCoverage.test.ts`）才拿得到列表去核对颜色/菜单/i18n 那几张
 * **开放** Record——它们漏条目不会有类型错误，只会静默掉色、掉菜单项。
 */
export const KNOWN_CLI_TOOLS = [
  "none",
  "claude",
  "codex",
  "gemini",
  "kimi",
  "glm",
  "opencode",
  "cursor",
  "grok",
  "pi",
  "omp",
] as const;

/** CLI 工具类型（已知值自动补全 + 允许任意字符串） */
export type KnownCliTool = (typeof KNOWN_CLI_TOOLS)[number];
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
  /** Structured transports exposed by the CLI adapter (for example Pi RPC). */
  supportsRpc?: boolean;
  supportsStructuredResult?: boolean;
  /** Whether the adapter has a safe, native permission-bypass mode. */
  supportsYolo?: boolean;
  /** 允许被 MCP `launch_task` 编排启动。后加字段，旧后端不发 → 可选。 */
  supportsOrchestratedLaunch?: boolean;
  /**
   * per-launch 参数消费能力（对齐 cc-cli-adapters 的 supports_*_option）。
   *
   * 启动器 chips 是通用 UI，但 adapter 只消费自己支持的键——不支持的会被**静默丢弃**。
   * 这三个位让前端把「点了没用」置灰成「这个 CLI 做不到」。
   *
   * 后加字段，旧后端不发 → 可选。**缺失时按「支持」处理**（见 launcherCapabilities.ts）：
   * 旧后端不发字段不代表能力缺失，一律置灰会让老版本的 claude 也不能用 effort。
   */
  supportsEffortOption?: boolean;
  supportsVerboseOption?: boolean;
  supportsMaxTurnsOption?: boolean;
  compatibleProviderTypes: string[];
}

/** effort 六档中的显式五档（undefined = default，不注入） */
export type LaunchEffort = "low" | "medium" | "high" | "xhigh" | "max";

/** Pi transport selected by a launch profile. PTY remains the interactive default. */
export type PiTransport = "pty" | "rpc";
/** Pi project-resource trust; this is intentionally separate from CC-Panes YOLO. */
export type PiProjectTrust = "inherit" | "approve" | "deny";

/**
 * Pi-specific adapter options. Native provider/model values refer to Pi's
 * own auth/settings files and never carry credentials in the launch payload.
 */
export interface PiLaunchOptions {
  piTransport?: PiTransport;
  piNativeProvider?: string;
  piNativeModel?: string;
  piProjectTrust?: PiProjectTrust;
}

/**
 * per-launch adapter 选项（与 Rust CreateSessionRequest.adapterOptions 约定键对齐）：
 * claude 侧 effort 经 MAX_THINKING_TOKENS env 注入，codex 侧走 `-c model_reasoning_effort`。
 */
export interface LaunchAdapterOptions extends PiLaunchOptions {
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

export type TerminalRestoreBlockedReason =
  | "claims-unsupported"
  | "reconciliation-failed"
  | "missing-provenance"
  | "identity-mismatch"
  /**
   * 会话的出生凭证里没有 tab / terminal-pane 锚点，按策略只能人工接管。
   *
   * 这是**策略**不是身份不符——与 identity-mismatch 分开，才不会把排查指向
   * CLI / 运行环境 / 项目路径这些实际完全正确的字段。典型来源是旧版本创建的
   * 会话（新版本已在创建时预分配锚点）。
   */
  | "anchorless-session"
  /**
   * 身份核对**已通过**、写权限也拿到了，但 `attachSessionToAnchor` 拒绝挂载
   * （布局对不上 / 目标格子已被占 / 该 PTY 已挂在别处）。旧实现把它也报成
   * identity-mismatch，同样会把排查引向身份字段——那些字段此时全是对的。
   */
  | "attach-rejected"
  | "ambiguous-candidates"
  | "claim-conflict"
  | "auto-adopt-disabled";

/** WSL 启动信息 */
export interface WslLaunchInfo {
  remotePath: string;
  distro?: string;
}

export type TerminalPaneNode = TerminalPaneLeaf | TerminalPaneSplit;

export interface TerminalPaneLeaf {
  type: "leaf";
  id: string;
  /** One-shot launch identity for the PTY currently created by this leaf. */
  launchId?: string;
  /** Startup restore classification used by the one-shot regression report. */
  restoreMode?: "adopted" | "resumed" | "fresh" | "shell";
  /** Live PTY session id owned by CC-Panes. */
  sessionId: string | null;
  /** Agent conversation resume id, e.g. Claude/Codex resume UUID. */
  resumeId?: string;
  /** resumeId 的来源：issued / osc-title / hook / backfill / rescue / manual */
  resumeIdSource?: string;
  workspaceName?: string;
  providerId?: string;
  modelId?: string;
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
  /** Startup reconciliation refused to create or attach this leaf until the user intervenes. */
  restoreBlockedReason?: TerminalRestoreBlockedReason;
  /**
   * 被拦下的那条候选会话 id——阻断面板据此提供「手动接管」出口。
   *
   * 不能拿 `savedSessionId` 顶替：候选是按锚点从共享的会话档案里反查出来的，
   * 未必等于本 webview 自己记的那一条。
   */
  restoreBlockedSessionId?: string;
  /** The PTY remains observable, but another app instance owns its daemon write lease. */
  leaseReadOnly?: boolean;
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
  contentType: "terminal" | "browser" | "dsh" | "agent-chat" | "mcp-config" | "skill-manager" | "memory-manager" | "file-explorer" | "editor";
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
  modelId?: string;
  providerSelection?: LaunchProviderSelection;
  launchProfileId?: string;
  workspacePath?: string;
  workspaceSnapshotId?: string;
  launchClaude?: boolean;
  cliTool?: CliTool;
  filePath?: string;
  browserUrl?: string;
  dirty?: boolean;
  reclaimKey?: number;
  ssh?: import("./workspace").SshConnectionInfo;
  wsl?: WslLaunchInfo;
  machineName?: string;
  /** @deprecated 运行时单源在 leaf（批5 绞杀第一段）。仅「无 terminalRootPane 的 legacy 形态」可读写；有树时读 activeTerminalLeaf(tab)/phaseOf。 */
  disconnected?: boolean;
  /** @deprecated 同上——leaf 单源，仅 legacy 形态兜底。 */
  restoring?: boolean;
  /** @deprecated 同上——会话收集走 collectTerminalSessionIdsWithSaved（leaf 全量口径）。 */
  savedSessionId?: string;
  restoreBlockedReason?: TerminalRestoreBlockedReason;
  leaseReadOnly?: boolean;
  terminalRootPane?: TerminalPaneNode;
  activeTerminalPaneId?: string;
  launchExtras?: LaunchExtras;
  /** @deprecated 同上——leaf 单源，仅 legacy 形态兜底。 */
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
  modelId?: string;
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
  /** Immutable source anchor recorded by claim-capable daemons. */
  originLayoutId?: string;
  originTabId?: string;
  originTerminalPaneId?: string;
  /** Restore-only daemon compare-and-create token. */
  expectedSavedSessionId?: string;
}

/** 打开终端的选项 */
export interface OpenTerminalOptions {
  path: string;
  workspaceName?: string;
  providerId?: string;
  modelId?: string;
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
  /** 本批数据最后一个 raw chunk 的 seq（M3b-2 锚点记账）。缺失 = 旧后端/轮询降级路径不产 seq。 */
  endSeq?: number;
  data: string;
}

/**
 * 前端拍摄的终端画面照片上传载荷（M3b-2）。
 * 与 Rust `TerminalCheckpoint`（serde camelCase）逐字段对齐。
 */
export interface TerminalCheckpointUpload {
  checkpointEpoch: number;
  anchorSeq: number;
  snapshotAnsi: string;
  bufferMode: "normal" | "alternate";
  cols: number;
  rows: number;
  checkpointedAtMs: number;
}

/**
 * 后端存储的终端画面照片（读侧，M3b-3）。
 * 与 Rust `TerminalCheckpoint`（serde camelCase）逐字段对齐——上传侧的
 * `TerminalCheckpointUpload` 是同一结构的写方向别名，两者形状必须一致。
 */
export interface TerminalCheckpointData {
  checkpointEpoch: number;
  anchorSeq: number;
  snapshotAnsi: string;
  bufferMode: "normal" | "alternate";
  cols: number;
  rows: number;
  checkpointedAtMs: number;
}

/**
 * checkpoint+delta 结构化恢复快照（M3b-3，裁决 B）。
 * photo（snapshotAnsi）是 SerializeAddon 成品 VT——**直写**，不过
 * renderTerminalData；delta 是 PTY 原始字节——**必须过** renderTerminalData。
 * 旧 daemon 回落形状：`{ checkpoint: null, delta, bufferMode, endSeq: 0,
 * checkpointEpoch: 0 }`（epoch=0 = 无 seq 记账能力，读侧不得 reanchor）。
 */
export interface TerminalRecoverySnapshot {
  checkpoint: TerminalCheckpointData | null;
  delta: string;
  bufferMode: "normal" | "alternate";
  endSeq: number;
  checkpointEpoch: number;
}

/**
 * store_checkpoint 的结构化结果。与 Rust `StoreCheckpointOutcome`
 * （`#[serde(tag = "kind", rename_all = "camelCase")]`）对齐：变体名 camelCase。
 * 拒收是**结果**不是错误（幂等重传拿到 stale）。
 */
export type StoreCheckpointOutcome =
  | { kind: "accepted"; anchorSeq: number }
  | { kind: "rejectedEpochMismatch" }
  | { kind: "rejectedStaleAnchor" }
  | { kind: "rejectedAnchorGap" }
  | { kind: "rejectedFutureAnchor" }
  | { kind: "rejectedTooLarge" };

/** 最近终端输出快照 */
export interface TerminalSessionOutput {
  sessionId: string;
  lines: string[];
}

/**
 * kill 来源（与 Rust `KillReason` 的 kebab-case 序列化对齐）。
 * user-close/mcp → 前端关标签；回收/超时清理 → 保留标签显示退出。
 */
export type KillReason =
  | "user-close"
  | "mcp"
  | "orphan-reclaim"
  | "daemon-reaper"
  | "launch-timeout"
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
