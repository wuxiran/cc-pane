import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  TERMINAL_FONT_SIZE_DEFAULT,
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
  useSettingsStore,
} from "./useSettingsStore";

const updateSettings = vi.fn().mockResolvedValue(undefined);
vi.mock("@/services", () => ({
  settingsService: {
    getSettings: vi.fn(),
    updateSettings: (...args: unknown[]) => updateSettings(...args),
  },
}));

function seed(fontSize: number) {
  const defaults = useSettingsStore.getState().getDefaults();
  useSettingsStore.setState({
    settings: { ...defaults, terminal: { ...defaults.terminal, fontSize } },
  });
}

const size = () => useSettingsStore.getState().settings!.terminal.fontSize;

describe("setTerminalFontSize", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    updateSettings.mockClear();
    seed(TERMINAL_FONT_SIZE_DEFAULT);
  });

  it("updates memory immediately so the terminal tracks the wheel", () => {
    useSettingsStore.getState().setTerminalFontSize(TERMINAL_FONT_SIZE_DEFAULT + 2);
    expect(size()).toBe(TERMINAL_FONT_SIZE_DEFAULT + 2);
  });

  it("clamps to the supported range instead of drifting off", () => {
    useSettingsStore.getState().setTerminalFontSize(999);
    expect(size()).toBe(TERMINAL_FONT_SIZE_MAX);
    useSettingsStore.getState().setTerminalFontSize(-5);
    expect(size()).toBe(TERMINAL_FONT_SIZE_MIN);
  });

  it("does not hit disk on every wheel tick, and persists once after settling", async () => {
    for (let i = 1; i <= 12; i += 1) {
      useSettingsStore.getState().setTerminalFontSize(TERMINAL_FONT_SIZE_DEFAULT + i);
    }
    // 滚动过程中一次 IPC 都不该发
    expect(updateSettings).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);
    expect(updateSettings).toHaveBeenCalledTimes(1);
    // 落盘的是最终值，不是中间某一帧
    expect(updateSettings.mock.calls[0][0].terminal.fontSize).toBe(
      TERMINAL_FONT_SIZE_DEFAULT + 12,
    );
  });

  it("ignores no-op writes so an at-limit wheel does not schedule persistence", async () => {
    useSettingsStore.getState().setTerminalFontSize(TERMINAL_FONT_SIZE_MAX);
    await vi.advanceTimersByTimeAsync(500);
    updateSettings.mockClear();

    useSettingsStore.getState().setTerminalFontSize(TERMINAL_FONT_SIZE_MAX + 5);
    await vi.advanceTimersByTimeAsync(500);
    expect(updateSettings).not.toHaveBeenCalled();
  });
});
