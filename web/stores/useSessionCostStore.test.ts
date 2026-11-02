import { beforeEach, describe, expect, it, vi } from "vitest";
import { usageStatsService } from "@/services/usageStatsService";
import type { SessionCostSnapshot } from "@/types/sessionCost";
import { MAX_SESSION_COST_ENTRIES, useSessionCostStore } from "./useSessionCostStore";

vi.mock("@/services/usageStatsService", () => ({
  usageStatsService: { querySessionCost: vi.fn() },
}));

const query = vi.mocked(usageStatsService.querySessionCost);

function snapshot(overrides: Partial<SessionCostSnapshot> = {}): SessionCostSnapshot {
  return {
    status: "ready",
    costUsd: 1.5,
    hasUnpricedUsage: false,
    inputTokens: 1,
    outputTokens: 2,
    cacheReadTokens: 3,
    cacheWriteTokens: 4,
    models: [],
    pricingAsOf: "2026-11-02",
    agentSessionId: "agent-1",
    observedAt: 1,
    diagnosticCode: null,
    ...overrides,
  };
}

function entry(sessionId: string) {
  return useSessionCostStore.getState().sessions.get(sessionId);
}

describe("useSessionCostStore", () => {
  beforeEach(() => {
    query.mockReset();
    useSessionCostStore.setState({ sessions: new Map() });
  });

  it("stores the snapshot per session", async () => {
    query.mockResolvedValueOnce(snapshot());
    await useSessionCostStore.getState().loadSession("s1");
    expect(entry("s1")?.snapshot?.costUsd).toBe(1.5);
    expect(entry("s1")?.loading).toBe(false);
    expect(entry("s2")).toBeUndefined();
  });

  it("keeps the last total through a transient read failure", async () => {
    query.mockResolvedValueOnce(snapshot());
    await useSessionCostStore.getState().loadSession("s1");

    query.mockResolvedValueOnce(snapshot({
      status: "error",
      costUsd: null,
      diagnosticCode: "SOURCE_UNAVAILABLE",
    }));
    await useSessionCostStore.getState().loadSession("s1");
    expect(entry("s1")?.snapshot?.costUsd).toBe(1.5);

    query.mockRejectedValueOnce(new Error("ipc down"));
    await useSessionCostStore.getState().loadSession("s1");
    expect(entry("s1")?.snapshot?.costUsd).toBe(1.5);
  });

  it("drops the old total when the agent session changes", async () => {
    query.mockResolvedValueOnce(snapshot());
    await useSessionCostStore.getState().loadSession("s1");

    query.mockResolvedValueOnce(snapshot({
      status: "waiting",
      costUsd: null,
      agentSessionId: "agent-2",
      diagnosticCode: "WAITING_FIRST_RESPONSE",
    }));
    await useSessionCostStore.getState().loadSession("s1");
    expect(entry("s1")?.snapshot?.costUsd).toBeNull();
  });

  it("drops the old total when the session can no longer be found", async () => {
    query.mockResolvedValueOnce(snapshot());
    await useSessionCostStore.getState().loadSession("s1");

    query.mockResolvedValueOnce(snapshot({
      status: "error",
      costUsd: null,
      diagnosticCode: "SESSION_NOT_FOUND",
    }));
    await useSessionCostStore.getState().loadSession("s1");
    expect(entry("s1")?.snapshot?.costUsd).toBeNull();
  });

  it("sends one request while another is in flight", async () => {
    let resolve: (value: SessionCostSnapshot) => void = () => undefined;
    query.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const first = useSessionCostStore.getState().loadSession("s1");
    await useSessionCostStore.getState().loadSession("s1");
    expect(query).toHaveBeenCalledTimes(1);
    resolve(snapshot());
    await first;
    expect(entry("s1")?.snapshot?.costUsd).toBe(1.5);
  });

  it("ignores a response for a session dropped while loading", async () => {
    let resolve: (value: SessionCostSnapshot) => void = () => undefined;
    query.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const pending = useSessionCostStore.getState().loadSession("s1");
    useSessionCostStore.getState().dropSession("s1");
    resolve(snapshot());
    await pending;
    expect(entry("s1")).toBeUndefined();
  });

  it("evicts the least recently polled session over the limit", async () => {
    query.mockResolvedValue(snapshot());
    for (let index = 0; index <= MAX_SESSION_COST_ENTRIES; index += 1) {
      await useSessionCostStore.getState().loadSession(`s${index}`);
    }
    const { sessions } = useSessionCostStore.getState();
    expect(sessions.size).toBe(MAX_SESSION_COST_ENTRIES);
    expect(sessions.has("s0")).toBe(false);
    expect(sessions.has(`s${MAX_SESSION_COST_ENTRIES}`)).toBe(true);
  });
});
