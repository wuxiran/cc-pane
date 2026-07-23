import type { TerminalThemeMode } from "@/types";

export interface TerminalThemePalette {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  selectionForeground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export const DARK_TERMINAL_THEME: TerminalThemePalette = {
  background: "#17191E",
  foreground: "#f5f5f7",
  cursor: "#0a84ff",
  cursorAccent: "#17191E",
  selectionBackground: "rgba(10, 132, 255, 0.3)",
  selectionForeground: "#f5f5f7",
  black: "#17191E",
  red: "#ff453a",
  green: "#30d158",
  yellow: "#ffd60a",
  blue: "#0a84ff",
  magenta: "#bf5af2",
  cyan: "#64d2ff",
  white: "#f5f5f7",
  brightBlack: "#6e6e73",
  brightRed: "#ff6961",
  brightGreen: "#4ae08a",
  brightYellow: "#ffe620",
  brightBlue: "#409cff",
  brightMagenta: "#da8aff",
  brightCyan: "#70d7ff",
  brightWhite: "#ffffff",
};

export const LIGHT_TERMINAL_THEME: TerminalThemePalette = {
  // macOS Terminal Basic (light) palette.
  background: "#ffffff",
  foreground: "#000000",
  cursor: "#919191",
  cursorAccent: "#ffffff",
  selectionBackground: "rgba(178, 212, 255, 0.8)",
  selectionForeground: "#000000",
  black: "#000000",
  red: "#c33720",
  green: "#32be28",
  yellow: "#afaf23",
  blue: "#5230e1",
  magenta: "#d73cd2",
  cyan: "#32bac8",
  white: "#cccccc",
  brightBlack: "#828282",
  brightRed: "#ff3c1e",
  brightGreen: "#2fe721",
  brightYellow: "#ebec15",
  brightBlue: "#5e34ff",
  brightMagenta: "#fe3cff",
  brightCyan: "#28f0f0",
  brightWhite: "#ebebeb",
};

export function resolveTerminalThemeMode(
  themeMode?: TerminalThemeMode | string | null,
): TerminalThemeMode {
  if (themeMode === "dark" || themeMode === "light" || themeMode === "followApp") {
    return themeMode;
  }
  return "followApp";
}

/** #RGB / #RRGGBB 转 rgba；已是 rgb()/rgba() 的原样返回（保守不重写 alpha） */
function hexToRgba(color: string, alpha: number): string {
  const hex = color.trim();
  const match = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(hex);
  if (!match) return color;
  let value = match[1];
  if (value.length === 3) {
    value = value
      .split("")
      .map((ch) => ch + ch)
      .join("");
  }
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * 返回 background 转 rgba 的新调色板；仅动 background——cursorAccent 保持不透明
 * （块状光标下字符会糊），其余色不涉及。
 *
 * `alpha >= 1` 时返回**原对象引用**：terminalTheme.test.ts 对
 * DARK/LIGHT_TERMINAL_THEME 有 `toBe` 恒等断言，壁纸未激活必须零变化。
 */
export function withTerminalBackgroundAlpha(
  palette: TerminalThemePalette,
  alpha: number,
): TerminalThemePalette {
  if (!Number.isFinite(alpha) || alpha >= 1) return palette;
  const clamped = Math.max(0, alpha);
  return {
    ...palette,
    background: hexToRgba(palette.background, clamped),
  };
}

/**
 * xterm 自身用的调色板：background 完全透明。
 *
 * 壁纸激活时外层容器已经画了一层 rgba 底色，xterm 元素若再画同一个 rgba，
 * 同一层色就被叠了两遍（0.3 叠 0.3 实际 ≈ 0.51，视觉上「隔了两层」），
 * 且 terminalOpacity 永远到不了真正的全透明。底色归容器独占，xterm 只画字。
 *
 * `alpha >= 1` 时返回**原对象引用**（同 withTerminalBackgroundAlpha 的恒等约定）。
 */
export function withTransparentTerminalBackground(
  palette: TerminalThemePalette,
  alpha: number,
): TerminalThemePalette {
  if (!Number.isFinite(alpha) || alpha >= 1) return palette;
  return { ...palette, background: "rgba(0, 0, 0, 0)" };
}

export function getTerminalTheme(
  isDark: boolean,
  themeMode?: TerminalThemeMode | string | null,
  alpha?: number,
): TerminalThemePalette {
  const resolvedMode = resolveTerminalThemeMode(themeMode);
  const base =
    resolvedMode === "dark"
      ? DARK_TERMINAL_THEME
      : resolvedMode === "light"
        ? LIGHT_TERMINAL_THEME
        : isDark
          ? DARK_TERMINAL_THEME
          : LIGHT_TERMINAL_THEME;
  return alpha === undefined ? base : withTerminalBackgroundAlpha(base, alpha);
}
