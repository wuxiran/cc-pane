import { describe, expect, it } from "vitest";
import {
  DEFAULT_STATUS_COLOR_TOKEN,
  TERMINAL_STATUS_PRESENTATION,
  TERMINAL_STATUS_TYPES,
  isStatusPulsing,
  severityRank,
  statusColorToken,
  statusLabelKey,
} from "./statusPresentation";
import type { TerminalStatusType } from "@/types";

const ALL_TERMINAL_STATUSES: TerminalStatusType[] = [
  "initializing",
  "idle",
  "thinking",
  "toolRunning",
  "compacting",
  "waitingInput",
  "error",
  "exited",
  "active",
];

describe("statusPresentation", () => {
  it("covers every terminal status exactly once", () => {
    expect([...TERMINAL_STATUS_TYPES].sort()).toEqual([...ALL_TERMINAL_STATUSES].sort());
    expect(Object.keys(TERMINAL_STATUS_PRESENTATION).sort()).toEqual([...ALL_TERMINAL_STATUSES].sort());
  });

  it("gives every status a dialogs label key and severity rank", () => {
    for (const status of ALL_TERMINAL_STATUSES) {
      const presentation = TERMINAL_STATUS_PRESENTATION[status];
      expect(presentation.labelKey, `${status} missing label`).toMatch(/^status/);
      expect(presentation.severityRank, `${status} missing rank`).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(presentation.severityRank)).toBe(true);
    }
  });

  it("keeps all color values on app CSS tokens", () => {
    for (const status of ALL_TERMINAL_STATUSES) {
      expect(TERMINAL_STATUS_PRESENTATION[status].colorToken, `${status} color`).toMatch(/^var\(--app-[^)]+\)$/);
    }
    expect(statusColorToken(null)).toBe(DEFAULT_STATUS_COLOR_TOKEN);
  });

  it("preserves shared pulse semantics", () => {
    expect(isStatusPulsing("toolRunning")).toBe(true);
    expect(isStatusPulsing("compacting")).toBe(true);
    expect(isStatusPulsing("initializing")).toBe(true);
    expect(isStatusPulsing("thinking")).toBe(false);
  });

  it("preserves workspace severity ordering", () => {
    expect(severityRank("error")).toBeLessThan(severityRank("waitingInput"));
    expect(severityRank("waitingInput")).toBeLessThan(severityRank("toolRunning"));
    expect(severityRank("toolRunning")).toBeLessThan(severityRank("idle"));
    expect(severityRank(null)).toBeGreaterThan(severityRank("exited"));
  });

  it("exposes layout shapes without changing the existing visual encoding", () => {
    expect(TERMINAL_STATUS_PRESENTATION.error.shape).toBe("triangle");
    expect(TERMINAL_STATUS_PRESENTATION.waitingInput.shape).toBe("diamond");
    expect(TERMINAL_STATUS_PRESENTATION.active.shape).toBe("circle");
    expect(TERMINAL_STATUS_PRESENTATION.idle.filled).toBe(false);
  });

  it("returns null label for unknown status slots", () => {
    expect(statusLabelKey(null)).toBeNull();
  });
});
