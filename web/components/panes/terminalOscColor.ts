import type { TerminalThemePalette } from "./terminalTheme";

const OSC_TERMINATOR = "\x1b\\";
const ANSI_COLOR_KEYS = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const satisfies ReadonlyArray<keyof TerminalThemePalette>;

function formatOscRgbColor(hex: string): string | null {
  const match = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;

  const [r, g, b] = [
    match[1].slice(0, 2),
    match[1].slice(2, 4),
    match[1].slice(4, 6),
  ].map((part) => part.toLowerCase());

  return `rgb:${r}${r}/${g}${g}/${b}${b}`;
}

function buildOscReply(ident: number, color: string): string | null {
  const formatted = formatOscRgbColor(color);
  if (!formatted) return null;
  return `\x1b]${ident};${formatted}${OSC_TERMINATOR}`;
}

function buildPaletteReply(index: number, color: string): string | null {
  const formatted = formatOscRgbColor(color);
  if (!formatted) return null;
  return `\x1b]4;${index};${formatted}${OSC_TERMINATOR}`;
}

export function buildOscColorReply(
  ident: number,
  data: string,
  theme: TerminalThemePalette,
): string | null {
  const trimmed = data.trim();

  if (ident === 10 && trimmed === "?") {
    return buildOscReply(10, theme.foreground);
  }

  if (ident === 11 && trimmed === "?") {
    return buildOscReply(11, theme.background);
  }

  if (ident !== 4) {
    return null;
  }

  const [rawIndex, rawQuery] = trimmed.split(";", 2);
  if (rawQuery !== "?") {
    return null;
  }

  const index = Number.parseInt(rawIndex, 10);
  if (!Number.isInteger(index) || index < 0 || index >= ANSI_COLOR_KEYS.length) {
    return null;
  }

  return buildPaletteReply(index, theme[ANSI_COLOR_KEYS[index]]);
}

export interface OscColorQueryOptions {
  cliTool: string;
  wallpaperTransparencyRequired: boolean;
}

export interface OscColorQueryResult {
  handled: boolean;
  response: string | null;
}

export function resolveOscColorQuery(
  ident: number,
  data: string,
  theme: TerminalThemePalette,
  options: OscColorQueryOptions,
): OscColorQueryResult {
  // 壁纸透明模式下吞掉 OSC 11 的**设置**形态（`OSC 11;<color>`，非 `?` 查询）。
  //
  // 放行的话会落到 xterm 内置处理器，把 theme.background 整个换成不透明色——
  // 壁纸被一整块盖掉，且用户无从恢复：CLI 退出时并不保证发 OSC 111 复位，
  // 主题热更（useTerminalAppearanceSync）也只在 xtermTheme 引用变化时才跑。
  // 这里只拦背景（10 = 前景，改了不破坏透明），且只在壁纸激活时拦——
  // 不透明模式下 CLI 自定背景是正当行为，不该被吞。
  if (
    options.wallpaperTransparencyRequired &&
    ident === 11 &&
    data.trim() !== "?"
  ) {
    return { handled: true, response: null };
  }

  if (
    options.cliTool === "codex" &&
    options.wallpaperTransparencyRequired &&
    ident === 11 &&
    data.trim() === "?"
  ) {
    return { handled: true, response: null };
  }

  const response = buildOscColorReply(ident, data, theme);
  return { handled: response !== null, response };
}
