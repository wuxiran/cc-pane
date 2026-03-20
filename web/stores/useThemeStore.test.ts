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

// 现在安全导入
import { useThemeStore } from "./useThemeStore";

describe("useThemeStore", () => {
  beforeEach(() => {
    // 重置 store 到已知状态
    useThemeStore.setState({ isDark: false });
    vi.restoreAllMocks();
    localStorage.clear();
    document.documentElement.classList.remove("dark");
  });

  describe("toggleTheme", () => {
    it("从 light 切换到 dark", () => {
      useThemeStore.setState({ isDark: false });

      useThemeStore.getState().toggleTheme();

      const state = useThemeStore.getState();
      expect(state.isDark).toBe(true);
    });

    it("从 dark 切换到 light", () => {
      useThemeStore.setState({ isDark: true });

      useThemeStore.getState().toggleTheme();

      const state = useThemeStore.getState();
      expect(state.isDark).toBe(false);
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
});
