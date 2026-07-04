/** 应用设置 */
export interface AppSettings {
  proxy: ProxySettings;
  theme: ThemeSettings;
  terminal: TerminalSettings;
  shortcuts: ShortcutSettings;
  general: GeneralSettings;
  notification: NotificationSettings;
  screenshot: ScreenshotSettings;
  voice: VoiceSettings;
  cliLaunchers: CliLauncherSettings;
  layoutSwitcher: LayoutSwitcherSettings;
  webAccess: WebAccessSettings;
  orchestrator: OrchestratorSettings;
}

/** 代理设置 */
export interface ProxySettings {
  enabled: boolean;
  proxyType: string;
  host: string;
  port: number;
  username: string | null;
  password: string | null;
  noProxy: string | null;
}

/** 主题设置 */
export interface ThemeSettings {
  mode: string;
}

/** 终端设置 */
export type TerminalRendererMode = "auto" | "webgl" | "dom";
export type TerminalThemeMode = "followApp" | "dark" | "light";

export interface TerminalSettings {
  fontSize: number;
  fontFamily: string;
  cursorStyle: string;
  cursorBlink: boolean;
  scrollback: number;
  /** 终端主题: followApp 跟随应用, dark 深色终端, light 浅色终端 */
  themeMode: TerminalThemeMode;
  /** 终端渲染器: auto 默认优先 WebGL, webgl 强制尝试, dom 诊断降级 */
  rendererMode: TerminalRendererMode;
  /** 用户选择的 Shell ID（如 "pwsh", "cmd"），null 表示自动探测 */
  shell: string | null;
  /** 禁用 ConPTY 输出 sanitize（默认 true） */
  disableConptySanitize: boolean | null;
  /** 启用旧版 resume id backfill（扫目录猜测，默认 false；已被确定性绑定取代，仅排障用） */
  resumeIdBackfillEnabled: boolean | null;
}

/** Shell 信息 */
export interface ShellInfo {
  id: string;
  name: string;
  path: string;
}

/** 快捷键设置 */
export interface ShortcutSettings {
  bindings: Record<string, string>;
}

/** 通知设置 */
export interface NotificationSettings {
  enabled: boolean;
  onExit: boolean;
  onWaitingInput: boolean;
  onlyWhenUnfocused: boolean;
}

/** 搜索范围 */
export type SearchScope = "Workspace" | "FullDisk";

/** 通用设置 */
export interface GeneralSettings {
  closeToTray: boolean;
  autoStart: boolean;
  language: string;
  dataDir: string | null;
  searchScope: SearchScope;
  /** 新手引导是否已完成 */
  onboardingCompleted: boolean;
  /** 默认 CLI 工具（自我对话、resume 回退等场景） */
  defaultCliTool: string;
  /** 页面顶部显示的常用启动项 */
  launchFavorites: string[];
  /** 工作空间右键菜单中隐藏非常用启动项 */
  hideNonFavoriteLaunchActions: boolean;
}

/** 环境检测原始结果（来自 Rust check_environment 命令） */
export interface EnvironmentInfoRaw {
  node: { installed: boolean; version: string | null };
  /** 动态 CLI 工具检测结果 */
  cliTools: import("./terminal").CliToolInfo[];
}

/** 环境检测结果（含向后兼容字段） */
export interface EnvironmentInfo extends EnvironmentInfoRaw {
  /** @deprecated 由 normalizeEnvironmentInfo 填充 */
  claude: { installed: boolean; version: string | null };
  /** @deprecated 由 normalizeEnvironmentInfo 填充 */
  codex: { installed: boolean; version: string | null };
}

/** 截图设置 */
export interface ScreenshotSettings {
  shortcut: string;
  retentionDays: number;
}

/** 语音输入设置 */
export interface VoiceSettings {
  enabled: boolean;
  provider: "dashscope" | "mimo";
  dashscopeApiKey: string;
  region: "cn" | "intl";
  model: string;
  mimoApiKey: string;
  mimoBaseUrl: string;
  mimoModel: string;
  language: string | null;
  enableItn: boolean;
  maxRecordSeconds: number;
}

export interface CliLauncherSettings {
  overrides: Record<string, CliLauncherOverride>;
}

export interface CliLauncherOverride {
  command: string;
}

/** 布局浮窗设置 */
export interface LayoutSwitcherSettings {
  windowX: number | null;
  windowY: number | null;
  pinned: boolean;
}

export interface WebAccessSettings {
  enabled: boolean;
  autoOpen: boolean;
  port: number;
  allowLan: boolean;
  ipWhitelist: string[];
  authEnabled: boolean;
  username: string;
  passwordSalt: string | null;
  passwordHash: string | null;
  lockOnIdleMinutes: number;
  /** 远程只读模式：非回环来源（含 Tailscale Serve 转发）仅允许只读操作 */
  remoteReadOnly: boolean;
}

/** Orchestrator（HTTP+MCP server）绑定模式 */
export type OrchestratorBindMode = "auto" | "loopback" | "all";

export interface OrchestratorSettings {
  bindMode: OrchestratorBindMode;
}

/** Orchestrator 运行状态（get_orchestrator_status） */
export interface OrchestratorBindDecision {
  host: string;
  mode: string;
  reason: string;
}

export interface OrchestratorStatus {
  port: number | null;
  bind: OrchestratorBindDecision | null;
}

export interface WebAccessStatus {
  enabled: boolean;
  running: boolean;
  pid: number | null;
  url: string;
  bindHost: string;
  port: number;
  lanRequested: boolean;
  lanActive: boolean;
  authRequired: boolean;
  passwordConfigured: boolean;
}

/** 数据目录信息 */
export interface DataDirInfo {
  currentPath: string;
  defaultPath: string;
  isDefault: boolean;
  sizeBytes: number;
}

/** 终端状态
 *
 * 阶段 2 扩充：与 Rust 端 SessionStatus 对齐（详见 cc-panes-core/src/services/terminal_service.rs:309）。
 * 8 个细分状态 + 1 个 legacy `active`（PTY ANSI 推断回退值）。
 */
export type TerminalStatusType =
  | "initializing"
  | "idle"
  | "thinking"
  | "toolRunning"
  | "compacting"
  | "waitingInput"
  | "error"
  | "exited"
  | "active";

/**
 * "正在干活" 状态集合。
 *
 * 用于前端判断 session 是否处于忙碌态（显示脉动 / 不让关 tab / 计入 active 数等）。
 * 包含 legacy `active`（hook 未启用时 PTY 推断的回退值）。
 *
 * **不要直接写 `status === "active"`** —— 阶段 2 之后状态多了 thinking/toolRunning/compacting，
 * 直接判等会漏掉这些 hook 主导的细分状态。统一用 `BUSY_STATUSES.has(status)`。
 */
export const BUSY_STATUSES: ReadonlySet<TerminalStatusType> = new Set([
  "active",
  "thinking",
  "toolRunning",
  "compacting",
]);

/** session 是否处于忙碌态（与 BUSY_STATUSES 对应的便捷函数） */
export function isBusyStatus(status: TerminalStatusType | null | undefined): boolean {
  return status != null && BUSY_STATUSES.has(status);
}

/** 终端状态信息 */
export interface TerminalStatusInfo {
  sessionId: string;
  status: TerminalStatusType;
  lastOutputAt: number;
  pid?: number;
  exitCode?: number;
  currentToolName?: string;
  currentToolUseId?: string;
  currentToolSummary?: string;
  updatedAt: number;
}
