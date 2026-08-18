import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  TERMINAL_FONT_SIZE_DEFAULT,
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
  useSettingsStore,
} from "@/stores";
import { attachTerminalWheelZoom, useTerminalWheelZoom } from "./useTerminalWheelZoom";

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
    updateSettings.mockClear();
    seedFontSize();
  });

  it("captures Ctrl+wheel before an inner terminal handler", () => {
    const host = document.createElement("div");
    const inner = document.createElement("div");
    const innerWheel = vi.fn();
    const onZoom = vi.fn();
    host.appendChild(inner);
    inner.addEventListener("wheel", innerWheel);

    const detach = attachTerminalWheelZoom(host, onZoom);
    const event = dispatchWheel(inner, { ctrlKey: true, deltaY: -1 });

    expect(event.defaultPrevented).toBe(true);
    expect(innerWheel).not.toHaveBeenCalled();
    expect(onZoom).toHaveBeenCalledWith(1);
    detach();
  });

  it("passes ordinary wheel events through and detaches cleanly", () => {
    const host = document.createElement("div");
    const inner = document.createElement("div");
    const innerWheel = vi.fn();
    const onZoom = vi.fn();
    host.appendChild(inner);
    inner.addEventListener("wheel", innerWheel);

    const detach = attachTerminalWheelZoom(host, onZoom);
    dispatchWheel(inner, { deltaY: 1 });
    expect(innerWheel).toHaveBeenCalledTimes(1);
    expect(onZoom).not.toHaveBeenCalled();

    detach();
    dispatchWheel(inner, { ctrlKey: true, deltaY: 1 });
    expect(onZoom).not.toHaveBeenCalled();
  });

  it("keeps Ctrl+wheel zoom local to the terminal under the pointer", () => {
    const firstHost = document.createElement("div");
    const secondHost = document.createElement("div");
    const first = renderHook(() => useTerminalWheelZoom({ current: firstHost }, 15));
    const second = renderHook(() => useTerminalWheelZoom({ current: secondHost }, 15));

    act(() => dispatchWheel(firstHost, { ctrlKey: true, deltaY: -1 }));

    expect(first.result.current).toBe(16);
    expect(second.result.current).toBe(15);
    expect(useSettingsStore.getState().settings?.terminal.fontSize).toBe(15);
  });

  it("clamps local zoom and follows later global font-size changes", () => {
    const host = document.createElement("div");
    const view = renderHook(
      ({ configured }) => useTerminalWheelZoom({ current: host }, configured),
      { initialProps: { configured: TERMINAL_FONT_SIZE_MAX } },
    );

    act(() => dispatchWheel(host, { ctrlKey: true, deltaY: -1 }));
    expect(view.result.current).toBe(TERMINAL_FONT_SIZE_MAX);

    view.rerender({ configured: TERMINAL_FONT_SIZE_MIN });
    expect(view.result.current).toBe(TERMINAL_FONT_SIZE_MIN);
    act(() => dispatchWheel(host, { ctrlKey: true, deltaY: 1 }));
    expect(view.result.current).toBe(TERMINAL_FONT_SIZE_MIN);
  });
});
