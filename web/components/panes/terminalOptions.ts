import type { TerminalSettings } from "@/types";

export type TerminalCursorStyle = "block" | "underline" | "bar";

export interface TerminalDisplayOptions {
  fontSize: number;
  fontFamily: string;
  cursorStyle: TerminalCursorStyle;
  cursorBlink: boolean;
  scrollback: number;
}

export interface TerminalOptionsTarget {
  options: {
    fontSize?: number;
    fontFamily?: string;
    cursorStyle?: string;
    cursorBlink?: boolean;
    scrollback?: number;
  };
}

export const DEFAULT_TERMINAL_DISPLAY_OPTIONS: TerminalDisplayOptions = {
  fontSize: 14,
  fontFamily:
    'Consolas, "Courier New", "Microsoft YaHei Mono", "Noto Sans Mono CJK SC", "PingFang SC", monospace',
  cursorStyle: "block",
  cursorBlink: true,
  scrollback: 1000,
};

const CURSOR_STYLES = new Set<TerminalCursorStyle>(["block", "underline", "bar"]);

function positiveIntegerOrDefault(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : fallback;
}

function cursorStyleOrDefault(value: unknown): TerminalCursorStyle {
  return CURSOR_STYLES.has(value as TerminalCursorStyle)
    ? (value as TerminalCursorStyle)
    : DEFAULT_TERMINAL_DISPLAY_OPTIONS.cursorStyle;
}

export function resolveTerminalDisplayOptions(
  settings?: Partial<TerminalSettings> | null
): TerminalDisplayOptions {
  return {
    fontSize: positiveIntegerOrDefault(
      settings?.fontSize,
      DEFAULT_TERMINAL_DISPLAY_OPTIONS.fontSize
    ),
    fontFamily:
      settings?.fontFamily?.trim() ||
      DEFAULT_TERMINAL_DISPLAY_OPTIONS.fontFamily,
    cursorStyle: cursorStyleOrDefault(settings?.cursorStyle),
    cursorBlink:
      typeof settings?.cursorBlink === "boolean"
        ? settings.cursorBlink
        : DEFAULT_TERMINAL_DISPLAY_OPTIONS.cursorBlink,
    scrollback: positiveIntegerOrDefault(
      settings?.scrollback,
      DEFAULT_TERMINAL_DISPLAY_OPTIONS.scrollback
    ),
  };
}

export function applyTerminalDisplayOptions(
  terminal: TerminalOptionsTarget,
  options: TerminalDisplayOptions
): boolean {
  let changed = false;

  for (const key of Object.keys(options) as Array<keyof TerminalDisplayOptions>) {
    if (terminal.options[key] === options[key]) continue;
    terminal.options[key] = options[key] as never;
    changed = true;
  }

  return changed;
}
