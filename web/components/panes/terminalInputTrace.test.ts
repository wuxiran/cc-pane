import { describe, expect, it, vi } from "vitest";
import {
  attachTerminalInputTrace,
  isMacPlatform,
  isTerminalInputTraceEnabled,
  summarizeTerminalInputData,
  TERMINAL_INPUT_TRACE_STORAGE_KEY,
} from "./terminalInputTrace";

function storageWith(value: string | null): Pick<Storage, "getItem"> {
  return {
    getItem: vi.fn((key: string) => (
      key === TERMINAL_INPUT_TRACE_STORAGE_KEY ? value : null
    )),
  };
}

describe("terminal input trace", () => {
  it("detects mac platforms", () => {
    expect(isMacPlatform("MacIntel")).toBe(true);
    expect(isMacPlatform("iPad")).toBe(true);
    expect(isMacPlatform("Win32")).toBe(false);
    expect(isMacPlatform("Linux x86_64")).toBe(false);
  });

  it("requires dev mode and an enabled storage flag", () => {
    expect(isTerminalInputTraceEnabled({
      isDev: true,
      isMac: true,
      storage: storageWith("1"),
    })).toBe(true);
    expect(isTerminalInputTraceEnabled({
      isDev: true,
      isMac: true,
      storage: storageWith("true"),
    })).toBe(true);
    expect(isTerminalInputTraceEnabled({
      isDev: false,
      isMac: true,
      storage: storageWith("1"),
    })).toBe(false);
    expect(isTerminalInputTraceEnabled({
      isDev: true,
      isMac: false,
      storage: storageWith("1"),
    })).toBe(true);
    expect(isTerminalInputTraceEnabled({
      isDev: true,
      isMac: true,
      storage: storageWith(null),
    })).toBe(false);
  });

  it("summarizes short and long input data", () => {
    expect(summarizeTerminalInputData("!")).toEqual({
      text: "!",
      length: 1,
      codePoints: ["21"],
      truncated: false,
    });
    expect(summarizeTerminalInputData(null)).toEqual({
      text: null,
      length: 0,
      codePoints: [],
    });
    expect(summarizeTerminalInputData("abcdefghijklmnopq")).toEqual({
      text: "abcdefghijklmnop...",
      length: 17,
      codePoints: [
        "61",
        "62",
        "63",
        "64",
        "65",
        "66",
        "67",
        "68",
        "69",
        "6a",
        "6b",
        "6c",
        "6d",
        "6e",
        "6f",
        "70",
      ],
      truncated: true,
    });
  });

  it("does not log when disabled", () => {
    const textarea = document.createElement("textarea");
    const logger = vi.fn();
    const trace = attachTerminalInputTrace({
      textarea,
      isDev: true,
      isMac: true,
      storage: storageWith(null),
      logger,
    });

    textarea.dispatchEvent(new KeyboardEvent("keydown", {
      key: "!",
      code: "Digit1",
      shiftKey: true,
      bubbles: true,
    }));
    trace.onData("!");

    expect(trace.enabled).toBe(false);
    expect(logger).not.toHaveBeenCalled();
  });

  it("logs textarea input events and terminal onData when enabled", () => {
    const textarea = document.createElement("textarea");
    const logger = vi.fn();
    const trace = attachTerminalInputTrace({
      textarea,
      isDev: true,
      isMac: true,
      storage: storageWith("1"),
      logger,
    });

    expect(trace.enabled).toBe(true);
    expect(logger).toHaveBeenCalledWith("input-trace.enabled", expect.objectContaining({
      textarea: expect.objectContaining({
        valueLength: 0,
        value: {
          text: "",
          length: 0,
          codePoints: [],
          truncated: false,
        },
      }),
    }));

    textarea.value = "!";
    textarea.dispatchEvent(new KeyboardEvent("keydown", {
      key: "!",
      code: "Digit1",
      keyCode: 49,
      shiftKey: true,
      bubbles: true,
    } as KeyboardEventInit));
    textarea.dispatchEvent(new InputEvent("beforeinput", {
      inputType: "insertText",
      data: "!",
      isComposing: true,
      bubbles: true,
    }));
    textarea.dispatchEvent(new CompositionEvent("compositionend", {
      data: "!",
      bubbles: true,
    }));
    trace.onData("!");

    expect(logger).toHaveBeenCalledWith("input-trace.keydown", expect.objectContaining({
      key: "!",
      code: "Digit1",
      keyCode: 49,
      shiftKey: true,
      textarea: expect.objectContaining({
        valueLength: 1,
        value: {
          text: "!",
          length: 1,
          codePoints: ["21"],
          truncated: false,
        },
      }),
    }));
    expect(logger).toHaveBeenCalledWith("input-trace.beforeinput", expect.objectContaining({
      inputType: "insertText",
      data: {
        text: "!",
        length: 1,
        codePoints: ["21"],
        truncated: false,
      },
      isComposing: true,
      textarea: expect.objectContaining({
        valueLength: 1,
      }),
    }));
    expect(logger).toHaveBeenCalledWith("input-trace.compositionend", expect.objectContaining({
      data: {
        text: "!",
        length: 1,
        codePoints: ["21"],
        truncated: false,
      },
      textarea: expect.objectContaining({
        valueLength: 1,
      }),
    }));
    expect(logger).toHaveBeenCalledWith("input-trace.onData", expect.objectContaining({
      data: {
        text: "!",
        length: 1,
        codePoints: ["21"],
        truncated: false,
      },
      textarea: expect.objectContaining({
        valueLength: 1,
      }),
    }));
  });

  it("removes listeners on dispose", () => {
    const textarea = document.createElement("textarea");
    const logger = vi.fn();
    const trace = attachTerminalInputTrace({
      textarea,
      isDev: true,
      isMac: true,
      storage: storageWith("1"),
      logger,
    });

    trace.dispose();
    logger.mockClear();
    textarea.dispatchEvent(new KeyboardEvent("keydown", {
      key: "!",
      code: "Digit1",
      shiftKey: true,
      bubbles: true,
    }));

    expect(logger).not.toHaveBeenCalled();
  });
});
