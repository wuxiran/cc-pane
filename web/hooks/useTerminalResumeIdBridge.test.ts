import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTerminalResumeIdBridge } from "./useTerminalResumeIdBridge";
import { usePanesStore } from "@/stores";
import { listenIfTauri } from "@/services/runtime";
import { usageStatsService } from "@/services/usageStatsService";
import { useContextUsageStore } from "@/stores/useContextUsageStore";
import { useSessionCostStore } from "@/stores/useSessionCostStore";
import type { ContextUsageSnapshot } from "@/types/contextUsage";
import type { SessionCostSnapshot } from "@/types/sessionCost";

vi.mock("@/stores", () => ({ usePanesStore: { getState: vi.fn() } }));
vi.mock("@/services/runtime", () => ({ listenIfTauri: vi.fn() }));

type Handler = (event: { payload: unknown }) => void;

function setup() {
  let handler: Handler | undefined;
  vi.mocked(listenIfTauri).mockImplementation(async (_event, cb) => {
    handler = cb as Handler;
    return () => {};
  });
  vi.mocked(usePanesStore.getState).mockReturnValue({
    updateTabAgentResumeId: vi.fn(() => true),
    markTerminalLaunchFailed: vi.fn(),
  } as unknown as ReturnType<typeof usePanesStore.getState>);
  return () => handler;
}

const ready = (agentSessionId: string, usedPercentage: number) =>
  ({ status: "ready", agentSessionId, usedPercentage }) as ContextUsageSnapshot;

describe("useTerminalResumeIdBridge — /clear usage refresh (issue #64 item 9)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useContextUsageStore.setState({ sessionId: null, snapshot: null, lastReady: null, sessions: new Map() });
    useSessionCostStore.setState({ sessions: new Map() });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("re-queries usage and cost as soon as the post-clear identity arrives", async () => {
    const getHandler = setup();
    const contextQuery = vi.spyOn(usageStatsService, "queryContextUsage")
      .mockResolvedValue(ready("new-agent", 8));
    const costQuery = vi.spyOn(usageStatsService, "querySessionCost")
      .mockResolvedValue({ status: "waiting" } as SessionCostSnapshot);
    const old = ready("old-agent", 81);
    useContextUsageStore.setState({
      sessionId: "pty-1", snapshot: old, lastReady: old,
      sessions: new Map([["pty-1", { snapshot: old, lastReady: old, loading: false, requestId: 1 }]]),
    });
    useSessionCostStore.setState({ sessions: new Map([["pty-1", {
      snapshot: { status: "ready" } as SessionCostSnapshot, loading: false, requestId: 1,
    }]]) });
    const { unmount } = renderHook(() => useTerminalResumeIdBridge());
    await vi.waitFor(() => expect(getHandler()).toBeDefined());

    getHandler()!({ payload: { ptySessionId: "pty-1", resumeSessionId: null, oldResumeSessionId: "old-agent" } });
    expect(useContextUsageStore.getState().snapshot).toBeNull();
    expect(useSessionCostStore.getState().sessions.has("pty-1")).toBe(false);
    expect(contextQuery).not.toHaveBeenCalled();

    getHandler()!({ payload: { ptySessionId: "pty-1", resumeSessionId: "new-agent", resumeSource: "hook" } });
    expect(contextQuery).toHaveBeenCalledWith("pty-1");
    await vi.waitFor(() => expect(useContextUsageStore.getState().snapshot?.usedPercentage).toBe(8));
    // Cost was dropped on clear, so it is no longer tracked; the next poll recreates it.
    expect(costQuery).not.toHaveBeenCalled();
    unmount();
  });

  it("drops and re-queries a stale cost when resume switches identity directly", async () => {
    const getHandler = setup();
    vi.spyOn(usageStatsService, "queryContextUsage").mockResolvedValue(ready("next", 3));
    const costQuery = vi.spyOn(usageStatsService, "querySessionCost")
      .mockResolvedValue({ status: "waiting" } as SessionCostSnapshot);
    useSessionCostStore.setState({ sessions: new Map([["pty-2", {
      snapshot: { status: "ready" } as SessionCostSnapshot, loading: false, requestId: 1,
    }]]) });
    const { unmount } = renderHook(() => useTerminalResumeIdBridge());
    await vi.waitFor(() => expect(getHandler()).toBeDefined());

    getHandler()!({ payload: { ptySessionId: "pty-2", resumeSessionId: "next" } });
    expect(costQuery).toHaveBeenCalledWith("pty-2");
    await vi.waitFor(() =>
      expect(useSessionCostStore.getState().sessions.get("pty-2")?.snapshot?.status).toBe("waiting"));
    unmount();
  });

  it("does not start polling sessions nobody is watching", async () => {
    const getHandler = setup();
    const contextQuery = vi.spyOn(usageStatsService, "queryContextUsage");
    const { unmount } = renderHook(() => useTerminalResumeIdBridge());
    await vi.waitFor(() => expect(getHandler()).toBeDefined());

    getHandler()!({ payload: { ptySessionId: "pty-unwatched", resumeSessionId: "fresh" } });
    expect(contextQuery).not.toHaveBeenCalled();
    expect(useContextUsageStore.getState().sessions.has("pty-unwatched")).toBe(false);
    unmount();
  });
});
