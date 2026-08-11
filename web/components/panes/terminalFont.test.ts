import { describe, expect, it } from "vitest";
import {
  DEFAULT_TERMINAL_FONT_FAMILY,
  fontFamilyHasCjkFallback,
  normalizeTerminalFontFamily,
  preferPlatformMonoFonts,
} from "./terminalFont";

describe("normalizeTerminalFontFamily", () => {
  it("returns the default chain for empty values", () => {
    expect(normalizeTerminalFontFamily(undefined)).toBe(DEFAULT_TERMINAL_FONT_FAMILY);
    expect(normalizeTerminalFontFamily(null)).toBe(DEFAULT_TERMINAL_FONT_FAMILY);
    expect(normalizeTerminalFontFamily("   ")).toBe(DEFAULT_TERMINAL_FONT_FAMILY);
  });

  it("keeps chains that already contain a CJK-capable font", () => {
    const value = '"JetBrains Mono", "Sarasa Mono SC", monospace';
    expect(normalizeTerminalFontFamily(value)).toBe(value);
    expect(normalizeTerminalFontFamily(DEFAULT_TERMINAL_FONT_FAMILY)).toBe(
      DEFAULT_TERMINAL_FONT_FAMILY,
    );
  });

  it("appends a CJK fallback before the generic monospace entry", () => {
    const result = normalizeTerminalFontFamily('Consolas, "Courier New", monospace');
    expect(result).toContain("Consolas");
    expect(result).toContain('"Microsoft YaHei UI"');
    expect(result.indexOf("Consolas")).toBeLessThan(result.indexOf('"Microsoft YaHei UI"'));
    expect(result.trim().endsWith("monospace")).toBe(true);
  });

  it("appends a CJK fallback and generic monospace when the chain has no generic entry", () => {
    const result = normalizeTerminalFontFamily('"Cascadia Mono"');
    expect(result).toContain('"Cascadia Mono"');
    expect(result).toContain('"Sarasa Mono SC"');
    expect(result.trim().endsWith("monospace")).toBe(true);
  });
});

describe("preferPlatformMonoFonts", () => {
  it("puts macOS system mono fonts ahead of the bundled webfont", () => {
    const result = preferPlatformMonoFonts(DEFAULT_TERMINAL_FONT_FAMILY, "macos");

    expect(result.indexOf('"SF Mono"')).toBeLessThan(result.indexOf('"Maple Mono NF CN"'));
    expect(result.indexOf("Menlo")).toBeLessThan(result.indexOf('"Maple Mono NF CN"'));
    // webfont 仍留在链里继续兜 CJK 字形
    expect(result).toContain('"Maple Mono NF CN"');
    expect(result.trim().endsWith("monospace")).toBe(true);
  });

  it("leaves other platforms untouched", () => {
    expect(preferPlatformMonoFonts(DEFAULT_TERMINAL_FONT_FAMILY, "windows")).toBe(
      DEFAULT_TERMINAL_FONT_FAMILY,
    );
    expect(preferPlatformMonoFonts(DEFAULT_TERMINAL_FONT_FAMILY, undefined)).toBe(
      DEFAULT_TERMINAL_FONT_FAMILY,
    );
  });

  it("respects a font chain the user explicitly picked", () => {
    const userChain = '"JetBrains Mono", "Sarasa Mono SC", monospace';
    expect(preferPlatformMonoFonts(userChain, "macos")).toBe(userChain);
  });

  it("is idempotent once the system fonts are already in front", () => {
    const once = preferPlatformMonoFonts(DEFAULT_TERMINAL_FONT_FAMILY, "macos");
    expect(preferPlatformMonoFonts(once, "macos")).toBe(once);
  });
});

describe("fontFamilyHasCjkFallback", () => {
  it("detects CJK-capable fonts case-insensitively", () => {
    expect(fontFamilyHasCjkFallback("Consolas, MICROSOFT YAHEI")).toBe(true);
    expect(fontFamilyHasCjkFallback("Consolas, 微软雅黑")).toBe(true);
    expect(fontFamilyHasCjkFallback('Consolas, "Courier New", monospace')).toBe(false);
  });
});
