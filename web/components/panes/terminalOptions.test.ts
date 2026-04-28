import { describe, expect, it } from "vitest";
import type { TerminalSettings } from "@/types";
import {
  DEFAULT_TERMINAL_DISPLAY_OPTIONS,
  applyTerminalDisplayOptions,
  resolveTerminalDisplayOptions,
} from "./terminalOptions";

function createTerminalSettings(overrides: Partial<TerminalSettings> = {}): TerminalSettings {
  return {
    fontSize: 14,
    fontFamily: "monospace",
    cursorStyle: "block",
    cursorBlink: true,
    scrollback: 1000,
    shell: null,
    disableConptySanitize: null,
    ...overrides,
  };
}

describe("terminalOptions", () => {
  it("uses terminal display settings for xterm options", () => {
    expect(
      resolveTerminalDisplayOptions(
        createTerminalSettings({
          fontSize: 18,
          fontFamily: "JetBrains Mono",
          cursorStyle: "bar",
          cursorBlink: false,
          scrollback: 5000,
        })
      )
    ).toEqual({
      fontSize: 18,
      fontFamily: "JetBrains Mono",
      cursorStyle: "bar",
      cursorBlink: false,
      scrollback: 5000,
    });
  });

  it("falls back to safe defaults for invalid terminal display settings", () => {
    expect(
      resolveTerminalDisplayOptions({
        fontSize: 0,
        fontFamily: "",
        cursorStyle: "invalid",
        cursorBlink: true,
        scrollback: 0,
      } as TerminalSettings)
    ).toEqual(DEFAULT_TERMINAL_DISPLAY_OPTIONS);
  });

  it("applies changed display options to an existing terminal", () => {
    const terminal = {
      options: {
        fontSize: 14,
        fontFamily: "monospace",
        cursorStyle: "block",
        cursorBlink: true,
        scrollback: 1000,
      },
    };

    const changed = applyTerminalDisplayOptions(
      terminal,
      resolveTerminalDisplayOptions(
        createTerminalSettings({
          fontSize: 16,
          fontFamily: "Cascadia Code",
          cursorStyle: "underline",
          cursorBlink: false,
          scrollback: 2000,
        })
      )
    );

    expect(changed).toBe(true);
    expect(terminal.options).toEqual({
      fontSize: 16,
      fontFamily: "Cascadia Code",
      cursorStyle: "underline",
      cursorBlink: false,
      scrollback: 2000,
    });
  });
});
