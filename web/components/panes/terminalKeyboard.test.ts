import { describe, expect, it } from "vitest";
import { isTerminalCopyShortcut, isTerminalPasteShortcut } from "./terminalKeyboard";

function keyboardEvent(
  overrides: Partial<KeyboardEvent>,
): Pick<KeyboardEvent, "type" | "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey"> {
  return {
    type: "keydown",
    key: "v",
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides,
  } as KeyboardEvent;
}

describe("isTerminalPasteShortcut", () => {
  it("handles Ctrl+V on non-mac platforms", () => {
    expect(isTerminalPasteShortcut(keyboardEvent({ ctrlKey: true }), false)).toBe(true);
  });

  it("handles Ctrl+Shift+V on non-mac platforms", () => {
    expect(
      isTerminalPasteShortcut(
        keyboardEvent({ ctrlKey: true, shiftKey: true }),
        false,
      ),
    ).toBe(true);
  });

  it("handles Cmd+V on macOS", () => {
    expect(isTerminalPasteShortcut(keyboardEvent({ metaKey: true }), true)).toBe(true);
  });

  it("does not handle Ctrl+V on macOS", () => {
    expect(isTerminalPasteShortcut(keyboardEvent({ ctrlKey: true }), true)).toBe(false);
  });

  it("does not handle Alt+V", () => {
    expect(
      isTerminalPasteShortcut(
        keyboardEvent({ ctrlKey: true, altKey: true }),
        false,
      ),
    ).toBe(false);
  });

  it("ignores keyup events", () => {
    expect(
      isTerminalPasteShortcut(
        keyboardEvent({ type: "keyup", ctrlKey: true }),
        false,
      ),
    ).toBe(false);
  });
});

describe("isTerminalCopyShortcut", () => {
  const copyEvent = (overrides: Partial<KeyboardEvent>) =>
    keyboardEvent({ key: "c", ...overrides });

  it("handles Ctrl+C on non-mac platforms", () => {
    expect(isTerminalCopyShortcut(copyEvent({ ctrlKey: true }), false)).toBe(true);
  });

  it("handles the conventional Ctrl+Shift+C terminal copy on non-mac platforms", () => {
    expect(
      isTerminalCopyShortcut(copyEvent({ ctrlKey: true, shiftKey: true }), false),
    ).toBe(true);
  });

  it("handles Cmd+C on macOS", () => {
    expect(isTerminalCopyShortcut(copyEvent({ metaKey: true }), true)).toBe(true);
  });

  it("does not claim Cmd+Shift+C on macOS", () => {
    expect(
      isTerminalCopyShortcut(copyEvent({ metaKey: true, shiftKey: true }), true),
    ).toBe(false);
  });

  it("does not handle Ctrl+C on macOS", () => {
    expect(isTerminalCopyShortcut(copyEvent({ ctrlKey: true }), true)).toBe(false);
  });

  it("does not handle Alt+C or bare C", () => {
    expect(
      isTerminalCopyShortcut(copyEvent({ ctrlKey: true, altKey: true }), false),
    ).toBe(false);
    expect(isTerminalCopyShortcut(copyEvent({}), false)).toBe(false);
  });

  it("ignores keyup events", () => {
    expect(
      isTerminalCopyShortcut(copyEvent({ type: "keyup", ctrlKey: true }), false),
    ).toBe(false);
  });
});
