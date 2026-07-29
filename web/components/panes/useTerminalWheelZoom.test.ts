import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  TERMINAL_FONT_SIZE_DEFAULT,
  useSettingsStore,
} from "@/stores";
import { attachTerminalWheelZoom } from "./useTerminalWheelZoom";

const updateSettings = vi.fn().mockResolvedValue(undefined);
vi.mock("@/services", () => ({
  settingsService: {
    getSettings: vi.fn(),
    updateSettings: (...args: unknown[]) => updateSettings(...args),
  },
}));

function seedFontSize(fontSize = TERMINAL_FONT_SIZE_DEFAULT) {
  const defaults = useSettingsStore.getState().getDefaults();
  useSettingsStore.setState({
    settings: { ...defaults, terminal: { ...defaults.terminal, fontSize } },
  });
}

function dispatchWheel(target: HTMLElement, init: WheelEventInit): WheelEvent {
  const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

describe("attachTerminalWheelZoom", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    updateSettings.mockClear();
    seedFontSize();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("captures Ctrl+wheel before an inner terminal handler", () => {
    const host = document.createElement("div");
    const inner = document.createElement("div");
    const innerWheel = vi.fn();
    host.appendChild(inner);
    inner.addEventListener("wheel", innerWheel);

    const detach = attachTerminalWheelZoom(host);
    const event = dispatchWheel(inner, { ctrlKey: true, deltaY: -1 });

    expect(event.defaultPrevented).toBe(true);
    expect(innerWheel).not.toHaveBeenCalled();
    expect(useSettingsStore.getState().settings?.terminal.fontSize).toBe(
      TERMINAL_FONT_SIZE_DEFAULT + 1,
    );
    detach();
  });

  it("passes ordinary wheel events through and detaches cleanly", () => {
    const host = document.createElement("div");
    const inner = document.createElement("div");
    const innerWheel = vi.fn();
    host.appendChild(inner);
    inner.addEventListener("wheel", innerWheel);

    const detach = attachTerminalWheelZoom(host);
    dispatchWheel(inner, { deltaY: 1 });
    expect(innerWheel).toHaveBeenCalledTimes(1);
    expect(useSettingsStore.getState().settings?.terminal.fontSize).toBe(
      TERMINAL_FONT_SIZE_DEFAULT,
    );

    detach();
    dispatchWheel(inner, { ctrlKey: true, deltaY: 1 });
    expect(useSettingsStore.getState().settings?.terminal.fontSize).toBe(
      TERMINAL_FONT_SIZE_DEFAULT,
    );
  });
});
