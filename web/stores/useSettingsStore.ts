import { create } from "zustand";
import { settingsService } from "@/services";
import type { AppSettings } from "@/types";
import { handleErrorSilent } from "@/utils";
import { getDefaultSidebarFavoriteLaunchActionIds } from "@/components/sidebar/launchMenu";
import { DEFAULT_CCCHAN_SETTINGS } from "./useCCChanStore";
import type { CCChanSettings } from "@/ccchan/types";
import type { CliLauncherSettings, LayoutSwitcherSettings, OrchestratorSettings, WallpaperSettings, WebAccessSettings } from "@/types";

const defaultCloseToTray = () => {
  if (typeof navigator === "undefined") {
    return true;
  }
  return !/Linux/i.test(navigator.userAgent);
};

interface SettingsState {
  settings: AppSettings | null;
  loading: boolean;
  loadSettings: () => Promise<void>;
  saveSettings: (newSettings: AppSettings) => Promise<void>;
  /**
   * 终端字号的高频入口（Ctrl+滚轮缩放）。
   * 立刻更新内存态让终端跟手，落盘防抖——滚轮一次能触发几十个事件，
   * 每个都走 saveSettings 会把 IPC 和磁盘打满。
   */
  setTerminalFontSize: (size: number) => void;
  getDefaults: () => AppSettings;
}

export const TERMINAL_FONT_SIZE_MIN = 10;
export const TERMINAL_FONT_SIZE_MAX = 32;
export const TERMINAL_FONT_SIZE_DEFAULT = 15;

export function normalizeTerminalFontSize(size?: number | null): number {
  if (!Number.isFinite(size)) return TERMINAL_FONT_SIZE_DEFAULT;
  return Math.min(
    TERMINAL_FONT_SIZE_MAX,
    Math.max(TERMINAL_FONT_SIZE_MIN, Math.round(size as number)),
  );
}

export {
  TERMINAL_SCROLLBACK_MIN,
  TERMINAL_SCROLLBACK_MAX,
  TERMINAL_SCROLLBACK_DEFAULT,
  normalizeTerminalScrollback,
} from "@/lib/terminalScrollback";
import { TERMINAL_SCROLLBACK_DEFAULT } from "@/lib/terminalScrollback";

const FONT_SIZE_PERSIST_DEBOUNCE_MS = 400;
let fontSizePersistTimer: ReturnType<typeof setTimeout> | null = null;

type AppSettingsWithCCChan = AppSettings & { ccchan: CCChanSettings };

const DEFAULT_LAYOUT_SWITCHER_SETTINGS: LayoutSwitcherSettings = {
  windowX: null,
  windowY: null,
  pinned: false,
};

const DEFAULT_WEB_ACCESS_SETTINGS: WebAccessSettings = {
  enabled: true,
  autoOpen: false,
  port: 18080,
  allowLan: false,
  ipWhitelist: [],
  authEnabled: false,
  username: "admin",
  passwordSalt: null,
  passwordHash: null,
  lockOnIdleMinutes: 30,
  remoteReadOnly: false,
  remoteAuthenticatedWrite: false,
};

const DEFAULT_CLI_LAUNCHER_SETTINGS: CliLauncherSettings = {
  overrides: {},
};

const DEFAULT_ORCHESTRATOR_SETTINGS: OrchestratorSettings = {
  bindMode: "auto",
  allowMcpYoloProfiles: false,
  followAgentLaunch: false,
};

const DEFAULT_LOCAL_HISTORY_SETTINGS = {
  enabled: true,
};

const DEFAULT_UPDATE_SETTINGS = {
  notifyEnabled: true,
  skippedVersion: null,
  lastNotifiedAt: null,
};

const DEFAULT_TIPS_SETTINGS = {
  enabled: true,
  lastShownAt: null,
  seen: [],
  tried: [],
  dismissRun: 0,
  sessionCount: 0,
};

export const DEFAULT_WALLPAPER_SETTINGS: WallpaperSettings = {
  enabled: false,
  kind: "none",
  file: null,
  fit: "cover",
  opacity: 1,
  blur: 0,
  dim: 0.35,
  terminalOpacity: 0.85,
  glassBlur: 0,
  video: {
    autoplay: true,
    playbackRate: 1,
    pauseWhenUnfocused: true,
    powerSaver: "auto",
  },
  music: {
    enabled: false,
    file: null,
    volume: 0.5,
    loopPlayback: true,
    autoplay: true,
    pauseWhenUnfocused: false,
    useVideoAudio: false,
  },
};

function withCCChanSettings(settings: AppSettings): AppSettingsWithCCChan {
  const maybeWithCCChan = settings as Partial<AppSettingsWithCCChan>;
  const maybeSettings = settings as Partial<AppSettings>;
  return {
    ...settings,
    cliLaunchers: {
      ...DEFAULT_CLI_LAUNCHER_SETTINGS,
      ...maybeSettings.cliLaunchers,
      overrides: {
        ...DEFAULT_CLI_LAUNCHER_SETTINGS.overrides,
        ...maybeSettings.cliLaunchers?.overrides,
      },
    },
    layoutSwitcher: {
      ...DEFAULT_LAYOUT_SWITCHER_SETTINGS,
      ...settings.layoutSwitcher,
    },
    webAccess: {
      ...DEFAULT_WEB_ACCESS_SETTINGS,
      ...settings.webAccess,
    },
    orchestrator: {
      ...DEFAULT_ORCHESTRATOR_SETTINGS,
      ...maybeSettings.orchestrator,
    },
    localHistory: {
      ...DEFAULT_LOCAL_HISTORY_SETTINGS,
      ...maybeSettings.localHistory,
    },
    update: {
      ...DEFAULT_UPDATE_SETTINGS,
      ...maybeSettings.update,
    },
    tips: {
      ...DEFAULT_TIPS_SETTINGS,
      ...maybeSettings.tips,
      seen: maybeSettings.tips?.seen ?? [],
      tried: maybeSettings.tips?.tried ?? [],
    },
    // wallpaper 是三层嵌套结构：老配置升级后 settings.wallpaper 或其 video/music
    // 子块可能是 undefined，必须逐层合并默认，否则读 settings.wallpaper.video.* 直接崩
    wallpaper: {
      ...DEFAULT_WALLPAPER_SETTINGS,
      ...maybeSettings.wallpaper,
      video: {
        ...DEFAULT_WALLPAPER_SETTINGS.video,
        ...maybeSettings.wallpaper?.video,
      },
      music: {
        ...DEFAULT_WALLPAPER_SETTINGS.music,
        ...maybeSettings.wallpaper?.music,
      },
    },
    ccchan: {
      ...DEFAULT_CCCHAN_SETTINGS,
      ...maybeWithCCChan.ccchan,
    },
  };
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: null,
  loading: false,

  loadSettings: async () => {
    set({ loading: true });
    try {
      const settings = await settingsService.getSettings();
      set({ settings: withCCChanSettings(settings) });
    } catch (e) {
      handleErrorSilent(e, "load settings");
    } finally {
      set({ loading: false });
    }
  },

  saveSettings: async (newSettings) => {
    try {
      const normalized = withCCChanSettings(newSettings);
      await settingsService.updateSettings(normalized);
      set({ settings: normalized });
    } catch (e) {
      handleErrorSilent(e, "save settings");
      throw e;
    }
  },

  setTerminalFontSize: (size) => {
    const current = get().settings;
    if (!current) return;
    const clamped = normalizeTerminalFontSize(size);
    if (current.terminal.fontSize === clamped) return;

    // 先更内存：TerminalView 的字号 effect 订阅的就是这里，改完立刻跟手
    const next = { ...current, terminal: { ...current.terminal, fontSize: clamped } };
    set({ settings: next });

    // 再防抖落盘。停手 400ms 才写一次，滚轮过程中零 IPC。
    if (fontSizePersistTimer) clearTimeout(fontSizePersistTimer);
    fontSizePersistTimer = setTimeout(() => {
      fontSizePersistTimer = null;
      const latest = get().settings;
      if (!latest) return;
      void settingsService
        .updateSettings(withCCChanSettings(latest))
        .catch((e) => handleErrorSilent(e, "persist terminal font size"));
    }, FONT_SIZE_PERSIST_DEBOUNCE_MS);
  },

  getDefaults: () => withCCChanSettings({
    settingsVersion: 1,
    proxy: {
      enabled: false,
      proxyType: "http",
      host: "",
      port: 7890,
      username: null,
      password: null,
      noProxy: "localhost,127.0.0.1",
    },
    theme: {
      mode: "dark",
    },
    terminal: {
      fontSize: 15,
      fontFamily: '"Maple Mono NF CN", "Maple Mono", "Cascadia Code", "Cascadia Mono", "JetBrains Mono", Consolas, "Sarasa Mono SC", "Microsoft YaHei UI", "PingFang SC", monospace',
      cursorStyle: "block",
      cursorBlink: false,
      scrollback: TERMINAL_SCROLLBACK_DEFAULT,
      themeMode: "followApp",
      rendererMode: "auto",
      shell: null,
      disableConptySanitize: null,
      resumeIdBackfillEnabled: null,
      daemonEnabled: true,
      daemonOrphanTtlMinutes: 1440,
      daemonOrphanReaperDisabled: false,
      autoAdoptDaemonSessions: true,
      lowerSessionPriority: true,
      sessionCpuWeight: null,
    },
    shortcuts: {
      bindings: {
        "toggle-sidebar": "Ctrl+B",
        "toggle-fullscreen": "F11",
        "new-tab": "Ctrl+T",
        "close-tab": "Ctrl+W",
        settings: "Ctrl+,",
        "command-palette": "Ctrl+K",
        "terminal-zoom-in": "Ctrl+=",
        "terminal-zoom-out": "Ctrl+-",
        "terminal-zoom-reset": "Ctrl+0",
        "toggle-layouts": "Ctrl+Alt+L",
        "split-right": "Ctrl+\\",
        "split-down": "Ctrl+-",
        "focus-pane-left": "Alt+Left",
        "focus-pane-right": "Alt+Right",
        "focus-pane-up": "Alt+Up",
        "focus-pane-down": "Alt+Down",
        "next-tab": "Ctrl+Tab",
        "prev-tab": "Ctrl+Shift+Tab",
        "toggle-mini-mode": "Ctrl+M",
        "voice-input": "Ctrl+Alt+M",
        "switch-tab-1": "Ctrl+1",
        "switch-tab-2": "Ctrl+2",
        "switch-tab-3": "Ctrl+3",
        "switch-tab-4": "Ctrl+4",
        "switch-tab-5": "Ctrl+5",
        "switch-tab-6": "Ctrl+6",
        "switch-tab-7": "Ctrl+7",
        "switch-tab-8": "Ctrl+8",
        "switch-tab-9": "Ctrl+9",
        "switch-layout-1": "Alt+1",
        "switch-layout-2": "Alt+2",
        "switch-layout-3": "Alt+3",
        "switch-layout-4": "Alt+4",
        "switch-layout-5": "Alt+5",
        "switch-layout-6": "Alt+6",
        "switch-layout-7": "Alt+7",
        "switch-layout-8": "Alt+8",
        "switch-layout-9": "Alt+9",
      },
    },
    general: {
      closeToTray: defaultCloseToTray(),
      autoStart: false,
      language: "zh-CN",
      dataDir: null,
      searchScope: "Workspace",
      onboardingCompleted: false,
      defaultCliTool: "claude",
      launchFavorites: getDefaultSidebarFavoriteLaunchActionIds(),
      // 默认收起非常用启动项：新用户初次登录只见收藏的 3 条（终端 / claude / codex），
      // 侧边栏"隐藏非常用菜单"开关可随时展开全部 7 个 CLI × 环境变体，
      // 避免一上来就是 ~30 条密密麻麻的长列表。老用户的已存设置不受影响。
      hideNonFavoriteLaunchActions: true,
      disableWslUsageScan: false,
      showSystemResources: true,
    },
    localHistory: DEFAULT_LOCAL_HISTORY_SETTINGS,
    notification: {
      enabled: true,
      onExit: true,
      onWaitingInput: true,
      onlyWhenUnfocused: true,
    },
    update: DEFAULT_UPDATE_SETTINGS,
    tips: DEFAULT_TIPS_SETTINGS,
    screenshot: {
      shortcut: "Ctrl+Shift+S",
      retentionDays: 7,
    },
    voice: {
      enabled: false,
      provider: "dashscope",
      dashscopeApiKey: "",
      region: "cn",
      model: "qwen3-asr-flash",
      mimoApiKey: "",
      mimoBaseUrl: "https://api.xiaomimimo.com/v1",
      mimoModel: "mimo-v2.5",
      language: null,
      enableItn: false,
      maxRecordSeconds: 60,
      showFloatingButton: true,
    },
    cliLaunchers: DEFAULT_CLI_LAUNCHER_SETTINGS,
    layoutSwitcher: DEFAULT_LAYOUT_SWITCHER_SETTINGS,
    mainWindow: { width: null, height: null, x: null, y: null, maximized: null },
    webAccess: DEFAULT_WEB_ACCESS_SETTINGS,
    orchestrator: DEFAULT_ORCHESTRATOR_SETTINGS,
    wallpaper: DEFAULT_WALLPAPER_SETTINGS,
  }),
}));
