import { create } from "zustand";
import {
  canonicalThemePreference,
  DEFAULT_DARK_THEME,
  DEFAULT_LIGHT_THEME,
  themeGroup,
  type ThemeId,
  type ThemePreference,
} from "@/theme/themePresets";

export type Theme = "light" | "dark";

const STORAGE_KEY = "theme";

interface ThemeState {
  isDark: boolean;
  themeId: ThemeId;
  preference: ThemeId | "system";
  setThemeMode: (theme: string | null | undefined) => void;
  toggleTheme: () => void;
}

function getSystemTheme(): Theme {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return "dark";
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function resolveThemeMode(theme: ThemePreference | null | undefined): Theme {
  const preference = canonicalThemePreference(theme);
  if (preference === "system") return getSystemTheme();
  return themeGroup(preference);
}

export function resolveThemeId(theme: string | null | undefined): ThemeId {
  const preference = canonicalThemePreference(theme);
  if (preference !== "system") return preference;
  return getSystemTheme() === "dark" ? DEFAULT_DARK_THEME : DEFAULT_LIGHT_THEME;
}

function applyTheme(preference: string | null | undefined): ThemeId {
  const canonical = canonicalThemePreference(preference);
  const themeId = resolveThemeId(canonical);
  if (typeof document === "undefined") return themeId;
  document.documentElement.classList.toggle("dark", themeGroup(themeId) === "dark");
  document.documentElement.dataset.theme = themeId;
  try {
    const storedPreference = preference === "dark" || preference === "light"
      ? preference
      : canonical;
    localStorage.setItem(STORAGE_KEY, storedPreference);
  } catch {
    // Ignore storage failures in restricted environments.
  }
  return themeId;
}

// 初始化主题
const stored = typeof localStorage === "undefined"
  ? null
  : localStorage.getItem(STORAGE_KEY);
const initialPreference = canonicalThemePreference(stored);
const initialThemeId = applyTheme(initialPreference);

export const useThemeStore = create<ThemeState>((set, get) => ({
  isDark: themeGroup(initialThemeId) === "dark",
  themeId: initialThemeId,
  preference: initialPreference,

  setThemeMode: (theme) => {
    const preference = canonicalThemePreference(theme);
    const themeId = applyTheme(preference);
    set({
      isDark: themeGroup(themeId) === "dark",
      themeId,
      preference,
    });
  },

  toggleTheme: () => {
    const preference: ThemePreference = get().isDark ? "light" : "dark";
    const canonical = canonicalThemePreference(preference);
    const themeId = applyTheme(preference);
    set({
      isDark: themeGroup(themeId) === "dark",
      themeId,
      preference: canonical,
    });
  },
}));
