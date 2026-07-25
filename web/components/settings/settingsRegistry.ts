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
  PanelsTopLeft,
  Settings,
  Share2,
  Terminal,
  Wifi,
} from "lucide-react";

export type SettingsGroupId =
  | "guide"
  | "appearance"
  | "ai"
  | "system"
  | "companion"
  | "experimental"
  | "about";

export type SettingsPaneId =
  | "setup-guide"
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
  group: SettingsGroupId;
  searchEntries: readonly SettingsSearchEntry[];
  availability?: "tauri" | "non-mac";
  layout?: "default" | "wide";
}

export interface SettingsEnvironment {
  isMac: boolean;
  isTauri: boolean;
}

export const SETTINGS_GROUPS: ReadonlyArray<{
  id: SettingsGroupId;
  titleKey: SettingsTranslationKey;
}> = [
  { id: "guide", titleKey: "groups.guide" },
  { id: "appearance", titleKey: "groups.appearance" },
  { id: "ai", titleKey: "groups.ai" },
  { id: "system", titleKey: "groups.system" },
  { id: "companion", titleKey: "groups.companion" },
  { id: "experimental", titleKey: "groups.experimental" },
  { id: "about", titleKey: "groups.about" },
];

export const SETTINGS_PANES: readonly SettingsPaneDefinition[] = [
  {
    id: "setup-guide",
    icon: ListChecks,
    titleKey: "setupGuide.title",
    descriptionKey: "setupGuide.description",
    group: "guide",
    searchEntries: [{
      id: "workflow-checklist",
      titleKey: "setupGuide.title",
      descriptionKey: "setupGuide.description",
      keywordsKey: "searchKeywords.setupGuide",
      targetSectionId: "setup-guide-root",
    }],
  },
  {
    id: "general",
    icon: Settings,
    titleKey: "general",
    group: "appearance",
    searchEntries: [
      { id: "startup", titleKey: "autoStart", keywordsKey: "searchKeywords.general", targetSectionId: "general-root" },
      { id: "history", titleKey: "localHistoryEnabled", descriptionKey: "localHistoryEnabledDesc", targetSectionId: "general-root" },
      { id: "system-resources", titleKey: "showSystemResources", targetSectionId: "general-root" },
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
    group: "appearance",
    searchEntries: [
      { id: "media", titleKey: "wallpaperImage", descriptionKey: "wallpaperImageHint", keywordsKey: "searchKeywords.wallpaper", targetSectionId: "wallpaper-root" },
    ],
    availability: "tauri",
  },
  {
    id: "terminal",
    icon: Terminal,
    titleKey: "terminal",
    group: "appearance",
    searchEntries: [
      { id: "font", titleKey: "fontSize", descriptionKey: "fontFamilyCjkHint", keywordsKey: "searchKeywords.font", targetSectionId: "terminal-font" },
      { id: "theme", titleKey: "terminalTheme", targetSectionId: "terminal-root" },
      { id: "renderer", titleKey: "rendererMode", descriptionKey: "rendererHint", targetSectionId: "terminal-root" },
      { id: "daemon", titleKey: "terminalDaemon", descriptionKey: "terminalDaemonHint", targetSectionId: "terminal-root" },
    ],
  },
  {
    id: "shortcuts",
    icon: Keyboard,
    titleKey: "shortcuts",
    descriptionKey: "shortcutsHint",
    group: "appearance",
    searchEntries: [
      { id: "bindings", titleKey: "shortcutsTitle", descriptionKey: "shortcutsHint", keywordsKey: "searchKeywords.shortcuts", targetSectionId: "shortcuts-list" },
    ],
  },
  {
    id: "modules",
    icon: PanelsTopLeft,
    titleKey: "modules.title",
    descriptionKey: "modules.description",
    group: "appearance",
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
    group: "ai",
    searchEntries: [
      { id: "providers", titleKey: "providerTitle", descriptionKey: "providerDesc", keywordsKey: "searchKeywords.provider", targetSectionId: "provider-root" },
    ],
    layout: "wide",
  },
  { id: "cli-launchers", icon: Cable, titleKey: "cliLaunchers", descriptionKey: "cliLaunchersDesc", group: "ai", searchEntries: [
    { id: "commands", titleKey: "cliLaunchersTitle", descriptionKey: "cliLaunchersDesc", targetSectionId: "cli-launchers-root" },
  ] },
  { id: "shared-mcp", icon: Share2, titleKey: "sharedMcp.title", descriptionKey: "sharedMcp.importHint", group: "ai", searchEntries: [
    { id: "servers", titleKey: "sharedMcp.title", keywordsKey: "searchKeywords.mcp", targetSectionId: "shared-mcp-root" },
  ] },
  { id: "proxy", icon: Globe, titleKey: "proxy", group: "system", searchEntries: [
    { id: "connection", titleKey: "proxyTitle", keywordsKey: "searchKeywords.proxy", targetSectionId: "proxy-root" },
  ] },
  { id: "web-access", icon: Wifi, titleKey: "webAccessTitle", descriptionKey: "webAccessDescription", group: "system", searchEntries: [
    { id: "remote", titleKey: "webAccessTitle", keywordsKey: "searchKeywords.webAccess", targetSectionId: "web-access-root" },
  ] },
  {
    id: "quick-commands",
    icon: LibraryBig,
    titleKey: "quickCommands.title",
    descriptionKey: "quickCommands.description",
    group: "system",
    layout: "wide",
    searchEntries: [{
      id: "library",
      titleKey: "quickCommands.title",
      descriptionKey: "quickCommands.description",
      keywordsKey: "searchKeywords.quickCommands",
      targetSectionId: "quick-commands-root",
    }],
  },
  { id: "notification", icon: Bell, titleKey: "notification", descriptionKey: "notificationDescription", group: "system", searchEntries: [
    { id: "events", titleKey: "notificationTitle", keywordsKey: "searchKeywords.notification", targetSectionId: "notification-controls" },
  ] },
  {
    id: "screenshot",
    icon: Camera,
    titleKey: "screenshot",
    descriptionKey: "screenshotDesc",
    group: "system",
    searchEntries: [
      { id: "capture", titleKey: "screenshotTitle", descriptionKey: "screenshotDesc", keywordsKey: "searchKeywords.screenshot", targetSectionId: "screenshot-root" },
    ],
    availability: "non-mac",
  },
  { id: "voice", icon: Mic, titleKey: "voice", descriptionKey: "voiceDesc", group: "system", searchEntries: [
    { id: "input", titleKey: "voiceTitle", descriptionKey: "voiceDesc", keywordsKey: "searchKeywords.voice", targetSectionId: "voice-root" },
  ] },
  { id: "ccchan", icon: Bot, titleKey: "ccchanTitle", descriptionKey: "ccchanDescription", group: "companion", searchEntries: [
    { id: "companion", titleKey: "ccchanTitle", keywordsKey: "searchKeywords.ccchan", targetSectionId: "ccchan-root" },
  ] },
  {
    id: "experimental",
    icon: FlaskConical,
    titleKey: "experimental.title",
    descriptionKey: "experimental.description",
    group: "experimental",
    searchEntries: [{
      id: "features",
      titleKey: "experimental.title",
      descriptionKey: "experimental.description",
      keywordsKey: "searchKeywords.experimental",
      targetSectionId: "experimental-root",
    }],
  },
  { id: "about", icon: Info, titleKey: "about", group: "about", searchEntries: [
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

export function getSettingsPane(id: SettingsPaneId): SettingsPaneDefinition {
  const pane = SETTINGS_PANES.find((candidate) => candidate.id === id);
  if (!pane) throw new Error(`Unknown settings pane: ${id}`);
  return pane;
}
