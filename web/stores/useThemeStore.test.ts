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
import { THEME_OVERRIDES_STORAGE_KEY } from "@/theme/themeOverrides";
import {
  isolateSpecialWindowShape,
  resolveThemeMode,
  restoreThemeOverridesFromStorage,
  restoreThemeShapeFromStorage,
  THEME_SHAPE_STORAGE_KEY,
  useThemeStore,
} from "./useThemeStore";

describe("useThemeStore", () => {
  beforeEach(() => {
    useThemeStore.setState({
      isDark: false,
      themeId: "classic-white",
      preference: "classic-white",
      shape: "soft",
      customOverrides: null,
    });
    vi.restoreAllMocks();
    localStorage.clear();
    document.documentElement.classList.remove("dark");
    document.documentElement.removeAttribute("style");
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

      useThemeStore.getState().toggleTheme();

      expect(window.localStorage.getItem("theme")).toBe("dark");
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

  describe("customOverrides", () => {
    it("setThemeOverrides 立即写 documentElement inline style 并持久化", () => {
      useThemeStore.getState().setThemeMode("deep-ink");
      useThemeStore.getState().setThemeOverrides({ accent: "amber", radius: 0.6 });

      const state = useThemeStore.getState();
      expect(state.customOverrides).toEqual({
        baseThemeId: "deep-ink",
        accent: "amber",
        radius: 0.6,
      });
      const rootStyle = document.documentElement.style;
      expect(rootStyle.getPropertyValue("--app-accent")).toBe("#E9A916");
      expect(rootStyle.getPropertyValue("--primary")).toBe("#E9A916");
      expect(rootStyle.getPropertyValue("--radius")).toBe("0.6rem");
      expect(rootStyle.getPropertyValue("--shape-radius-lg")).toBe("var(--radius)");
      expect(localStorage.getItem(THEME_OVERRIDES_STORAGE_KEY)).toBe(
        JSON.stringify(state.customOverrides),
      );
    });

    it("暗色主题同样被 inline 覆盖（inline 优先于 .dark 样式表块）", () => {
      useThemeStore.getState().setThemeMode("deep-ink");
      useThemeStore.getState().setThemeOverrides({ accent: "green" });

      expect(document.documentElement.classList.contains("dark")).toBe(true);
      expect(document.documentElement.style.getPropertyValue("--app-accent")).toBe("#4ADE80");
    });

    it("亮色主题取 accent 预设的 light 变体", () => {
      useThemeStore.getState().setThemeMode("classic-white");
      useThemeStore.getState().setThemeOverrides({ accent: "green" });

      expect(document.documentElement.style.getPropertyValue("--app-accent")).toBe("#178A5E");
    });

    it("面板明度偏移以 color-mix 叠加在该主题基值上", () => {
      useThemeStore.getState().setThemeMode("deep-ink");
      useThemeStore.getState().setThemeOverrides({ panelLightnessDelta: 5 });

      expect(document.documentElement.style.getPropertyValue("--app-panel-bg")).toBe(
        "color-mix(in srgb, #2E3137 95%, white)",
      );
    });

    it("字段传 undefined 清除单项；清空后整体回落 null 并移除 DOM 覆盖", () => {
      useThemeStore.getState().setThemeMode("deep-ink");
      useThemeStore.getState().setThemeOverrides({ accent: "blue", radius: 0.4 });
      useThemeStore.getState().setThemeOverrides({ accent: undefined });

      let state = useThemeStore.getState();
      expect(state.customOverrides).toEqual({ baseThemeId: "deep-ink", radius: 0.4 });
      expect(document.documentElement.style.getPropertyValue("--app-accent")).toBe("");
      expect(document.documentElement.style.getPropertyValue("--radius")).toBe("0.4rem");

      useThemeStore.getState().setThemeOverrides({ radius: undefined });
      state = useThemeStore.getState();
      expect(state.customOverrides).toBeNull();
      expect(document.documentElement.style.getPropertyValue("--radius")).toBe("");
      expect(localStorage.getItem(THEME_OVERRIDES_STORAGE_KEY)).toBeNull();
    });

    it("resetThemeOverrides 一键清空并移除全部覆盖 token", () => {
      useThemeStore.getState().setThemeMode("deep-ink");
      useThemeStore.getState().setThemeOverrides({
        accent: "red",
        radius: 0.2,
        panelLightnessDelta: -4,
      });

      useThemeStore.getState().resetThemeOverrides();

      expect(useThemeStore.getState().customOverrides).toBeNull();
      const rootStyle = document.documentElement.style;
      expect(rootStyle.getPropertyValue("--app-accent")).toBe("");
      expect(rootStyle.getPropertyValue("--radius")).toBe("");
      expect(rootStyle.getPropertyValue("--app-panel-bg")).toBe("");
      expect(localStorage.getItem(THEME_OVERRIDES_STORAGE_KEY)).toBeNull();
    });

    it("切换到其他主题时覆盖从 DOM 移除但数据保留，切回即恢复", () => {
      useThemeStore.getState().setThemeMode("deep-ink");
      useThemeStore.getState().setThemeOverrides({ accent: "violet" });

      useThemeStore.getState().setThemeMode("classic-white");
      expect(useThemeStore.getState().customOverrides?.baseThemeId).toBe("deep-ink");
      expect(document.documentElement.style.getPropertyValue("--app-accent")).toBe("");

      useThemeStore.getState().setThemeMode("deep-ink");
      expect(document.documentElement.style.getPropertyValue("--app-accent")).toBe("#A78BFA");
    });

    it("在别的主题上继续微调会重挂 baseThemeId", () => {
      useThemeStore.getState().setThemeMode("deep-ink");
      useThemeStore.getState().setThemeOverrides({ accent: "violet" });

      useThemeStore.getState().setThemeMode("sky-blue");
      useThemeStore.getState().setThemeOverrides({ radius: 0.8 });

      expect(useThemeStore.getState().customOverrides).toEqual({
        baseThemeId: "sky-blue",
        radius: 0.8,
      });
      expect(document.documentElement.style.getPropertyValue("--radius")).toBe("0.8rem");
      expect(document.documentElement.style.getPropertyValue("--app-accent")).toBe("");
    });

    it("持久化数据损坏或非法时恢复为 null，合法数据原样恢复", () => {
      localStorage.setItem(THEME_OVERRIDES_STORAGE_KEY, "{broken json");
      expect(restoreThemeOverridesFromStorage()).toBeNull();

      localStorage.setItem(
        THEME_OVERRIDES_STORAGE_KEY,
        JSON.stringify({ baseThemeId: "nope", accent: "blue" }),
      );
      expect(restoreThemeOverridesFromStorage()).toBeNull();

      localStorage.setItem(
        THEME_OVERRIDES_STORAGE_KEY,
        JSON.stringify({ baseThemeId: "deep-ink", accent: "blue", radius: 0.35 }),
      );
      expect(restoreThemeOverridesFromStorage()).toEqual({
        baseThemeId: "deep-ink",
        accent: "blue",
        radius: 0.35,
      });
    });
  });
});
