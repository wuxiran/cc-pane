import { beforeEach, describe, expect, it, vi } from "vitest";
import { usageStatsService } from "@/services/usageStatsService";
import { useContextUsageStore } from "./useContextUsageStore";
import type { ContextUsageSnapshot } from "@/types/contextUsage";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function snapshot(sessionId: string): ContextUsageSnapshot {
  return {
    status: "ready",
    usedTokens: 1,
    effectiveUsedTokens: 1,
    windowTokens: 100,
    effectiveWindowTokens: 100,
    usedPercentage: 1,
    remainingPercentage: 99,
    model: sessionId,
    usageSource: "fixture",
    windowSource: "fixture",
    agentSessionId: sessionId,
    parserVersion: "test",
    observedAt: Date.now(),
    diagnosticCode: null,
  };
}

describe("useContextUsageStore", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useContextUsageStore.setState({
      sessionId: null,
      snapshot: null,
      lastReady: null,
      loading: false,
      requestId: 0,
    });
  });

  it("drops a late response from the previous active session", async () => {
    const oldRequest = deferred<ContextUsageSnapshot>();
    const newRequest = deferred<ContextUsageSnapshot>();
    vi.spyOn(usageStatsService, "queryContextUsage")
      .mockReturnValueOnce(oldRequest.promise)
      .mockReturnValueOnce(newRequest.promise);

    const oldLoad = useContextUsageStore.getState().load("old-pty");
    const newLoad = useContextUsageStore.getState().load("new-pty");
    oldRequest.resolve(snapshot("old"));
    await oldLoad;
    expect(useContextUsageStore.getState().snapshot).toBeNull();

    newRequest.resolve(snapshot("new"));
    await newLoad;
    expect(useContextUsageStore.getState().snapshot?.model).toBe("new");
  });
});
