import { afterEach, expect, it } from "vitest";
import { useSettingsStore } from "@/stores";
import { createTestSettings } from "@/test/utils/testData";
import { DEFAULT_PERFORMANCE_SETTINGS } from "@/types";
import { getParkDelayMs, getParkedTerminalLimit } from "./terminalParkingSettings";

const originalSettings = useSettingsStore.getState().settings;
afterEach(() => useSettingsStore.setState({ settings: originalSettings }));

function configure(parkedTerminalLimit: number, parkDelaySecs: number) {
  useSettingsStore.setState({ settings: createTestSettings({ performance: {
    ...DEFAULT_PERFORMANCE_SETTINGS, parkedTerminalLimit, parkDelaySecs,
  } }) });
}

it("uses safe defaults before settings have loaded", () => {
  useSettingsStore.setState({ settings: null });
  expect(getParkedTerminalLimit()).toBe(6);
  expect(getParkDelayMs()).toBe(30_000);
});

it("uses saved parking limits and converts seconds into an integer timer delay", () => {
  configure(8.9, 45.9);
  expect(getParkedTerminalLimit()).toBe(8);
  expect(getParkDelayMs()).toBe(45_000);
});

it("bounds manually supplied settings and rejects non-finite timer delays", () => {
  for (const [limit, delay, expectedLimit, expectedDelay] of [
    [-100, -10, 2, 5_000], [500, 999, 12, 600_000],
    [Number.NaN, Number.NaN, 6, 30_000], [Infinity, Infinity, 6, 30_000],
  ]) {
    configure(limit, delay);
    expect(getParkedTerminalLimit()).toBe(expectedLimit);
    expect(getParkDelayMs()).toBe(expectedDelay);
  }
});
