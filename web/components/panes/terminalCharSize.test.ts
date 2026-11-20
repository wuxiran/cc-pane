import { describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import {
  bindTerminalFontIfPending,
  bindTerminalFontLoadingDone,
  remeasureTerminalCharSize,
} from "./terminalCharSize";

function fakeFonts(check: (font: string) => boolean) {
  const listeners = new Set<() => void>();
  return {
    addEventListener: (_type: "loadingdone", listener: () => void) => void listeners.add(listener),
    removeEventListener: (_type: "loadingdone", listener: () => void) => void listeners.delete(listener),
    check,
    fire: () => [...listeners].forEach((listener) => listener()),
    size: () => listeners.size,
  };
}

const term = { options: { fontSize: 14, fontFamily: "Maple Mono NF CN, Consolas" } } as unknown as Terminal;

describe("remeasureTerminalCharSize", () => {
  it("asks xterm's char size service to measure again", () => {
    const measure = vi.fn();
    expect(remeasureTerminalCharSize({ _core: { _charSizeService: { measure } } } as unknown as Terminal)).toBe(true);
    expect(measure).toHaveBeenCalledTimes(1);
  });

  it("degrades quietly when the private service is missing or throws", () => {
    expect(remeasureTerminalCharSize({} as Terminal)).toBe(false);
    const throwing = { _core: { _charSizeService: { measure: () => { throw new Error("disposed"); } } } };
    expect(remeasureTerminalCharSize(throwing as unknown as Terminal)).toBe(false);
  });
});

describe("bindTerminalFontLoadingDone", () => {
  it("keeps listening until the terminal font itself is ready", () => {
    let terminalFontReady = false;
    const fonts = fakeFonts(() => terminalFontReady);
    const onLoaded = vi.fn();
    bindTerminalFontLoadingDone(fonts, () => term, onLoaded);

    fonts.fire(); // 界面字体先到
    expect(onLoaded).toHaveBeenCalledTimes(1);
    expect(fonts.size()).toBe(1);

    terminalFontReady = true;
    fonts.fire(); // 终端字体到达
    expect(onLoaded).toHaveBeenCalledTimes(2);
    expect(fonts.size()).toBe(0);
  });

  it("checks the configured font size and family", () => {
    const check = vi.fn(() => true);
    const fonts = fakeFonts(check);
    bindTerminalFontLoadingDone(fonts, () => term, vi.fn());
    fonts.fire();
    expect(check).toHaveBeenCalledWith("14px Maple Mono NF CN, Consolas");
  });

  it("does nothing without a terminal and unbinds on cleanup", () => {
    const fonts = fakeFonts(() => true);
    const onLoaded = vi.fn();
    const unbind = bindTerminalFontLoadingDone(fonts, () => null, onLoaded);
    fonts.fire();
    expect(onLoaded).not.toHaveBeenCalled();
    unbind();
    expect(fonts.size()).toBe(0);
  });
});

describe("bindTerminalFontIfPending", () => {
  it("does not listen when the configured font is already loaded", () => {
    const fonts = fakeFonts(() => true);
    expect(bindTerminalFontIfPending(fonts, () => term, vi.fn())).toBeNull();
    expect(fonts.size()).toBe(0);
  });

  it("listens until a font switched to after startup finally arrives", () => {
    let ready = false;
    const fonts = fakeFonts(() => ready);
    const onLoaded = vi.fn();
    const unbind = bindTerminalFontIfPending(fonts, () => term, onLoaded);
    expect(unbind).not.toBeNull();
    ready = true;
    fonts.fire();
    expect(onLoaded).toHaveBeenCalledTimes(1);
    expect(fonts.size()).toBe(0);
  });
});
