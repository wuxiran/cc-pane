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

export function getTerminalTheme(
  isDark: boolean,
  themeMode?: TerminalThemeMode | string | null,
): TerminalThemePalette {
  const resolvedMode = resolveTerminalThemeMode(themeMode);
  if (resolvedMode === "dark") return DARK_TERMINAL_THEME;
  if (resolvedMode === "light") return LIGHT_TERMINAL_THEME;
  return isDark ? DARK_TERMINAL_THEME : LIGHT_TERMINAL_THEME;
}
