import type { LucideIcon } from "lucide-react";
import {
  Bell,
  Bot,
  Cable,
  Camera,
  Cloud,
  Globe,
  Image,
  Info,
  Keyboard,
  Mic,
  Settings,
  Share2,
  Terminal,
  Wifi,
} from "lucide-react";

export type SettingsGroupId =
  | "appearance"
  | "ai"
  | "system"
  | "companion"
  | "about";

export type SettingsPaneId =
  | "general"
  | "wallpaper"
  | "terminal"
  | "shortcuts"
  | "provider"
  | "cli-launchers"
  | "shared-mcp"
  | "proxy"
  | "web-access"
  | "notification"
  | "screenshot"
  | "voice"
  | "ccchan"
  | "about";

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
  titleKey: string;
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
  titleKey: string;
}> = [
  { id: "appearance", titleKey: "groups.appearance" },
  { id: "ai", titleKey: "groups.ai" },
  { id: "system", titleKey: "groups.system" },
  { id: "companion", titleKey: "groups.companion" },
  { id: "about", titleKey: "groups.about" },
];

export const SETTINGS_PANES: readonly SettingsPaneDefinition[] = [
  { id: "general", icon: Settings, titleKey: "general", group: "appearance", searchEntries: [] },
  {
    id: "wallpaper",
    icon: Image,
    titleKey: "wallpaper",
    group: "appearance",
    searchEntries: [],
    availability: "tauri",
  },
  { id: "terminal", icon: Terminal, titleKey: "terminal", group: "appearance", searchEntries: [] },
  { id: "shortcuts", icon: Keyboard, titleKey: "shortcuts", group: "appearance", searchEntries: [] },
  {
    id: "provider",
    icon: Cloud,
    titleKey: "provider",
    group: "ai",
    searchEntries: [],
    layout: "wide",
  },
  { id: "cli-launchers", icon: Cable, titleKey: "cliLaunchers", group: "ai", searchEntries: [] },
  { id: "shared-mcp", icon: Share2, titleKey: "sharedMcp.title", group: "ai", searchEntries: [] },
  { id: "proxy", icon: Globe, titleKey: "proxy", group: "system", searchEntries: [] },
  { id: "web-access", icon: Wifi, titleKey: "webAccessTitle", group: "system", searchEntries: [] },
  { id: "notification", icon: Bell, titleKey: "notification", group: "system", searchEntries: [] },
  {
    id: "screenshot",
    icon: Camera,
    titleKey: "screenshot",
    group: "system",
    searchEntries: [],
    availability: "non-mac",
  },
  { id: "voice", icon: Mic, titleKey: "voice", group: "system", searchEntries: [] },
  { id: "ccchan", icon: Bot, titleKey: "ccchanTitle", group: "companion", searchEntries: [] },
  { id: "about", icon: Info, titleKey: "about", group: "about", searchEntries: [] },
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
