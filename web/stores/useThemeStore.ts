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
  buildOverrideDeclarations,
  canonicalThemeOverrides,
  hasAnyOverride,
  OVERRIDE_TOKEN_TARGETS,
  THEME_OVERRIDES_STORAGE_KEY,
  type ThemeOverrides,
} from "@/theme/themeOverrides";
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
  /** 当前主题上的自定义微调（accent / 圆角 / 面板明度）；null = 纯预设。 */
  customOverrides: ThemeOverrides | null;
  setThemeMode: (theme: string | null | undefined) => void;
  setThemeShape: (shape: string | null | undefined) => void;
  /** 合并写入微调（baseThemeId 恒取当前 themeId）；字段传 undefined 即清除该项。 */
  setThemeOverrides: (patch: Partial<Omit<ThemeOverrides, "baseThemeId">>) => void;
  /** 一键恢复预设默认：清空微调并移除 documentElement 上的覆盖 token。 */
  resetThemeOverrides: () => void;
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

/**
 * 把微调覆盖 token 写到 documentElement inline style。inline 优先级高于
 * 样式表里的 .dark 与 :root[data-theme] 块，暗色主题的同名 token 因而同样
 * 被覆盖；overrides 依附的 baseThemeId 与当前主题不一致时只清除不套用
 * （数据保留，切回原主题即恢复）。
 */
function applyThemeOverrides(
  overrides: ThemeOverrides | null,
  themeId: ThemeId,
): void {
  if (typeof document === "undefined") return;
  const rootStyle = document.documentElement.style;
  for (const token of OVERRIDE_TOKEN_TARGETS) {
    rootStyle.removeProperty(token);
  }
  if (!overrides || overrides.baseThemeId !== themeId) return;
  const declarations = buildOverrideDeclarations(overrides);
  for (const [token, value] of Object.entries(declarations)) {
    rootStyle.setProperty(token, value);
  }
}

function persistThemeOverrides(overrides: ThemeOverrides | null): void {
  try {
    if (typeof localStorage === "undefined") return;
    if (overrides) {
      localStorage.setItem(THEME_OVERRIDES_STORAGE_KEY, JSON.stringify(overrides));
    } else {
      localStorage.removeItem(THEME_OVERRIDES_STORAGE_KEY);
    }
  } catch {
    // Restricted webviews may not expose writable storage.
  }
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

export function restoreThemeOverridesFromStorage(): ThemeOverrides | null {
  let stored: string | null = null;
  try {
    if (typeof localStorage !== "undefined") {
      stored = localStorage.getItem(THEME_OVERRIDES_STORAGE_KEY);
    }
  } catch {
    return null;
  }
  if (!stored) return null;
  try {
    return canonicalThemeOverrides(JSON.parse(stored));
  } catch {
    // 损坏的持久化数据按无微调处理，不阻断启动。
    return null;
  }
}

// 初始化主题
const stored = typeof window === "undefined"
  ? null
  : window.localStorage.getItem(STORAGE_KEY);
const initialPreference = canonicalThemePreference(stored);
const initialThemeId = applyTheme(initialPreference);
const initialShape = restoreThemeShapeFromStorage();
const initialOverrides = restoreThemeOverridesFromStorage();
applyThemeOverrides(initialOverrides, initialThemeId);

export const useThemeStore = create<ThemeState>((set, get) => ({
  isDark: themeGroup(initialThemeId) === "dark",
  themeId: initialThemeId,
  preference: initialPreference,
  shape: initialShape,
  customOverrides: initialOverrides,

  setThemeMode: (theme) => {
    const preference = canonicalThemePreference(theme);
    const themeId = applyTheme(preference);
    // 主题切换后重挂微调：baseThemeId 匹配则套用，不匹配则从 DOM 清除。
    applyThemeOverrides(get().customOverrides, themeId);
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

  setThemeOverrides: (patch) => {
    const themeId = get().themeId;
    const existing = get().customOverrides;
    const base: ThemeOverrides = existing && existing.baseThemeId === themeId
      ? { ...existing }
      : { baseThemeId: themeId };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) {
        delete base[key as keyof Omit<ThemeOverrides, "baseThemeId">];
      } else {
        (base as unknown as Record<string, unknown>)[key] = value;
      }
    }
    const overrides = hasAnyOverride(base) ? canonicalThemeOverrides(base) : null;
    applyThemeOverrides(overrides, themeId);
    persistThemeOverrides(overrides);
    set({ customOverrides: overrides });
  },

  resetThemeOverrides: () => {
    applyThemeOverrides(null, get().themeId);
    persistThemeOverrides(null);
    set({ customOverrides: null });
  },

  toggleTheme: () => {
    const preference: ThemePreference = get().isDark ? "light" : "dark";
    const canonical = canonicalThemePreference(preference);
    const themeId = applyTheme(preference);
    applyThemeOverrides(get().customOverrides, themeId);
    set({
      isDark: themeGroup(themeId) === "dark",
      themeId,
      preference: canonical,
    });
  },
}));
