import { afterEach, describe, expect, it } from "vitest";
import {
  DARK_TERMINAL_THEME,
  LIGHT_TERMINAL_THEME,
  getTerminalTheme,
  resolveTerminalThemeMode,
  withTerminalBackgroundAlpha,
  withTransparentTerminalBackground,
} from "./terminalTheme";

const CORE_COLOR_VARIABLES = [
  "--app-terminal-bg",
  "--app-terminal-fg",
  "--app-terminal-cursor",
  "--app-terminal-selection",
] as const;

function setCoreColorVariables(values: Partial<Record<(typeof CORE_COLOR_VARIABLES)[number], string>>) {
  for (const [name, value] of Object.entries(values)) {
    document.documentElement.style.setProperty(name, value);
  }
}

afterEach(() => {
  for (const name of CORE_COLOR_VARIABLES) {
    document.documentElement.style.removeProperty(name);
  }
});

describe("terminalTheme", () => {
  it("follows the app theme by default", () => {
    expect(getTerminalTheme(true)).toBe(DARK_TERMINAL_THEME);
    expect(getTerminalTheme(false)).toBe(LIGHT_TERMINAL_THEME);
    expect(getTerminalTheme(true, "followApp")).toBe(DARK_TERMINAL_THEME);
    expect(getTerminalTheme(false, "followApp")).toBe(LIGHT_TERMINAL_THEME);
  });

  it("allows terminal theme to override the app theme", () => {
    expect(getTerminalTheme(false, "dark")).toBe(DARK_TERMINAL_THEME);
    expect(getTerminalTheme(true, "light")).toBe(LIGHT_TERMINAL_THEME);
  });

  it("normalizes unknown theme modes to followApp", () => {
    expect(resolveTerminalThemeMode("unknown")).toBe("followApp");
    expect(resolveTerminalThemeMode(null)).toBe("followApp");
  });

  it("核心四色跟随当前应用主题的 CSS 变量", () => {
    setCoreColorVariables({
      "--app-terminal-bg": "#112233",
      "--app-terminal-fg": "#ddeeff",
      "--app-terminal-cursor": "#abcdef",
      "--app-terminal-selection": "rgba(12, 34, 56, 0.4)",
    });

    const themed = getTerminalTheme(true, "followApp");

    expect(themed).not.toBe(DARK_TERMINAL_THEME);
    expect(themed).toMatchObject({
      background: "#112233",
      foreground: "#ddeeff",
      cursor: "#abcdef",
      selectionBackground: "rgba(12, 34, 56, 0.4)",
    });
    expect(themed.red).toBe(DARK_TERMINAL_THEME.red);
  });

  it("CSS 变量缺失或非法时逐项回退到现有终端常量", () => {
    setCoreColorVariables({
      "--app-terminal-bg": "not-a-color",
      "--app-terminal-fg": "#123456",
    });

    expect(getTerminalTheme(true, "followApp")).toMatchObject({
      background: DARK_TERMINAL_THEME.background,
      foreground: "#123456",
      cursor: DARK_TERMINAL_THEME.cursor,
      selectionBackground: DARK_TERMINAL_THEME.selectionBackground,
    });
  });

  it("显式终端主题与应用主题相反时不读取当前应用的 CSS 核心色", () => {
    setCoreColorVariables({
      "--app-terminal-bg": "#112233",
      "--app-terminal-fg": "#ddeeff",
      "--app-terminal-cursor": "#abcdef",
      "--app-terminal-selection": "rgba(12, 34, 56, 0.4)",
    });

    expect(getTerminalTheme(true, "light")).toBe(LIGHT_TERMINAL_THEME);
    expect(getTerminalTheme(false, "dark")).toBe(DARK_TERMINAL_THEME);
  });

  describe("withTerminalBackgroundAlpha", () => {
    it("alpha >= 1 返回原对象引用（壁纸未激活零变化）", () => {
      expect(withTerminalBackgroundAlpha(DARK_TERMINAL_THEME, 1)).toBe(DARK_TERMINAL_THEME);
      expect(withTerminalBackgroundAlpha(LIGHT_TERMINAL_THEME, 2)).toBe(LIGHT_TERMINAL_THEME);
      expect(withTerminalBackgroundAlpha(DARK_TERMINAL_THEME, Number.NaN)).toBe(
        DARK_TERMINAL_THEME,
      );
    });

    it("alpha < 1 时 background 转 rgba，其余字段不动", () => {
      const themed = withTerminalBackgroundAlpha(DARK_TERMINAL_THEME, 0.85);
      expect(themed).not.toBe(DARK_TERMINAL_THEME);
      expect(themed.background).toBe("rgba(23, 25, 30, 0.85)");
      // cursorAccent 保持不透明（块状光标下字符会糊）
      expect(themed.cursorAccent).toBe(DARK_TERMINAL_THEME.cursorAccent);
      expect(themed.foreground).toBe(DARK_TERMINAL_THEME.foreground);
    });

    it("getTerminalTheme 第三参传 alpha；不传保持恒等引用", () => {
      expect(getTerminalTheme(true, "followApp", 0.5).background).toBe(
        "rgba(23, 25, 30, 0.5)",
      );
      expect(getTerminalTheme(true, "followApp", 1)).toBe(DARK_TERMINAL_THEME);
      expect(getTerminalTheme(true)).toBe(DARK_TERMINAL_THEME);
    });
  });

  describe("withTransparentTerminalBackground", () => {
    it("alpha < 1 时 xterm 侧 background 全透明并保留逻辑底色的 RGB", () => {
      const container = getTerminalTheme(true, "followApp", 0.3);
      const xterm = withTransparentTerminalBackground(container, 0.3);
      expect(container.background).toBe("rgba(23, 25, 30, 0.3)");
      expect(xterm.background).toBe("rgba(23, 25, 30, 0)");
      // 只动 background，字色/光标不变
      expect(xterm.foreground).toBe(container.foreground);
      expect(xterm.cursorAccent).toBe(container.cursorAccent);
    });

    it("浅色透明终端保留浅色 RGB，供 ANSI 前景色对比度校正", () => {
      const container = getTerminalTheme(false, "followApp", 0.3);
      expect(container.background).toBe("rgba(255, 255, 255, 0.3)");
      expect(withTransparentTerminalBackground(container, 0.3).background).toBe(
        "rgba(255, 255, 255, 0)",
      );
    });

    it("alpha >= 1（壁纸未激活）保持恒等引用，零行为变化", () => {
      expect(withTransparentTerminalBackground(DARK_TERMINAL_THEME, 1)).toBe(
        DARK_TERMINAL_THEME,
      );
      expect(withTransparentTerminalBackground(LIGHT_TERMINAL_THEME, Number.NaN)).toBe(
        LIGHT_TERMINAL_THEME,
      );
    });

    it("terminalOpacity=0 时容器与 xterm 都不画底色，字直接浮在壁纸上", () => {
      const container = getTerminalTheme(true, "followApp", 0);
      expect(container.background).toBe("rgba(23, 25, 30, 0)");
      expect(withTransparentTerminalBackground(container, 0).background).toBe(
        "rgba(23, 25, 30, 0)",
      );
    });
  });
});
