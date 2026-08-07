import type { ParseKeys } from "i18next";
import type { LucideIcon } from "lucide-react";
import {
  Bell,
  Bot,
  Cable,
  Camera,
  Cloud,
  FlaskConical,
  Globe,
  Image,
  Info,
  Keyboard,
  LibraryBig,
  ListChecks,
  Mic,
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
  | "advanced"
  | "about";

export type SettingsPaneId =
  | "setup-guide"
  | "theme"
  | "general"
  | "wallpaper"
  | "terminal"
  | "shortcuts"
  | "quick-commands"
  | "modules"
  | "provider"
  | "cli-launchers"
  | "shared-mcp"
  | "proxy"
  | "web-access"
  | "notification"
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
    paneIds: ["general", "theme", "wallpaper", "modules"],
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
    group: "services",
    paneIds: ["provider", "cli-launchers", "shared-mcp", "quick-commands", "ccchan"],
  },
  {
    id: "system",
    icon: Globe,
    titleKey: "pages.system.title",
    group: "services",
    paneIds: ["proxy", "web-access", "notification", "screenshot", "voice"],
  },
  {
    id: "advanced",
    icon: FlaskConical,
    titleKey: "pages.advanced.title",
    group: "services",
    paneIds: ["setup-guide", "experimental"],
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
    page: "advanced",
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
    titleKey: "theme.styleTitle",
    descriptionKey: "theme.styleDescription",
    page: "general",
    searchEntries: [
      { id: "color", titleKey: "theme.colorTitle", descriptionKey: "theme.colorDescription", keywordsKey: "searchKeywords.theme", targetSectionId: "theme-color" },
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
    titleKey: "provider",
    descriptionKey: "providerDesc",
    page: "ai-tools",
    searchEntries: [
      { id: "providers", titleKey: "providerTitle", descriptionKey: "providerDesc", keywordsKey: "searchKeywords.provider", targetSectionId: "provider-root" },
    ],
    layout: "wide",
  },
  { id: "cli-launchers", icon: Cable, titleKey: "cliLaunchers", descriptionKey: "cliLaunchersDesc", page: "ai-tools", searchEntries: [
    { id: "commands", titleKey: "cliLaunchersTitle", descriptionKey: "cliLaunchersDesc", targetSectionId: "cli-launchers-root" },
  ] },
  { id: "shared-mcp", icon: Share2, titleKey: "sharedMcp.title", descriptionKey: "sharedMcp.importHint", page: "ai-tools", searchEntries: [
    { id: "servers", titleKey: "sharedMcp.title", keywordsKey: "searchKeywords.mcp", targetSectionId: "shared-mcp-root" },
  ] },
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
  { id: "notification", icon: Bell, titleKey: "notification", descriptionKey: "notificationDescription", page: "system", searchEntries: [
    { id: "events", titleKey: "notificationTitle", keywordsKey: "searchKeywords.notification", targetSectionId: "notification-controls" },
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
  { id: "ccchan", icon: Bot, titleKey: "ccchanTitle", descriptionKey: "ccchanDescription", page: "ai-tools", searchEntries: [
    { id: "companion", titleKey: "ccchanTitle", keywordsKey: "searchKeywords.ccchan", targetSectionId: "ccchan-root" },
  ] },
  {
    id: "experimental",
    icon: FlaskConical,
    titleKey: "experimental.title",
    descriptionKey: "experimental.description",
    page: "advanced",
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
