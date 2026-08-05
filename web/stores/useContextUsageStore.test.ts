import { beforeEach, describe, expect, it, vi } from "vitest";
import { usageStatsService } from "@/services/usageStatsService";
import { MAX_CONTEXT_USAGE_ENTRIES, useContextUsageStore } from "./useContextUsageStore";
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
      sessions: new Map(),
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

  it("keeps independent snapshots for terminals shown at the same time", async () => {
    vi.spyOn(usageStatsService, "queryContextUsage")
      .mockImplementation(async (sessionId) => snapshot(sessionId));

    await Promise.all([
      useContextUsageStore.getState().loadSession("pty-a"),
      useContextUsageStore.getState().loadSession("pty-b"),
    ]);

    expect(useContextUsageStore.getState().sessions.get("pty-a")?.snapshot?.model).toBe("pty-a");
    expect(useContextUsageStore.getState().sessions.get("pty-b")?.snapshot?.model).toBe("pty-b");
  });

  it("drops the cached entry when a session exits", async () => {
    vi.spyOn(usageStatsService, "queryContextUsage")
      .mockImplementation(async (sessionId) => snapshot(sessionId));

    await useContextUsageStore.getState().load("pty-a");
    expect(useContextUsageStore.getState().sessions.has("pty-a")).toBe(true);

    useContextUsageStore.getState().dropSession("pty-a");
    const state = useContextUsageStore.getState();
    expect(state.sessions.has("pty-a")).toBe(false);
    // 掉的是当前活跃会话：镜像字段也必须一并清空，否则残留旧百分比
    expect(state.snapshot).toBeNull();
    expect(state.lastReady).toBeNull();
  });

  it("caps the cache so long-running instances cannot grow it without bound", async () => {
    vi.spyOn(usageStatsService, "queryContextUsage")
      .mockImplementation(async (sessionId) => snapshot(sessionId));

    useContextUsageStore.getState().setSession("pty-active");
    for (let index = 0; index < MAX_CONTEXT_USAGE_ENTRIES + 20; index += 1) {
      await useContextUsageStore.getState().loadSession(`pty-${index}`);
    }
    await useContextUsageStore.getState().loadSession("pty-active");

    const { sessions } = useContextUsageStore.getState();
    expect(sessions.size).toBeLessThanOrEqual(MAX_CONTEXT_USAGE_ENTRIES);
    // 活跃会话永不被淘汰
    expect(sessions.has("pty-active")).toBe(true);
    // 最旧的条目已被回收
    expect(sessions.has("pty-0")).toBe(false);
  });
});
