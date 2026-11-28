import type { ParseKeys } from "i18next";
import type { SettingsPaneId } from "./settingsPaneIds";
import type { LucideIcon } from "lucide-react";
import {
  BarChart3,
  Bell,
  Bot,
  Cable,
  Camera,
  Compass,
  FlaskConical,
  Gauge,
  Globe,
  Image,
  Info,
  Keyboard,
  LibraryBig,
  ListChecks,
  MessageSquare,
  Mic,
  MonitorSmartphone,
  Palette,
  PanelsTopLeft,
  Settings,
  Shield,
  SquareTerminal,
  Terminal,
  Wifi,
} from "lucide-react";

export type SettingsGroupId =
  | "application"
  | "services";

export type SettingsPageId =
  | "general"
  | "appearance"
  | "terminal"
  | "ai-tools"
  | "system"
  | "devices"
  | "ccchan"
  | "setup-guide"
  | "privacy"
  | "experimental"
  | "usage-stats"
  | "about";

export type { SettingsPaneId } from "./settingsPaneIds";

type SettingsTranslationKey = ParseKeys<"settings">;

export interface SettingsSearchEntry {
  id: string;
  titleKey: string;
  descriptionKey?: string;
  keywordsKey?: string;
  targetSectionId: string;
}

export interface SettingsPaneDefinition {
  id: SettingsPaneId;
  icon: LucideIcon;
  titleKey: SettingsTranslationKey;
  descriptionKey?: SettingsTranslationKey;
  page: SettingsPageId;
  searchEntries: readonly SettingsSearchEntry[];
  availability?: "tauri" | "non-mac";
  layout?: "default" | "wide";
}

export interface SettingsPageDefinition {
  id: SettingsPageId;
  icon: LucideIcon;
  titleKey: SettingsTranslationKey;
  group: SettingsGroupId;
  paneIds: readonly SettingsPaneId[];
}

export interface SettingsEnvironment {
  isMac: boolean;
  isTauri: boolean;
}

export const SETTINGS_GROUPS: ReadonlyArray<{
  id: SettingsGroupId;
  titleKey: SettingsTranslationKey;
}> = [
  { id: "application", titleKey: "groups.application" },
  { id: "services", titleKey: "groups.services" },
];

export const SETTINGS_PAGES: readonly SettingsPageDefinition[] = [
  {
    id: "general",
    icon: Settings,
    titleKey: "pages.general.title",
    group: "application",
    paneIds: ["general", "modules"],
  },
  {
    // 外观一站式：颜色/形态/壁纸收到同一个 Page，「改外观只去一个地方」
    id: "appearance",
    icon: Palette,
    titleKey: "pages.appearance.title",
    group: "application",
    paneIds: ["theme", "theme-shape", "wallpaper"],
  },
  {
    id: "terminal",
    icon: Terminal,
    titleKey: "pages.terminal.title",
    group: "application",
    paneIds: ["terminal", "quick-terminal", "shortcuts"],
  },
  {
    id: "ai-tools",
    icon: Bot,
    titleKey: "pages.aiTools.title",
    group: "application",
    paneIds: ["cli-launchers", "agent-chat", "quick-commands"],
  },
  {
    id: "system",
    icon: Globe,
    titleKey: "pages.system.title",
    group: "services",
    paneIds: ["proxy", "browser", "notification", "im-bridge", "screenshot", "voice", "performance"],
  },
  {
    // 设备与访问（对标 T3「共享与访问」）：本机信息、网络访问、Tailscale、已授权客户端、MCP 端点、服务控制
    id: "devices",
    icon: MonitorSmartphone,
    titleKey: "pages.devices.title",
    group: "services",
    paneIds: ["web-access"],
  },
  {
    // 隐私与安全：开关全部默认关闭，打开后相关入口才出现。
    id: "privacy",
    icon: Shield,
    titleKey: "pages.privacy.title",
    group: "services",
    paneIds: ["privacy"],
  },
  {
    id: "ccchan",
    icon: Bot,
    titleKey: "ccchanTitle",
    group: "services",
    paneIds: ["ccchan"],
  },
  {
    id: "experimental",
    icon: FlaskConical,
    titleKey: "experimental.title",
    group: "services",
    paneIds: ["experimental"],
  },
  {
    id: "usage-stats",
    icon: BarChart3,
    titleKey: "pages.usageStats.title",
    group: "services",
    paneIds: ["usage-stats"],
  },
  {
    id: "setup-guide",
    icon: ListChecks,
    titleKey: "setupGuide.title",
    group: "services",
    paneIds: ["setup-guide"],
  },
  {
    id: "about",
    icon: Info,
    titleKey: "pages.about.title",
    group: "services",
    paneIds: ["about"],
  },
];

export const SETTINGS_PANES: readonly SettingsPaneDefinition[] = [
  {
    id: "setup-guide",
    icon: ListChecks,
    titleKey: "setupGuide.title",
    descriptionKey: "setupGuide.description",
    page: "setup-guide",
    searchEntries: [{
      id: "workflow-checklist",
      titleKey: "setupGuide.title",
      descriptionKey: "setupGuide.description",
      keywordsKey: "searchKeywords.setupGuide",
      targetSectionId: "setup-guide-root",
    }],
  },
  {
    id: "theme",
    icon: Palette,
    titleKey: "theme.title",
    page: "appearance",
    searchEntries: [
      { id: "color", titleKey: "theme.colorTitle", descriptionKey: "theme.colorDescription", keywordsKey: "searchKeywords.theme", targetSectionId: "theme-color" },
    ],
  },
  {
    id: "theme-shape",
    icon: Palette,
    titleKey: "theme.shapeTabTitle",
    page: "appearance",
    searchEntries: [
      { id: "shape", titleKey: "theme.shapeTitle", descriptionKey: "theme.shapeDescription", keywordsKey: "searchKeywords.themeShape", targetSectionId: "theme-shape" },
      { id: "density", titleKey: "theme.density.title", descriptionKey: "theme.density.description", keywordsKey: "searchKeywords.themeDensity", targetSectionId: "theme-density" },
    ],
  },
  {
    id: "general",
    icon: Settings,
    titleKey: "general",
    page: "general",
    searchEntries: [
      { id: "startup", titleKey: "autoStart", keywordsKey: "searchKeywords.general", targetSectionId: "general-root" },
      { id: "history", titleKey: "localHistoryEnabled", descriptionKey: "localHistoryEnabledDesc", targetSectionId: "general-root" },
      { id: "system-resources", titleKey: "showSystemResources", targetSectionId: "general-root" },
      { id: "update-notify", titleKey: "updateNotifyEnabled", descriptionKey: "updateNotifyEnabledDesc", targetSectionId: "general-root" },
      { id: "feature-tips", titleKey: "featureTipsEnabled", descriptionKey: "featureTipsEnabledDesc", targetSectionId: "general-root" },
      { id: "language", titleKey: "language", targetSectionId: "general-root" },
      { id: "cli", titleKey: "defaultCliTool", descriptionKey: "defaultCliToolDesc", targetSectionId: "general-root" },
      { id: "data", titleKey: "dataDir", descriptionKey: "dataDirDesc", targetSectionId: "general-root" },
      { id: "tray", titleKey: "traySectionTitle", descriptionKey: "trayShowSessionStatusDesc", targetSectionId: "general-tray" },
    ],
  },
  {
    id: "usage-stats",
    icon: BarChart3,
    titleKey: "usageStats.title",
    descriptionKey: "usageStats.description",
    page: "usage-stats",
    searchEntries: [{
      id: "usage-trends",
      titleKey: "usageStats.title",
      descriptionKey: "usageStats.description",
      keywordsKey: "searchKeywords.usageStats",
      targetSectionId: "usage-stats-root",
    }],
  },
  {
    id: "wallpaper",
    icon: Image,
    titleKey: "wallpaper",
    descriptionKey: "wallpaperDesc",
    page: "appearance",
    searchEntries: [
      { id: "media", titleKey: "wallpaperImage", descriptionKey: "wallpaperImageHint", keywordsKey: "searchKeywords.wallpaper", targetSectionId: "wallpaper-root" },
      { id: "sliders", titleKey: "wallpaperOpacity", descriptionKey: "wallpaperTerminalOpacityHint", targetSectionId: "wallpaper-sliders" },
      { id: "music", titleKey: "wallpaperMusicEnabled", descriptionKey: "wallpaperMusicPauseUnfocusedHint", targetSectionId: "wallpaper-music" },
    ],
    availability: "tauri",
  },
  {
    id: "terminal",
    icon: Terminal,
    titleKey: "terminal",
    page: "terminal",
    searchEntries: [
      { id: "font", titleKey: "fontSize", descriptionKey: "fontFamilyCjkHint", keywordsKey: "searchKeywords.font", targetSectionId: "terminal-font" },
      { id: "theme", titleKey: "terminalTheme", targetSectionId: "terminal-root" },
      { id: "renderer", titleKey: "rendererMode", descriptionKey: "rendererHint", targetSectionId: "terminal-root" },
      { id: "path-links", titleKey: "pathLinksEnabled", descriptionKey: "pathLinksEnabledHint", targetSectionId: "terminal-path-links" },
      { id: "inline-images", titleKey: "inlineImagesEnabled", descriptionKey: "inlineImagesEnabledHint", keywordsKey: "searchKeywords.inlineImages", targetSectionId: "terminal-inline-images" },
      { id: "context-usage", titleKey: "showContextUsage", descriptionKey: "showContextUsageHint", targetSectionId: "terminal-context-usage" },
      { id: "auto-trust", titleKey: "autoTrustRegisteredProjects", descriptionKey: "autoTrustRegisteredProjectsHint", targetSectionId: "terminal-auto-trust" },
      { id: "status-bar", titleKey: "showStatusBar", descriptionKey: "showStatusBarHint", targetSectionId: "terminal-status-bar" },
      { id: "task-queue", titleKey: "taskQueueEnabled", descriptionKey: "taskQueueEnabledHint", targetSectionId: "terminal-task-queue" },
      { id: "split-passthrough", titleKey: "splitShortcutPassthrough", descriptionKey: "splitShortcutPassthroughHint", targetSectionId: "terminal-split-passthrough" },
      { id: "shell", titleKey: "shellAutoDetect", targetSectionId: "terminal-shell" },
      { id: "daemon", titleKey: "terminalDaemon", descriptionKey: "terminalDaemonHint", targetSectionId: "terminal-root" },
    ],
  },
  {
    id: "quick-terminal",
    icon: SquareTerminal,
    titleKey: "quickTerminalTitle",
    descriptionKey: "quickTerminalDesc",
    page: "terminal",
    searchEntries: [
      { id: "quick-terminal", titleKey: "quickTerminalTitle", descriptionKey: "quickTerminalDesc", keywordsKey: "searchKeywords.quickTerminal", targetSectionId: "quick-terminal-root" },
    ],
  },
  {
    id: "shortcuts",
    icon: Keyboard,
    titleKey: "shortcuts",
    descriptionKey: "shortcutsHint",
    page: "terminal",
    searchEntries: [
      { id: "bindings", titleKey: "shortcutsTitle", descriptionKey: "shortcutsHint", keywordsKey: "searchKeywords.shortcuts", targetSectionId: "shortcuts-list" },
    ],
  },
  {
    id: "modules",
    icon: PanelsTopLeft,
    titleKey: "modules.title",
    descriptionKey: "modules.description",
    page: "general",
    searchEntries: [
      {
        id: "placement",
        titleKey: "modules.title",
        descriptionKey: "modules.description",
        keywordsKey: "searchKeywords.modules",
        targetSectionId: "modules-root",
      },
    ],
  },
  { id: "cli-launchers", icon: Cable, titleKey: "cliLaunchers", descriptionKey: "cliLaunchersDesc", page: "ai-tools", searchEntries: [
    { id: "commands", titleKey: "cliLaunchersTitle", descriptionKey: "cliLaunchersDesc", targetSectionId: "cli-launchers-root" },
  ] },
  { id: "agent-chat", icon: MessageSquare, titleKey: "agentChat.title", descriptionKey: "agentChat.description", page: "ai-tools", searchEntries: [
    { id: "codex-acp", titleKey: "agentChat.codexForceAcp", descriptionKey: "agentChat.codexForceAcpDesc", keywordsKey: "searchKeywords.agentChat", targetSectionId: "agent-chat-root" },
  ] },
  { id: "proxy", icon: Globe, titleKey: "proxy", page: "system", searchEntries: [
    { id: "connection", titleKey: "proxyTitle", keywordsKey: "searchKeywords.proxy", targetSectionId: "proxy-root" },
    { id: "server", titleKey: "enableProxy", descriptionKey: "excludeListHint", targetSectionId: "proxy-server" },
  ] },
  { id: "performance", icon: Gauge, titleKey: "performance.title", descriptionKey: "performance.description", page: "system", searchEntries: [
    { id: "build", titleKey: "performance.buildGroup", descriptionKey: "performance.buildParallelismEnabledHint", keywordsKey: "searchKeywords.performance", targetSectionId: "performance-build" },
    { id: "codex", titleKey: "performance.codexGroup", descriptionKey: "performance.codexLightweightEnabledHint", targetSectionId: "performance-codex" },
    { id: "heavy-gate", titleKey: "performance.heavyGateGroup", descriptionKey: "performance.heavyGateEnabledHint", targetSectionId: "performance-heavy-gate" },
    { id: "heavy-ledger", titleKey: "performance.heavyLedgerGroup", descriptionKey: "performance.heavyLedgerEnabledHint", targetSectionId: "performance-heavy-ledger" },
    { id: "session-priority", titleKey: "lowerSessionPriority", descriptionKey: "lowerSessionPriorityHint", targetSectionId: "performance-session-policy" },
    { id: "keep-awake", titleKey: "performance.keepAwake", descriptionKey: "performance.keepAwakeHint", targetSectionId: "performance-session-policy" },
    { id: "session-cpu-weight", titleKey: "performance.sessionCpuWeight", descriptionKey: "performance.sessionCpuWeightHint", targetSectionId: "performance-session-policy" },
    { id: "wsl-quota", titleKey: "performance.wslQuotaGroup", descriptionKey: "performance.wslQuotaEnabledHint", targetSectionId: "performance-wsl-quota" },
    { id: "parking", titleKey: "performance.parkingGroup", descriptionKey: "performance.parkedTerminalLimitHint", targetSectionId: "performance-parking" },
  ] },
  { id: "web-access", icon: Wifi, titleKey: "webAccessTitle", descriptionKey: "webAccessDescription", page: "devices", searchEntries: [
    { id: "remote", titleKey: "webAccessTitle", keywordsKey: "searchKeywords.webAccess", targetSectionId: "web-access-root" },
    { id: "device", titleKey: "deviceAccess.local.title", descriptionKey: "deviceAccess.local.version", keywordsKey: "searchKeywords.deviceInfo", targetSectionId: "web-access-device" },
    { id: "server", titleKey: "webAccessSection.startupEnabled", descriptionKey: "webAccessSection.autoOpenHint", targetSectionId: "web-access-server" },
    { id: "auth", titleKey: "webAccessSection.authEnabled", descriptionKey: "webAccessSection.authEnabledHint", targetSectionId: "web-access-auth" },
    { id: "network", titleKey: "webAccessSection.allowLan", descriptionKey: "webAccessSection.ipWhitelistHint", targetSectionId: "web-access-network" },
    { id: "tailscale", titleKey: "webAccessSection.tailscale.title", descriptionKey: "webAccessSection.tailscale.description", keywordsKey: "searchKeywords.tailscale", targetSectionId: "web-access-tailscale" },
    { id: "clients", titleKey: "deviceAccess.clientsTitle", descriptionKey: "deviceAccess.clientsDescription", keywordsKey: "searchKeywords.deviceClients", targetSectionId: "web-access-clients" },
    { id: "mcp", titleKey: "deviceAccess.mcpTitle", descriptionKey: "sharedMcp.selfHint", keywordsKey: "searchKeywords.deviceMcp", targetSectionId: "web-access-mcp" },
    { id: "orchestrator", titleKey: "webAccessSection.orchestrator.title", descriptionKey: "webAccessSection.orchestrator.description", keywordsKey: "searchKeywords.orchestrator", targetSectionId: "web-access-orchestrator" },
    { id: "service", titleKey: "webAccessGroups.service", descriptionKey: "webAccessSection.restartHint", keywordsKey: "searchKeywords.webService", targetSectionId: "web-access-service" },
  ] },
  { id: "browser", icon: Compass, titleKey: "browserImport.title", descriptionKey: "browserImport.description", page: "system", availability: "tauri", searchEntries: [
    { id: "import", titleKey: "browserImport.importTitle", descriptionKey: "browserImport.importHint", keywordsKey: "browserImport.keywords", targetSectionId: "browser-import-sources" },
  ] },
  {
    id: "quick-commands",
    icon: LibraryBig,
    titleKey: "quickCommands.title",
    descriptionKey: "quickCommands.description",
    page: "ai-tools",
    layout: "wide",
    searchEntries: [{
      id: "library",
      titleKey: "quickCommands.title",
      descriptionKey: "quickCommands.description",
      keywordsKey: "searchKeywords.quickCommands",
      targetSectionId: "quick-commands-root",
    }],
  },
  { id: "notification", icon: Bell, titleKey: "notification", descriptionKey: "notificationDescription", page: "system", searchEntries: [
    { id: "events", titleKey: "notificationTitle", keywordsKey: "searchKeywords.notification", targetSectionId: "notification-controls" },
  ] },
  { id: "im-bridge", icon: MessageSquare, titleKey: "imBridge", descriptionKey: "imBridgeDescription", page: "system", availability: "tauri", searchEntries: [
    { id: "channels", titleKey: "imBridgeTitle", descriptionKey: "imBridgeDescription", keywordsKey: "searchKeywords.imBridge", targetSectionId: "im-bridge-root" },
  ] },
  {
    id: "screenshot",
    icon: Camera,
    titleKey: "screenshot",
    descriptionKey: "screenshotDesc",
    page: "system",
    searchEntries: [
      { id: "capture", titleKey: "screenshotTitle", descriptionKey: "screenshotDesc", keywordsKey: "searchKeywords.screenshot", targetSectionId: "screenshot-root" },
    ],
    availability: "non-mac",
  },
  { id: "voice", icon: Mic, titleKey: "voice", descriptionKey: "voiceDesc", page: "system", searchEntries: [
    { id: "input", titleKey: "voiceTitle", descriptionKey: "voiceDesc", keywordsKey: "searchKeywords.voice", targetSectionId: "voice-root" },
    { id: "provider", titleKey: "voiceTranscribeWith", descriptionKey: "voiceTranscribeWithDesc", targetSectionId: "voice-transcription" },
    { id: "microphone", titleKey: "voiceMicrophone", descriptionKey: "voiceMicrophoneDesc", targetSectionId: "voice-input" },
    { id: "dictionary", titleKey: "voiceDictionary", descriptionKey: "voiceDictionaryDesc", targetSectionId: "voice-dictionary" },
    { id: "options", titleKey: "voiceShowFloatingButton", descriptionKey: "voiceMaxRecordSecondsDesc", targetSectionId: "voice-advanced" },
  ] },
  { id: "ccchan", icon: Bot, titleKey: "ccchanTitle", descriptionKey: "ccchanDescription", page: "ccchan", searchEntries: [
    { id: "companion", titleKey: "ccchanTitle", keywordsKey: "searchKeywords.ccchan", targetSectionId: "ccchan-root" },
  ] },
  {
    id: "privacy",
    icon: Shield,
    titleKey: "privacy.title",
    descriptionKey: "privacy.description",
    page: "privacy",
    availability: "tauri",
    searchEntries: [{
      id: "channel-purity",
      titleKey: "privacy.channelPurity",
      descriptionKey: "privacy.channelPurityDesc",
      keywordsKey: "searchKeywords.privacy",
      targetSectionId: "privacy-root",
    }],
  },
  {
    id: "experimental",
    icon: FlaskConical,
    titleKey: "experimental.title",
    descriptionKey: "experimental.description",
    page: "experimental",
    searchEntries: [{
      id: "features",
      titleKey: "experimental.title",
      descriptionKey: "experimental.description",
      keywordsKey: "searchKeywords.experimental",
      targetSectionId: "experimental-root",
    }],
  },
  { id: "about", icon: Info, titleKey: "about", page: "about", searchEntries: [
    { id: "application", titleKey: "aboutTitle", keywordsKey: "searchKeywords.about", targetSectionId: "about-root" },
  ] },
];

export function isSettingsPaneAvailable(
  pane: SettingsPaneDefinition,
  environment: SettingsEnvironment,
): boolean {
  if (pane.availability === "tauri") return environment.isTauri;
  if (pane.availability === "non-mac") return !environment.isMac;
  return true;
}

export function getVisibleSettingsPanes(
  environment: SettingsEnvironment,
): SettingsPaneDefinition[] {
  return SETTINGS_PANES.filter((pane) => isSettingsPaneAvailable(pane, environment));
}

export function getVisibleSettingsPages(
  panes: readonly SettingsPaneDefinition[],
): SettingsPageDefinition[] {
  const visiblePaneIds = new Set(panes.map((pane) => pane.id));
  return SETTINGS_PAGES.filter((page) =>
    page.paneIds.some((paneId) => visiblePaneIds.has(paneId))
  );
}

export function getSettingsPage(id: SettingsPageId): SettingsPageDefinition {
  const page = SETTINGS_PAGES.find((candidate) => candidate.id === id);
  if (!page) throw new Error(`Unknown settings page: ${id}`);
  return page;
}

export function getSettingsPageForPane(paneId: SettingsPaneId): SettingsPageDefinition {
  const page = SETTINGS_PAGES.find((candidate) => candidate.paneIds.includes(paneId));
  if (!page) throw new Error(`No settings page contains pane: ${paneId}`);
  return page;
}

export function getSettingsPanesForPage(
  pageId: SettingsPageId,
  panes: readonly SettingsPaneDefinition[] = SETTINGS_PANES,
): SettingsPaneDefinition[] {
  const page = getSettingsPage(pageId);
  return page.paneIds
    .map((paneId) => panes.find((pane) => pane.id === paneId))
    .filter((pane): pane is SettingsPaneDefinition => pane !== undefined);
}

export function getSettingsPane(id: SettingsPaneId): SettingsPaneDefinition {
  const pane = SETTINGS_PANES.find((candidate) => candidate.id === id);
  if (!pane) throw new Error(`Unknown settings pane: ${id}`);
  return pane;
}
