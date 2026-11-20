// Windows/Linux 的 AltGr（= Ctrl+Alt）组字：德语布局 AltGr+7 打 "{"，不能被
// ⌘⌥1..9 / Ctrl+Alt+N 这类快捷键吞掉；键帽字符本身（美式布局 Ctrl+Alt+7 → "7"）照常触发。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleKeydown, isAltGraphText, shouldTerminalHandleKey, useShortcutsStore } from "./useShortcutsStore";
import { useSettingsStore } from "./useSettingsStore";

vi.mock("@/services", () => ({
  settingsService: { getSettings: vi.fn(), updateSettings: vi.fn() },
}));

function keyEvent(key: string, code: string, init: KeyboardEventInit = {}) {
  return new KeyboardEvent("keydown", { key, code, ctrlKey: true, altKey: true, bubbles: true, cancelable: true, ...init });
}

describe("AltGr text guard", () => {
  const handler = vi.fn();
  beforeEach(() => {
    handler.mockReset();
    useShortcutsStore.setState({ actions: new Map(), terminalFocused: false });
    useShortcutsStore.getState().registerAction({ id: "focus-dock-view-7", label: "dock 7", handler });
    useSettingsStore.setState({ settings: { shortcuts: { bindings: { "focus-dock-view-7": "Ctrl+Alt+7" } } } as never });
  });

  it("识别 AltGr 组出的字符", () => {
    expect(isAltGraphText(keyEvent("{", "Digit7"), false)).toBe(true);
    expect(isAltGraphText(keyEvent("7", "Digit7"), false)).toBe(false);
    expect(isAltGraphText(keyEvent("l", "KeyL"), false)).toBe(false);
    // mac 的 ⌥ 组字（⌥7 → "¶"）不是 AltGr，按物理键照常匹配。
    expect(isAltGraphText(keyEvent("¶", "Digit7", { ctrlKey: false, metaKey: true }), true)).toBe(false);
  });

  it("Windows 德语布局 AltGr+7 不触发快捷键、交还给终端", () => {
    const event = keyEvent("{", "Digit7");
    handleKeydown(event, false);
    expect(handler).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    expect(shouldTerminalHandleKey(keyEvent("{", "Digit7"), false)).toBe(true);
  });

  it("美式布局 Ctrl+Alt+7 与 mac ⌘⌥7 照常触发", () => {
    handleKeydown(keyEvent("7", "Digit7"), false);
    handleKeydown(keyEvent("¶", "Digit7", { ctrlKey: false, metaKey: true }), true);
    expect(handler).toHaveBeenCalledTimes(2);
  });
});
