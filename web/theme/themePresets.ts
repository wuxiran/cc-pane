export type ThemeId =
  | "deep-ink"
  | "cyber-purple"
  | "amber-gold"
  | "classic-white"
  | "warm-gray"
  | "sky-blue"
  | "nord-frost"
  | "tokyo-night"
  | "rice-paper"
  | "mint-mist";

export type ThemePreference = ThemeId | "system" | "dark" | "light";
export type ThemeGroup = "dark" | "light";

export interface ThemePreset {
  id: ThemeId;
  group: ThemeGroup;
  labelKey: string;
  swatches: readonly [string, string, string];
}

export const DEFAULT_DARK_THEME: ThemeId = "deep-ink";
export const DEFAULT_LIGHT_THEME: ThemeId = "classic-white";

export const THEME_PRESETS: readonly ThemePreset[] = [
  {
    id: "deep-ink",
    group: "dark",
    labelKey: "theme.presets.deepInk",
    swatches: ["#17191e", "#26282d", "#4c8df5"],
  },
  {
    id: "cyber-purple",
    group: "dark",
    labelKey: "theme.presets.cyberPurple",
    swatches: ["#17161d", "#292630", "#9b7cf6"],
  },
  {
    id: "amber-gold",
    group: "dark",
    labelKey: "theme.presets.amberGold",
    swatches: ["#191714", "#2b2822", "#e9a916"],
  },
  {
    id: "classic-white",
    group: "light",
    labelKey: "theme.presets.classicWhite",
    swatches: ["#ffffff", "#eef0f3", "#2563eb"],
  },
  {
    id: "warm-gray",
    group: "light",
    labelKey: "theme.presets.warmGray",
    swatches: ["#fffefd", "#efedea", "#c95f18"],
  },
  {
    id: "sky-blue",
    group: "light",
    labelKey: "theme.presets.skyBlue",
    swatches: ["#fbfdff", "#eaf2fb", "#2878d0"],
  },
  {
    id: "nord-frost",
    group: "dark",
    labelKey: "theme.presets.nordFrost",
    swatches: ["#242933", "#2A313D", "#88C0D0"],
  },
  {
    id: "tokyo-night",
    group: "dark",
    labelKey: "theme.presets.tokyoNight",
    swatches: ["#1A1B26", "#212336", "#7AA2F7"],
  },
  {
    id: "rice-paper",
    group: "light",
    labelKey: "theme.presets.ricePaper",
    swatches: ["#FAF8F2", "#EFEADF", "#4C69A8"],
  },
  {
    id: "mint-mist",
    group: "light",
    labelKey: "theme.presets.mintMist",
    swatches: ["#F6FAF8", "#E7F0EB", "#178A5E"],
  },
] as const;

const THEME_IDS = new Set<ThemeId>(THEME_PRESETS.map((preset) => preset.id));

export function isThemeId(value: string | null | undefined): value is ThemeId {
  return Boolean(value && THEME_IDS.has(value as ThemeId));
}

export function canonicalThemePreference(
  value: string | null | undefined,
): ThemeId | "system" {
  if (value === "system") return value;
  if (value === "light") return DEFAULT_LIGHT_THEME;
  if (value === "dark") return DEFAULT_DARK_THEME;
  return isThemeId(value) ? value : DEFAULT_DARK_THEME;
}

export function themeGroup(themeId: ThemeId): ThemeGroup {
  return THEME_PRESETS.find((preset) => preset.id === themeId)?.group ?? "dark";
}

export function themePreset(themeId: ThemeId): ThemePreset {
  return THEME_PRESETS.find((preset) => preset.id === themeId) ?? THEME_PRESETS[0];
}
