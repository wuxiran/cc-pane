import type { ThemeShape } from "@/theme/themeShapes";

/** 应用设置 */
export interface AppSettings {
  /** 配置语义版本；由后端用于一次性默认值迁移。 */
  settingsVersion: number;
  proxy: ProxySettings;
  theme: ThemeSettings;
  terminal: TerminalSettings;
  shortcuts: ShortcutSettings;
  general: GeneralSettings;
  localHistory: LocalHistorySettings;
  notification: NotificationSettings;
  update: UpdateSettings;
  tips: TipsSettings;
  screenshot: ScreenshotSettings;
  voice: VoiceSettings;
  cliLaunchers: CliLauncherSettings;
  layoutSwitcher: LayoutSwitcherSettings;
  mainWindow: MainWindowSettings;
  webAccess: WebAccessSettings;
  orchestrator: OrchestratorSettings;
  wallpaper: WallpaperSettings;
  im: ImSettings;
  experimental: ExperimentalSettings;
}

/** 实验功能开关（镜像 cc-panes-core ExperimentalSettings）。默认全关；
 * 入口组件经 `useExperimentalFeature(id)` 读取，未勾选时不渲染入口。 */
export interface ExperimentalSettings {
  mediaGeneration: boolean;
  /** 短剧制作台（DramaStudio + 批量转绘）；独立开关便于单独下线重构。 */
  dramaStudio: boolean;
  skillMarket: boolean;
}

export type ExperimentalFeatureId = keyof ExperimentalSettings;

/** IM 外推渠道类型（镜像 cc-notify ChannelType） */
export type ImChannelType =
  | "webhook"
  | "telegram"
  | "dingtalk"
  | "wecom"
  | "lark"
  | "slack";

/** IM 外推事件 kind（与后端 NotificationService kind 同口径） */
export type ImEventKind = "turn_end" | "waiting_input" | "error" | "session_exited";

/** IM 外推渠道配置（镜像 cc-notify ChannelConfig） */
export interface ImChannelConfig {
  id: string;
  channelType: ImChannelType;
  name: string;
  url: string;
  token: string | null;
  /** 钉钉加签 / 飞书签名校验 secret */
  secret: string | null;
  chatId: string | null;
  /** 订阅的事件 kind；空数组 = 全部 */
  events: string[];
  enabled: boolean;
}

/** IM 外推通知设置（镜像 cc-panes-core ImSettings）。与桌面通知分离：默认聚焦时也推。 */
export interface ImSettings {
  enabled: boolean;
  pushWhenFocused: boolean;
  channels: ImChannelConfig[];
}

/** IM 渠道最近一次发送结果（get_im_bridge_status / im-channel-result 事件载荷） */
export interface ImChannelStatus {
  channelId: string;
  channelName: string;
  kind: string;
  ok: boolean;
  error: string | null;
  /** RFC3339 */
  at: string;
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
  /** Theme preset id, or the legacy light/dark/system values. */
  mode: string;
  /** Independent surface shape applied to application chrome and controls. */
  shape: ThemeShape;
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
  /**
   * 按 CLI 覆盖终端缓冲模式: cliToolId -> "strip"(剥 alt-screen 保滚动历史) | "native"(原样透传)。
   * 缺省/无效值走内置默认(claude=strip, 其余=native), 见 terminalBufferMode.ts 与 docs/73 §2.x。
   */
  cliBufferModes?: Record<string, string> | null;
  /** Display the context usage indicator in terminal status surfaces. */
  showContextUsage: boolean;
  /** 终端底部状态栏(整条)的开关。关闭后状态栏整段不渲染,把空间让给终端区。 */
  showStatusBar: boolean;
  /** Enable backend-owned task queues and show their controls in CLI status bars. */
  taskQueueEnabled: boolean;
  /** Show local file and directory paths in terminal output as clickable links. */
  pathLinksEnabled: boolean;
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
  /** 跨端快照覆盖的差集真杀开闸（默认 false = 只打 would-kill 观察日志）。观察期零误报后方可开启 */
  snapshotApplyKillEnabled: boolean;
  /** 启动时自动认领 daemon 无主会话（严格身份匹配失败时仍会阻断） */
  autoAdoptDaemonSessions: boolean;
  /** 降低会话子进程调度优先级，让 UI 抢得过窗格里的编译任务。默认开启，新会话生效 */
  lowerSessionPriority: boolean;
  /** 会话 CPU 相对权重（1..=9，中性 5）。null 表示不设 */
  sessionCpuWeight: number | null;
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

/** 应用版本更新提示设置（镜像 cc-panes-core UpdateSettings） */
export interface UpdateSettings {
  notifyEnabled: boolean;
  skippedVersion: string | null;
  lastNotifiedAt: string | null;
}

/** 低频功能提示设置（镜像 cc-panes-core TipsSettings） */
export interface TipsSettings {
  enabled: boolean;
  lastShownAt: string | null;
  seen: string[];
  tried: string[];
  dismissRun: number;
  sessionCount: number;
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
  /** 是否在状态栏显示整机 CPU 与内存占用 */
  showSystemResources: boolean;
}

/** 环境检测原始结果（来自 Rust check_environment 命令） */
export interface EnvironmentInfoRaw {
  node: { installed: boolean; version: string | null };
  git?: { installed: boolean; version: string | null };
  wsl?: { installed: boolean; version: string | null; applicable: boolean };
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
  provider: "dashscope" | "mimo" | "custom";
  dashscopeApiKey: string;
  region: "cn" | "intl";
  model: string;
  mimoApiKey: string;
  mimoBaseUrl: string;
  mimoModel: string;
  /** 自定义 OpenAI 兼容 provider（/v1/audio/transcriptions）；apiKey 可空 = 无鉴权本地服务 */
  customApiKey: string;
  customBaseUrl: string;
  customModel: string;
  /** 录音先转 WAV 再发送（目标服务不支持 WebM 时开启） */
  customPreferWav: boolean;
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

/** 主窗口几何状态。字段全部可空 = 从未记录过，按首启默认（最大化）。 */
export interface MainWindowSettings {
  width: number | null;
  height: number | null;
  x: number | null;
  y: number | null;
  maximized: boolean | null;
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
  /** 允许 agent 创建、绑定或显式启动带危险权限参数的 YOLO profile */
  allowMcpYoloProfiles: boolean;
  /**
   * agent 启动任务时界面是否跟随跳到目标布局。默认 false——
   * 关闭时 worker 仍建在目标布局，只是不抢当前视图，改发一条可跳转的提示。
   */
  followAgentLaunch: boolean;
}

/** Orchestrator 运行状态（get_orchestrator_status） */
export interface OrchestratorBindDecision {
  host: string;
  mode: string;
  reason: string;
}

export type OrchestratorLifecycle = "binding" | "ready" | "failed";

export interface OrchestratorStatus {
  port: number | null;
  bind: OrchestratorBindDecision | null;
  lifecycle: OrchestratorLifecycle;
  attempt: number | null;
  lastError: string | null;
  nextRetryAt: number | null;
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
