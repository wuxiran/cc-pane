import { afterEach, describe, expect, it } from "vitest";
import { getTerminalTheme } from "./terminalTheme";

const nodeProcess = (globalThis as unknown as {
  process: { cwd(): string; getBuiltinModule(name: "node:fs"): { readFileSync(path: string, encoding: "utf8"): string } };
}).process;
const css = nodeProcess.getBuiltinModule("node:fs").readFileSync(`${nodeProcess.cwd()}/web/assets/index.css`, "utf8");

const variables = ["bg", "fg", "cursor", "selection"];
function rgb(color: string): number[] {
  if (color.startsWith("#")) return color.slice(1).match(/../g)!.map((c) => parseInt(c, 16));
  return color.match(/[\d.]+/g)!.map(Number);
}
function opaque(color: string, backdrop: string): number[] {
  const [r, g, b, a = 1] = rgb(color);
  return [r, g, b].map((c, i) => c * a + rgb(backdrop)[i] * (1 - a));
}
function luminance(color: number[]): number {
  return color.slice(0, 3).map((c) => c / 255)
    .map((c) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
    .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
}
function ratio(a: number[], b: number[]): number {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
const palettes = [...css.matchAll(/([^{}]+)\{([^{}]+)\}/g)]
  .filter((match) => match[2].includes("--app-terminal-bg:"))
  .map((match) => ({ name: match[1].trim().split("\n").slice(-1)[0], body: match[2] }));

afterEach(() => variables.forEach((key) => document.documentElement.style.removeProperty(`--app-terminal-${key}`)));

describe("terminal contrast (alpha composited sRGB)", () => {
  it("audits all nine actual CSS palettes", () => expect(palettes).toHaveLength(9));
  it.each(palettes)("keeps cursor and selections visible in $name", ({ body }) => {
    for (const key of variables) {
      const value = body.match(new RegExp(`--app-terminal-${key}:\\s*([^;]+);`))?.[1];
      if (value) document.documentElement.style.setProperty(`--app-terminal-${key}`, value);
    }
    const theme = getTerminalTheme(true);
    const background = rgb(theme.background);
    const cursor = opaque(theme.cursor, theme.background);
    const selection = opaque(theme.selectionBackground, theme.background);
    expect(ratio(cursor, background), "cursor/background >= 3").toBeGreaterThanOrEqual(3);
    expect(ratio(rgb(theme.cursorAccent), cursor), "cursor text >= 4.5").toBeGreaterThanOrEqual(4.5);
    expect(ratio(selection, background), "selection/background >= 3").toBeGreaterThanOrEqual(3);
    expect(ratio(rgb(theme.selectionForeground), selection), "selected text >= 4.5").toBeGreaterThanOrEqual(4.5);
  });
});
