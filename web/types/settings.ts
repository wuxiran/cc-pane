/** 应用设置 */
export interface AppSettings {
  proxy: ProxySettings;
  theme: ThemeSettings;
  terminal: TerminalSettings;
  shortcuts: ShortcutSettings;
  general: GeneralSettings;
  localHistory: LocalHistorySettings;
  notification: NotificationSettings;
  screenshot: ScreenshotSettings;
  voice: VoiceSettings;
  cliLaunchers: CliLauncherSettings;
  layoutSwitcher: LayoutSwitcherSettings;
  webAccess: WebAccessSettings;
  orchestrator: OrchestratorSettings;
  wallpaper: WallpaperSettings;
}

/** Local History 全局设置 */
export interface LocalHistorySettings {
  enabled: boolean;
}

/** 壁纸种类 / 铺放方式 / 视频省电策略 */
export type WallpaperKind = "none" | "image" | "video";
export type WallpaperFit = "cover" | "contain" | "tile" | "center";
export type WallpaperPowerSaver = "auto" | "always" | "never";

/** 主区壁纸设置（镜像 cc-panes-core WallpaperSettings） */
export interface WallpaperSettings {
  enabled: boolean;
  kind: WallpaperKind;
  /** wallpapers_dir 下的相对文件名（受控 uuid 文件名） */
  file: string | null;
  fit: WallpaperFit;
  /** 媒体层不透明度 0.1..1 */
  opacity: number;
  /** 高斯模糊 px 0..64 */
  blur: number;
  /** 压暗遮罩 0..0.9 */
  dim: number;
  /** 终端背景不透明度 0..1（1 = 不透明走原路径；0 = 全透明，字直接浮在壁纸上） */
  terminalOpacity: number;
  /**
   * 面板玻璃模糊 px 0..24。壁纸激活时面板背景变透明，面板自身的
   * backdrop-filter 会直接糊在壁纸上（视频会被糊没），此值接管该 token。
   * 默认 0 = 壁纸之上不叠玻璃模糊。
   */
  glassBlur: number;
  video: WallpaperVideoSettings;
  music: WallpaperMusicSettings;
}

export interface WallpaperVideoSettings {
  autoplay: boolean;
  /** 0.25..2 */
  playbackRate: number;
  pauseWhenUnfocused: boolean;
  powerSaver: WallpaperPowerSaver;
}

export interface WallpaperMusicSettings {
  enabled: boolean;
  file: string | null;
  /** 0..1 */
  volume: number;
  loopPlayback: boolean;
  autoplay: boolean;
  /** 失焦是否暂停：独立于 video.pauseWhenUnfocused，默认 false（BGM 属全局氛围） */
  pauseWhenUnfocused: boolean;
  /**
   * 用视频壁纸自带的音轨当 BGM（仅 kind=video 有意义），忽略 `file`。
   * 走独立 audio 喂同一文件，video 保持 muted——见 Rust 侧同名字段注释。
   */
  useVideoAudio: boolean;
}

/** 壁纸库文件（list_wallpapers 返回项） */
export interface WallpaperFileInfo {
  name: string;
  kind: "image" | "video" | "audio";
  sizeBytes: number;
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
  /** 终端会话共享：PTY 托管到独立 daemon，桌面与 Web/移动端附着同一批会话。重启应用生效 */
  daemonEnabled: boolean;
  /** daemon 孤儿会话过期时间（分钟）：无人查看超过该时长的会话按先进先出回收。改动约 60s 内生效，无需重启。历史值 0 会被后端迁移为默认 24h */
  daemonOrphanTtlMinutes: number;
  /** 禁用 daemon 孤儿会话回收（true = 永不回收）。取代旧的"TTL=0 表示永不过期"语义 */
  daemonOrphanReaperDisabled: boolean;
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
  /** 禁用 WSL 用量统计扫描（不再触碰 \\wsl$ 与 wsl.exe，避免唤醒 WSL VM） */
  disableWslUsageScan: boolean;
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
  /** 是否在终端右下角显示语音悬浮按钮（关闭后仍可用快捷键触发录音） */
  showFloatingButton: boolean;
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
  /** 远程只读的例外：已通过密码登录的远程会话允许写入；未配置密码时不生效 */
  remoteAuthenticatedWrite: boolean;
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

/** Tailscale 探测结果（detect_tailscale_status，只读探测） */
export interface TailscaleStatus {
  installed: boolean;
  backendState: string | null;
  dnsName: string | null;
  tailscaleIps: string[];
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

export interface UninstallCleanupReport {
  cleaned: string[];
  skipped: string[];
  failed: string[];
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
