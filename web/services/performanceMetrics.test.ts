import { describe, expect, it } from "vitest";
import { collectTerminalPerformanceMetrics, registerTerminalPerformanceSource, noteTerminalPerformanceResync, type TerminalPerformanceMetric } from "./performanceMetrics";

const metric = (queuedChars: number): TerminalPerformanceMetric => ({ sessionId: `session-${queuedChars}`,
  renderer: "dom", visible: true, queuedChars, inFlightChars: 0, queuedWrites: 1,
  receivedChars: queuedChars, writeCalls: 1, failedWrites: 0, oldestWaitMs: 0, callbackMaxMs: 0,
  hiddenChars: 0, resyncActive: false, contextLosses: 0, atlasClears: 0, scrollbackLines: 50 });

describe("terminal performance registry", () => {
  it("reports an unavailable source without blocking other terminal samples", () => {
    const removeBad = registerTerminalPerformanceSource(() => { throw new Error("disposed terminal"); });
    const removeGood = registerTerminalPerformanceSource(() => metric(1));
    try { expect(collectTerminalPerformanceMetrics()).toMatchObject({ terminalCount: 1, failedTerminalSources: 1 }); }
    finally { removeBad(); removeGood(); }
  });
  it("keeps resync counters bounded and records sizes without retaining replay text", () => {
    const dispose = registerTerminalPerformanceSource(() => ({ ...metric(0), sessionId: "resync-session" }));
    try {
      noteTerminalPerformanceResync("resync-session", 8_000_000);
      noteTerminalPerformanceResync("resync-session", 7_000_000);
      expect(collectTerminalPerformanceMetrics().terminals[0]).toMatchObject({ resyncCount: 2, resyncChars: 15_000_000, resyncLastChars: 7_000_000 });
      for (let i = 0; i < 128; i++) noteTerminalPerformanceResync(`other-${i}`, 1);
      expect(collectTerminalPerformanceMetrics().terminals[0].resyncCount).toBe(0);
    } finally { dispose(); }
  });
  it("bounds reports, prioritizes the largest backlog, and removes unmounted sources", () => {
    const dispose = Array.from({ length: 40 }, (_, i) => registerTerminalPerformanceSource(() => metric(i)));
    try {
      const report = collectTerminalPerformanceMetrics();
      expect(report.terminalCount).toBe(40);
      expect(report.terminals).toHaveLength(32);
      expect(report.terminals[0].queuedChars).toBe(39);
      dispose[39](); dispose[39]();
      expect(collectTerminalPerformanceMetrics().terminalCount).toBe(39);
    } finally { dispose.forEach(remove => remove()); }
    expect(collectTerminalPerformanceMetrics().terminalCount).toBe(0);
  });
});
