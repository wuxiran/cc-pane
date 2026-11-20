import { describe, expect, it } from "vitest";
import {
  isSecondaryTerminalView,
  markSecondaryTerminalView,
  recordRecoveryFloor,
  takeRecoveryFloor,
} from "./terminalViewOwnership";

describe("terminal view ownership", () => {
  it("treats unregistered terminals as the primary view", () => {
    const primary = {};
    const mirror = {};
    markSecondaryTerminalView(mirror);
    expect(isSecondaryTerminalView(primary)).toBe(false);
    expect(isSecondaryTerminalView(mirror)).toBe(true);
    expect(isSecondaryTerminalView(null)).toBe(false);
  });

  it("keeps each view's recovery floor separate and hands it out once", () => {
    const primary = {};
    const mirror = {};
    recordRecoveryFloor(primary, 200);
    recordRecoveryFloor(mirror, 120);
    expect(takeRecoveryFloor(mirror)).toBe(120);
    expect(takeRecoveryFloor(mirror)).toBeNull();
    expect(takeRecoveryFloor(primary)).toBe(200);
    expect(takeRecoveryFloor(null)).toBeNull();
  });

  it("ignores a floor that has gone stale", () => {
    const term = {};
    recordRecoveryFloor(term, 120, 1_000);
    expect(takeRecoveryFloor(term, 1_000 + 60_000)).toBeNull();
  });
});
