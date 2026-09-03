import type { ParseKeys } from "i18next";
import type { LucideIcon } from "lucide-react";
import {
  BarChart3,
  Bell,
  Bot,
  Cable,
  CalendarClock,
  Camera,
  Cloud,
  FlaskConical,
  Globe,
  Image,
  Info,
  Keyboard,
  LibraryBig,
  ListChecks,
  MessageSquare,
  Mic,
  Package,
  Palette,
  PanelsTopLeft,
  Settings,
  Share2,
  Terminal,
  Wifi,
} from "lucide-react";

export type SettingsGroupId =
  | "application"
  | "services";

export type SettingsPageId =
  | "general"
  | "terminal"
  | "ai-tools"
  | "system"
  | "ccchan"
  | "setup-guide"
  | "experimental"
  | "usage-stats"
  | "about";

export type SettingsPaneId =
  | "setup-guide"
  | "automations"
  | "theme"
  | "theme-shape"
  | "general"
  | "usage-stats"
  | "wallpaper"
  | "terminal"
  | "shortcuts"
  | "quick-commands"
  | "modules"
  | "provider"
  | "provider-credentials"
  | "cli-launchers"
  | "shared-mcp"
  | "skills"
  | "proxy"
  | "web-access"
  | "notification"
  | "im-bridge"
  | "screenshot"
  | "voice"
  | "ccchan"
  | "experimental"
  | "about";

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
    paneIds: ["general", "theme", "theme-shape", "wallpaper", "modules"],
  },
  {
    id: "terminal",
    icon: Terminal,
    titleKey: "pages.terminal.title",
    group: "application",
    paneIds: ["terminal", "shortcuts"],
  },
  {
    id: "ai-tools",
    icon: Bot,
    titleKey: "pages.aiTools.title",
    group: "application",
    paneIds: ["provider", "provider-credentials", "cli-launchers", "shared-mcp", "skills", "quick-commands", "automations"],
  },
  {
    id: "system",
    icon: Globe,
    titleKey: "pages.system.title",
    group: "services",
    paneIds: ["proxy", "web-access", "notification", "im-bridge", "screenshot", "voice"],
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
    page: "general",
    searchEntries: [
      { id: "color", titleKey: "theme.colorTitle", descriptionKey: "theme.colorDescription", keywordsKey: "searchKeywords.theme", targetSectionId: "theme-color" },
    ],
  },
  {
    id: "theme-shape",
    icon: Palette,
    titleKey: "theme.shapeTabTitle",
    page: "general",
    searchEntries: [
      { id: "shape", titleKey: "theme.shapeTitle", descriptionKey: "theme.shapeDescription", keywordsKey: "searchKeywords.themeShape", targetSectionId: "theme-shape" },
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
    page: "general",
    searchEntries: [
      { id: "media", titleKey: "wallpaperImage", descriptionKey: "wallpaperImageHint", keywordsKey: "searchKeywords.wallpaper", targetSectionId: "wallpaper-root" },
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
      { id: "context-usage", titleKey: "showContextUsage", descriptionKey: "showContextUsageHint", targetSectionId: "terminal-context-usage" },
      { id: "status-bar", titleKey: "showStatusBar", descriptionKey: "showStatusBarHint", targetSectionId: "terminal-status-bar" },
      { id: "task-queue", titleKey: "taskQueueEnabled", descriptionKey: "taskQueueEnabledHint", targetSectionId: "terminal-task-queue" },
      { id: "session-priority", titleKey: "lowerSessionPriority", descriptionKey: "lowerSessionPriorityHint", targetSectionId: "terminal-root" },
      { id: "daemon", titleKey: "terminalDaemon", descriptionKey: "terminalDaemonHint", targetSectionId: "terminal-root" },
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
  {
    id: "provider",
    icon: Cloud,
    titleKey: "launchProfilesTab",
    page: "ai-tools",
    searchEntries: [
      { id: "launch-profiles", titleKey: "launchProfilesTab", keywordsKey: "searchKeywords.provider", targetSectionId: "provider-root" },
    ],
    layout: "wide",
  },
  {
    id: "provider-credentials",
    icon: Cloud,
    titleKey: "providerCredentialsTab",
    page: "ai-tools",
    searchEntries: [
      { id: "provider-credentials", titleKey: "providerCredentialsTab", keywordsKey: "searchKeywords.provider", targetSectionId: "provider-credentials-root" },
    ],
    layout: "wide",
  },
  { id: "cli-launchers", icon: Cable, titleKey: "cliLaunchers", descriptionKey: "cliLaunchersDesc", page: "ai-tools", searchEntries: [
    { id: "commands", titleKey: "cliLaunchersTitle", descriptionKey: "cliLaunchersDesc", targetSectionId: "cli-launchers-root" },
  ] },
  { id: "shared-mcp", icon: Share2, titleKey: "sharedMcp.title", descriptionKey: "sharedMcp.importHint", page: "ai-tools", searchEntries: [
    { id: "servers", titleKey: "sharedMcp.title", keywordsKey: "searchKeywords.mcp", targetSectionId: "shared-mcp-root" },
  ] },
  { id: "skills", icon: Package, titleKey: "skills", page: "ai-tools", searchEntries: [
    { id: "library", titleKey: "skills", keywordsKey: "searchKeywords.skills", targetSectionId: "skills-root" },
  ], layout: "wide" },
  { id: "proxy", icon: Globe, titleKey: "proxy", page: "system", searchEntries: [
    { id: "connection", titleKey: "proxyTitle", keywordsKey: "searchKeywords.proxy", targetSectionId: "proxy-root" },
  ] },
  { id: "web-access", icon: Wifi, titleKey: "webAccessTitle", descriptionKey: "webAccessDescription", page: "system", searchEntries: [
    { id: "remote", titleKey: "webAccessTitle", keywordsKey: "searchKeywords.webAccess", targetSectionId: "web-access-root" },
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
  {
    id: "automations",
    icon: CalendarClock,
    titleKey: "automations.title",
    descriptionKey: "automations.description",
    page: "ai-tools",
    availability: "tauri",
    searchEntries: [{
      id: "schedules",
      titleKey: "automations.title",
      descriptionKey: "automations.description",
      keywordsKey: "searchKeywords.automations",
      targetSectionId: "automations-root",
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
  ] },
  { id: "ccchan", icon: Bot, titleKey: "ccchanTitle", descriptionKey: "ccchanDescription", page: "ccchan", searchEntries: [
    { id: "companion", titleKey: "ccchanTitle", keywordsKey: "searchKeywords.ccchan", targetSectionId: "ccchan-root" },
  ] },
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
