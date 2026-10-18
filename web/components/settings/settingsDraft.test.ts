import { describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { createSettingsDraft, resetSettingsSection } from "./settingsDraft";

// Match the settings store unit tests: draft reset needs defaults, not live services.
vi.mock("@/services", () => ({ settingsService: {} }));

function fixture() {
  const defaults = createSettingsDraft(useSettingsStore.getState().getDefaults());
  const draft = structuredClone(defaults);
  draft.terminal.fontSize = 27;
  draft.terminal.lowerSessionPriority = false;
  draft.terminal.sessionCpuWeight = 2;
  draft.performance.buildJobs = 7;
  return { defaults, draft };
}

describe("settings section reset ownership", () => {
  it("resets both performance-backed and terminal-backed performance controls", () => {
    const { defaults, draft } = fixture();
    const next = resetSettingsSection(draft, defaults, "performance");
    expect(next.performance).toEqual(defaults.performance);
    expect(next.terminal.lowerSessionPriority).toBe(defaults.terminal.lowerSessionPriority);
    expect(next.terminal.sessionCpuWeight).toBe(defaults.terminal.sessionCpuWeight);
    expect(next.terminal.fontSize).toBe(27);
    expect(draft.terminal.sessionCpuWeight).toBe(2);
  });
  it("terminal reset preserves the policy owned by performance", () => {
    const { defaults, draft } = fixture();
    const next = resetSettingsSection(draft, defaults, "terminal");
    expect(next.terminal.fontSize).toBe(defaults.terminal.fontSize);
    expect(next.terminal.lowerSessionPriority).toBe(false);
    expect(next.terminal.sessionCpuWeight).toBe(2);
    expect(next.performance.buildJobs).toBe(7);
  });
});
