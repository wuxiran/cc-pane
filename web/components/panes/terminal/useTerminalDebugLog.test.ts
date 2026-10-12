import { describe, expect, it } from "vitest";
import { isReleaseDiagnosticEvent, shouldLogReleaseDiagnostic } from "./useTerminalDebugLog";

describe("release diagnostic events", () => {
  it("keeps stall-related events and drops chatter", () => {
    expect(isReleaseDiagnosticEvent("watchdog.write-queue-stuck")).toBe(true);
    expect(isReleaseDiagnosticEvent("watchdog.output-starved.rebind")).toBe(true);
    expect(isReleaseDiagnosticEvent("renderer.changed")).toBe(true);
    expect(isReleaseDiagnosticEvent("renderer.webgl.context-loss")).toBe(true);
    expect(isReleaseDiagnosticEvent("resync.begin")).toBe(true);
    expect(isReleaseDiagnosticEvent("input.xterm.keydown")).toBe(false);
    expect(isReleaseDiagnosticEvent("layout.skip.unchanged")).toBe(false);
    expect(isReleaseDiagnosticEvent("session.adopt-live.begin")).toBe(false);
  });

  it("rate-limits the same event per key", () => {
    const key = `test-${Math.random()}`;
    expect(shouldLogReleaseDiagnostic(key, 1_000, 5_000)).toBe(true);
    expect(shouldLogReleaseDiagnostic(key, 3_000, 5_000)).toBe(false);
    expect(shouldLogReleaseDiagnostic(key, 6_000, 5_000)).toBe(true);
    // 不同 key 互不影响
    expect(shouldLogReleaseDiagnostic(`${key}-other`, 6_100, 5_000)).toBe(true);
  });
});
