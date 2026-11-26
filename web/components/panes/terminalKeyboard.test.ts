import { describe, expect, it } from "vitest";
import { isTerminalCopyShortcut, isTerminalPasteShortcut } from "./terminalKeyboard";

type ShortcutEvent = Pick<KeyboardEvent, "type" | "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">;

function keyboardEvent(overrides: Partial<ShortcutEvent>): ShortcutEvent {
  return {
    type: "keydown",
    key: "v",
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides,
  };
}

describe("isTerminalPasteShortcut", () => {
  it.each<[string, Partial<ShortcutEvent>, boolean, boolean]>([
    ["handles Ctrl+V on non-mac", { ctrlKey: true }, false, true],
    ["handles Ctrl+Shift+V on non-mac", { ctrlKey: true, shiftKey: true }, false, true],
    ["handles Cmd+V on macOS", { metaKey: true }, true, true],
    ["does not handle Ctrl+V on macOS", { ctrlKey: true }, true, false],
    ["does not handle Ctrl+Alt+V", { ctrlKey: true, altKey: true }, false, false],
    ["ignores keyup events", { type: "keyup", ctrlKey: true }, false, false],
  ])("%s", (_label, overrides, isMac, expected) => {
    expect(isTerminalPasteShortcut(keyboardEvent(overrides), isMac)).toBe(expected);
  });
});

describe("isTerminalCopyShortcut", () => {
  it.each<[string, Partial<ShortcutEvent>, boolean, boolean]>([
    ["handles Ctrl+C on non-mac", { ctrlKey: true }, false, true],
    ["handles the conventional Ctrl+Shift+C terminal copy on non-mac", { ctrlKey: true, shiftKey: true }, false, true],
    ["handles Cmd+C on macOS", { metaKey: true }, true, true],
    ["does not claim Cmd+Shift+C on macOS", { metaKey: true, shiftKey: true }, true, false],
    ["does not handle Ctrl+C on macOS", { ctrlKey: true }, true, false],
    ["does not handle Ctrl+Alt+C", { ctrlKey: true, altKey: true }, false, false],
    ["does not handle bare C", {}, false, false],
    ["ignores keyup events", { type: "keyup", ctrlKey: true }, false, false],
  ])("%s", (_label, overrides, isMac, expected) => {
    expect(isTerminalCopyShortcut(keyboardEvent({ key: "c", ...overrides }), isMac)).toBe(expected);
  });
});
