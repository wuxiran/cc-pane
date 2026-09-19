import type { TerminalThemePalette } from "./terminalTheme";

type Rgb = [number, number, number];

function parse(color: string): number[] | null {
  const hex = /^#([a-f\d]{3}|[a-f\d]{6})$/i.exec(color.trim());
  if (hex) {
    const value = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join("") : hex[1];
    return [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16));
  }
  const rgb = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/.exec(color);
  return rgb ? rgb.slice(1).filter((v) => v !== undefined).map(Number) : null;
}

function composite(color: string, background: Rgb): Rgb | null {
  const values = parse(color);
  if (!values) return null;
  const alpha = Math.min(1, Math.max(0, values[3] ?? 1));
  return background.map((c, i) => values[i] * alpha + c * (1 - alpha)) as Rgb;
}

function luminance(rgb: Rgb): number {
  return rgb.map((v) => v / 255)
    .map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
    .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
}

function ratio(a: Rgb, b: Rgb): number {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

function legibleText(background: Rgb): string {
  return ratio([255, 255, 255], background) >= ratio([0, 0, 0], background) ? "#ffffff" : "#000000";
}

/** Enforce visible UI marks (3:1) and readable text (4.5:1), including alpha. */
export function ensureTerminalContrast(theme: TerminalThemePalette): TerminalThemePalette {
  const background = (parse(theme.background)?.slice(0, 3) ?? [23, 25, 30]) as Rgb;
  const result = { ...theme };
  for (const [mark, text] of [["cursor", "cursorAccent"], ["selectionBackground", "selectionForeground"]] as const) {
    let color = composite(result[mark], background);
    if (!color || ratio(color, background) < 3) {
      // Prefer a blue selection when it clears the minimum, otherwise black/white.
      const fallback = mark === "selectionBackground" ? "#526e96" : legibleText(background);
      result[mark] = ratio(composite(fallback, background)!, background) >= 3
        ? fallback : legibleText(background);
      color = composite(result[mark], background)!;
    }
    const foreground = composite(result[text], color);
    if (!foreground || ratio(foreground, color) < 4.5) result[text] = legibleText(color);
  }
  // xterm otherwise dims unfocused selections, undoing the visibility guarantee.
  result.selectionInactiveBackground = result.selectionBackground;
  return Object.keys(result).every((key) => result[key as keyof typeof result] === theme[key as keyof typeof theme])
    ? theme : result;
}
