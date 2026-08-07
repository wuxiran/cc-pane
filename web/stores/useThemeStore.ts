import { create } from "zustand";
import {
  canonicalThemePreference,
  DEFAULT_DARK_THEME,
  DEFAULT_LIGHT_THEME,
  themeGroup,
  type ThemeId,
  type ThemePreference,
} from "@/theme/themePresets";
import {
  canonicalThemeShape,
  DEFAULT_THEME_SHAPE,
  type ThemeShape,
} from "@/theme/themeShapes";

export type Theme = "light" | "dark";

const STORAGE_KEY = "theme";
export const THEME_SHAPE_STORAGE_KEY = "theme-shape";

interface ThemeState {
  isDark: boolean;
  themeId: ThemeId;
  preference: ThemeId | "system";
  shape: ThemeShape;
  setThemeMode: (theme: string | null | undefined) => void;
  setThemeShape: (shape: string | null | undefined) => void;
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
    window.localStorage.setItem(STORAGE_KEY, storedPreference);
  } catch {
    // Ignore storage failures in restricted environments.
  }
  return themeId;
}

function applyThemeShape(
  value: string | null | undefined,
  persist: boolean,
): ThemeShape {
  const shape = canonicalThemeShape(value);
  if (typeof document !== "undefined") {
    document.documentElement.dataset.shape = shape;
  }
  if (persist) {
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(THEME_SHAPE_STORAGE_KEY, shape);
      }
    } catch {
      // Restricted webviews may not expose writable storage.
    }
  }
  return shape;
}

export function restoreThemeShapeFromStorage(): ThemeShape {
  let stored: string | null = null;
  try {
    if (typeof localStorage !== "undefined") {
      stored = localStorage.getItem(THEME_SHAPE_STORAGE_KEY);
    }
  } catch {
    // Fall through to the compatibility default.
  }
  return applyThemeShape(stored, true);
}

export function isolateSpecialWindowShape(): void {
  applyThemeShape(DEFAULT_THEME_SHAPE, false);
}

// 初始化主题
const stored = typeof window === "undefined"
  ? null
  : window.localStorage.getItem(STORAGE_KEY);
const initialPreference = canonicalThemePreference(stored);
const initialThemeId = applyTheme(initialPreference);
const initialShape = restoreThemeShapeFromStorage();

export const useThemeStore = create<ThemeState>((set, get) => ({
  isDark: themeGroup(initialThemeId) === "dark",
  themeId: initialThemeId,
  preference: initialPreference,
  shape: initialShape,

  setThemeMode: (theme) => {
    const preference = canonicalThemePreference(theme);
    const themeId = applyTheme(preference);
    set({
      isDark: themeGroup(themeId) === "dark",
      themeId,
      preference,
    });
  },

  setThemeShape: (value) => {
    const shape = applyThemeShape(value, true);
    set({ shape });
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
