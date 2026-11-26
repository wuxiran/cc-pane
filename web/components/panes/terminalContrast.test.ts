import { describe, expect, it } from "vitest";

import { DARK_TERMINAL_THEME, LIGHT_TERMINAL_THEME } from "./terminalTheme";
import {
  MINIMUM_TERMINAL_CONTRAST_RATIO,
  TERMINAL_TEXT_COLOR_KEYS,
  auditTerminalPaletteContrast,
  contrastRatio,
  parseHexColor,
  relativeLuminance,
} from "./terminalContrast";

describe("MINIMUM_TERMINAL_CONTRAST_RATIO", () => {
  it("不低于 WCAG AA 正文级 4.5", () => {
    // F7.1 的核心保证：阈值被调低就会让浅色主题文字回到不可读，单测在此看守。
    expect(MINIMUM_TERMINAL_CONTRAST_RATIO).toBeGreaterThanOrEqual(4.5);
  });
});

describe("parseHexColor", () => {
  it.each<[string, [number, number, number] | null]>([
    ["#000000", [0, 0, 0]],
    ["#fff", [255, 255, 255]],
    ["#17191E", [0x17, 0x19, 0x1e]],
    ["  #0a84ff  ", [0x0a, 0x84, 0xff]],
    ["rgba(23, 25, 30, 0.3)", null],
    ["transparent", null],
    ["", null],
  ])("parseHexColor(%j) -> %j", (input, expected) => {
    expect(parseHexColor(input)).toEqual(expected);
  });
});

describe("relativeLuminance / contrastRatio（WCAG 2.x 口径）", () => {
  it("黑白亮度分别为 1 与 0", () => {
    expect(relativeLuminance([255, 255, 255])).toBeCloseTo(1, 5);
    expect(relativeLuminance([0, 0, 0])).toBeCloseTo(0, 5);
  });

  it("黑白对比度为 21:1（上限），同色为 1:1（下限）", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
  });

  it("对比度与前后景顺序无关", () => {
    const forward = contrastRatio("#c33720", "#ffffff");
    const backward = contrastRatio("#ffffff", "#c33720");
    expect(forward).toBeCloseTo(backward as number, 10);
  });

  it("已知参考值：#767676 对白底恰在 4.5 附近（WCAG 经典样例）", () => {
    const ratio = contrastRatio("#767676", "#ffffff");
    expect(ratio).toBeGreaterThanOrEqual(4.5);
    expect(ratio).toBeLessThan(4.6);
  });

  it("任一侧不可解析时返回 null，不猜测 alpha 合成", () => {
    expect(contrastRatio("rgba(0,0,0,0.5)", "#ffffff")).toBeNull();
    expect(contrastRatio("#000000", "rgba(255,255,255,0.3)")).toBeNull();
  });
});

describe("auditTerminalPaletteContrast", () => {
  it("覆盖全部 ANSI 文字色键", () => {
    const entries = auditTerminalPaletteContrast(LIGHT_TERMINAL_THEME);
    expect(entries).toHaveLength(TERMINAL_TEXT_COLOR_KEYS.length);
    expect(entries.map((entry) => entry.color)).toEqual([...TERMINAL_TEXT_COLOR_KEYS]);
  });

  it("浅色主题确实存在大量跌破阈值的颜色——自动对比度不是摆设", () => {
    // 实测（macOS Terminal Basic 亮色）：亮黄/亮青/亮白/绿/青等远低于 4.5。
    // 这条断言把「F7.1 有必要」的前提锁死：若调色板全变高对比而该前提消失，
    // 说明有人改了主题，需要重新评估 minimumContrastRatio 的取值。
    const entries = auditTerminalPaletteContrast(LIGHT_TERMINAL_THEME);
    const needsAdjustment = entries.filter((entry) => entry.needsAdjustment);
    expect(needsAdjustment.length).toBeGreaterThanOrEqual(8);
    expect(needsAdjustment.some((entry) => entry.color === "brightYellow")).toBe(true);
    expect(needsAdjustment.some((entry) => entry.color === "brightCyan")).toBe(true);
    expect(needsAdjustment.some((entry) => entry.color === "brightWhite")).toBe(true);
  });

  it("保留本就可读的配色：达标颜色不被标记为需调整", () => {
    // F7.1 明确要求「保留本就可读的配色」——xterm 只动跌破阈值的色。
    const entries = auditTerminalPaletteContrast(LIGHT_TERMINAL_THEME);
    const readable = entries.filter((entry) => !entry.needsAdjustment);
    expect(readable.length).toBeGreaterThan(0);
    for (const entry of readable) {
      expect(entry.ratio).toBeGreaterThanOrEqual(MINIMUM_TERMINAL_CONTRAST_RATIO);
    }
    // 亮色主题里黑字与红/蓝本就达标，不应被「增强」
    const black = entries.find((entry) => entry.color === "black");
    expect(black?.ratio).toBeCloseTo(21, 1);
    expect(black?.needsAdjustment).toBe(false);
  });

  it("暗色主题绝大多数颜色本就达标", () => {
    const entries = auditTerminalPaletteContrast(DARK_TERMINAL_THEME);
    const needsAdjustment = entries.filter((entry) => entry.needsAdjustment);
    // 实测仅 black（与背景同色）与 brightBlack 跌破
    expect(needsAdjustment.length).toBeLessThanOrEqual(3);
    expect(needsAdjustment.some((entry) => entry.color === "brightBlack")).toBe(true);
  });

  it("阈值可参数化：needsAdjustment 严格跟随阈值", () => {
    const count = (threshold: number) =>
      auditTerminalPaletteContrast(LIGHT_TERMINAL_THEME, threshold).filter((e) => e.needsAdjustment).length;
    expect(count(7)).toBeGreaterThan(count(4.5));
    expect(count(0)).toBe(0);
  });

  it("背景为 rgba（壁纸透明度生效）时返回空数组而非误判", () => {
    const entries = auditTerminalPaletteContrast({
      ...LIGHT_TERMINAL_THEME,
      background: "rgba(255, 255, 255, 0.3)",
    });
    expect(entries).toEqual([]);
  });

  it("每条结果都带原始色值与有限对比度，便于失败定位", () => {
    for (const entry of auditTerminalPaletteContrast(DARK_TERMINAL_THEME)) {
      expect(entry.value).toMatch(/^#/);
      expect(Number.isFinite(entry.ratio)).toBe(true);
      expect(entry.ratio).toBeGreaterThanOrEqual(1);
      expect(entry.ratio).toBeLessThanOrEqual(21);
    }
  });
});
