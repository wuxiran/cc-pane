import { create } from "zustand";

/**
 * 全局 UI 密度档（comfortable / compact）。
 *
 * 持久化与应用方式参照 useThemeStore 的 shape 通道：localStorage 直存 +
 * 模块加载时（React 挂载前）把当前值写到 document.documentElement.dataset.density，
 * CSS 侧由 :root 默认值与 :root[data-density="compact"] 覆盖块接管（index.css）。
 *
 * 与 panes/tabBarDensity.ts 的三档 TabBar 密度是相互独立的另一套配置：
 * 那套只作用于终端标签栏，这里驱动全局列表行 / 状态栏 / 标题栏 / 表单间距。
 */
export type UiDensity = "comfortable" | "compact";

export const UI_DENSITY_STORAGE_KEY = "ui-density";
export const DEFAULT_UI_DENSITY: UiDensity = "comfortable";

export function canonicalUiDensity(value: string | null | undefined): UiDensity {
  return value === "compact" ? "compact" : DEFAULT_UI_DENSITY;
}

interface DensityState {
  density: UiDensity;
  setDensity: (value: string | null | undefined) => void;
}

function applyUiDensity(
  value: string | null | undefined,
  persist: boolean,
): UiDensity {
  const density = canonicalUiDensity(value);
  if (typeof document !== "undefined") {
    document.documentElement.dataset.density = density;
  }
  if (persist) {
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(UI_DENSITY_STORAGE_KEY, density);
      }
    } catch {
      // Restricted webviews may not expose writable storage.
    }
  }
  return density;
}

/** 启动时（React 挂载前）从受控缓存恢复密度，避免首帧先按 comfortable 排版再跳变。 */
export function restoreUiDensityFromStorage(): UiDensity {
  let stored: string | null = null;
  try {
    if (typeof localStorage !== "undefined") {
      stored = localStorage.getItem(UI_DENSITY_STORAGE_KEY);
    }
  } catch {
    // Fall through to the default density.
  }
  return applyUiDensity(stored, true);
}

const initialDensity = restoreUiDensityFromStorage();

export const useDensityStore = create<DensityState>((set) => ({
  density: initialDensity,

  setDensity: (value) => {
    const density = applyUiDensity(value, true);
    set({ density });
  },
}));
