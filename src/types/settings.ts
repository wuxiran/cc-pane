/** 应用设置 */
export interface AppSettings {
  proxy: ProxySettings;
  theme: ThemeSettings;
  terminal: TerminalSettings;
  shortcuts: ShortcutSettings;
  general: GeneralSettings;
  notification: NotificationSettings;
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

/** 通用设置 */
export interface GeneralSettings {
  closeToTray: boolean;
  autoStart: boolean;
  language: string;
  dataDir: string | null;
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
}
