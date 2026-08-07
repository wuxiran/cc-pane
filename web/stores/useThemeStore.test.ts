import { describe, it, expect, beforeEach, vi } from "vitest";

// 使用 vi.hoisted 在所有模块导入之前执行 matchMedia mock
// useThemeStore 模块级代码调用 window.matchMedia，jsdom 不提供此 API
vi.hoisted(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
});

import { THEME_SHAPE_CODES } from "@/theme/themeShapes";
import {
  isolateSpecialWindowShape,
  resolveThemeMode,
  restoreThemeShapeFromStorage,
  THEME_SHAPE_STORAGE_KEY,
  useThemeStore,
} from "./useThemeStore";

describe("useThemeStore", () => {
  beforeEach(() => {
    useThemeStore.setState({ isDark: false, shape: "soft" });
    vi.restoreAllMocks();
    localStorage.clear();
    document.documentElement.classList.remove("dark");
    delete document.documentElement.dataset.shape;
  });

  describe("toggleTheme", () => {
    it("从 light 切换到 dark", () => {
      useThemeStore.setState({ isDark: false });

      useThemeStore.getState().toggleTheme();

      expect(useThemeStore.getState().isDark).toBe(true);
    });

    it("从 dark 切换到 light", () => {
      useThemeStore.setState({ isDark: true });

      useThemeStore.getState().toggleTheme();

      expect(useThemeStore.getState().isDark).toBe(false);
    });

    it("应更新 localStorage", () => {
      useThemeStore.setState({ isDark: false });
      const setItemSpy = vi.spyOn(Storage.prototype, "setItem");

      useThemeStore.getState().toggleTheme();

      expect(setItemSpy).toHaveBeenCalledWith("theme", "dark");
    });

    it("切换到 dark 时应在 DOM 添加 dark class", () => {
      useThemeStore.setState({ isDark: false });

      useThemeStore.getState().toggleTheme();

      expect(document.documentElement.classList.contains("dark")).toBe(true);
    });

    it("切换到 light 时应从 DOM 移除 dark class", () => {
      useThemeStore.setState({ isDark: true });
      document.documentElement.classList.add("dark");

      useThemeStore.getState().toggleTheme();

      expect(document.documentElement.classList.contains("dark")).toBe(false);
    });

    it("连续切换两次应回到原始状态", () => {
      useThemeStore.setState({ isDark: false });

      useThemeStore.getState().toggleTheme();
      useThemeStore.getState().toggleTheme();

      expect(useThemeStore.getState().isDark).toBe(false);
    });
  });

  describe("setThemeMode", () => {
    it("应将 dark/light 模式同步到 store 和 DOM", () => {
      useThemeStore.getState().setThemeMode("dark");
      expect(useThemeStore.getState().isDark).toBe(true);
      expect(document.documentElement.classList.contains("dark")).toBe(true);

      useThemeStore.getState().setThemeMode("light");
      expect(useThemeStore.getState().isDark).toBe(false);
      expect(document.documentElement.classList.contains("dark")).toBe(false);
    });

    it("应将未知值回退到 dark", () => {
      expect(resolveThemeMode(null)).toBe("dark");
      expect(resolveThemeMode(undefined)).toBe("dark");
      expect(resolveThemeMode("system")).toBe("light");
    });
  });

  describe("setThemeShape", () => {
    it.each(THEME_SHAPE_CODES)("应用并缓存 %s", (shape) => {
      useThemeStore.getState().setThemeShape(shape);

      expect(useThemeStore.getState().shape).toBe(shape);
      expect(document.documentElement.dataset.shape).toBe(shape);
      expect(localStorage.getItem(THEME_SHAPE_STORAGE_KEY)).toBe(shape);
    });

    it("把非法值回落为 soft", () => {
      useThemeStore.getState().setThemeShape("glass; color: red");

      expect(useThemeStore.getState().shape).toBe("soft");
      expect(document.documentElement.dataset.shape).toBe("soft");
      expect(localStorage.getItem(THEME_SHAPE_STORAGE_KEY)).toBe("soft");
    });

    it("与配色主题保持独立", () => {
      useThemeStore.getState().setThemeMode("cyber-purple");
      useThemeStore.getState().setThemeShape("sharp");
      expect(useThemeStore.getState().themeId).toBe("cyber-purple");

      useThemeStore.getState().setThemeMode("classic-white");
      expect(useThemeStore.getState().shape).toBe("sharp");
    });
  });

  describe("shape startup", () => {
    it("在 React 挂载前从受控缓存恢复形态", () => {
      localStorage.setItem(THEME_SHAPE_STORAGE_KEY, "glass");

      expect(restoreThemeShapeFromStorage()).toBe("glass");
      expect(document.documentElement.dataset.shape).toBe("glass");
    });

    it("缓存非法时恢复为 soft", () => {
      localStorage.setItem(THEME_SHAPE_STORAGE_KEY, "unknown");

      expect(restoreThemeShapeFromStorage()).toBe("soft");
      expect(document.documentElement.dataset.shape).toBe("soft");
    });

    it("专用窗口使用 soft 且不覆盖主窗口缓存", () => {
      localStorage.setItem(THEME_SHAPE_STORAGE_KEY, "carbon");
      document.documentElement.dataset.shape = "carbon";

      isolateSpecialWindowShape();

      expect(document.documentElement.dataset.shape).toBe("soft");
      expect(localStorage.getItem(THEME_SHAPE_STORAGE_KEY)).toBe("carbon");
    });
  });
});
