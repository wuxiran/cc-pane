/** 应用设置 */
export interface AppSettings {
  proxy: ProxySettings;
  theme: ThemeSettings;
  terminal: TerminalSettings;
  shortcuts: ShortcutSettings;
  general: GeneralSettings;
  notification: NotificationSettings;
  screenshot: ScreenshotSettings;
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
export interface TerminalSettings {
  fontSize: number;
  fontFamily: string;
  cursorStyle: string;
  cursorBlink: boolean;
  scrollback: number;
  /** 用户选择的 Shell ID（如 "pwsh", "cmd"），null 表示自动探测 */
  shell: string | null;
  /** 禁用 ConPTY 输出 sanitize（默认 true） */
  disableConptySanitize: boolean | null;
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

/** 数据目录信息 */
export interface DataDirInfo {
  currentPath: string;
  defaultPath: string;
  isDefault: boolean;
  sizeBytes: number;
}

/** 终端状态 */
export type TerminalStatusType = "active" | "idle" | "waitingInput" | "exited";

/** 终端状态信息 */
export interface TerminalStatusInfo {
  sessionId: string;
  status: TerminalStatusType;
  lastOutputAt: number;
  pid?: number;
}
