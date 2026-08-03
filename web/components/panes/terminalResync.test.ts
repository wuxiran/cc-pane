import { describe, expect, it, vi } from "vitest";
import { resyncFromReplaySnapshot } from "./terminalResync";

function createTerm() {
  return {
    reset: vi.fn(),
    buffer: { active: { type: "normal" as const } },
  };
}

describe("resyncFromReplaySnapshot", () => {
  it("reset 后全量写入快照并同步 buffer 追踪", async () => {
    const term = createTerm();
    const writes: string[] = [];
    const syncTrackedBufferType = vi.fn();

    const resynced = await resyncFromReplaySnapshot({
      term,
      sessionId: "s-1",
      reason: "daemon-desync",
      getReplaySnapshot: async () => ({ data: "SNAPSHOT", bufferMode: "normal" }),
      writeData: async (data) => {
        writes.push(data);
      },
      syncTrackedBufferType,
      debugLog: () => {},
    });

    expect(resynced).toBe(true);
    expect(term.reset).toHaveBeenCalledTimes(1);
    expect(writes).toEqual(["SNAPSHOT"]);
    expect(term.reset.mock.invocationCallOrder[0]).toBeLessThan(
      syncTrackedBufferType.mock.invocationCallOrder[0],
    );
  });

  it("快照缺失时不 reset（残缺画面优于空画面）", async () => {
    const term = createTerm();

    const resynced = await resyncFromReplaySnapshot({
      term,
      sessionId: "s-1",
      reason: "daemon-desync",
      getReplaySnapshot: async () => null,
      writeData: async () => {},
      syncTrackedBufferType: () => {},
      debugLog: () => {},
    });

    expect(resynced).toBe(false);
    expect(term.reset).not.toHaveBeenCalled();
  });

  it("快照请求抛错时不 reset、返回 false", async () => {
    const term = createTerm();

    const resynced = await resyncFromReplaySnapshot({
      term,
      sessionId: "s-1",
      reason: "hibernation-overflow",
      getReplaySnapshot: async () => {
        throw new Error("network down");
      },
      writeData: async () => {},
      syncTrackedBufferType: () => {},
      debugLog: () => {},
    });

    expect(resynced).toBe(false);
    expect(term.reset).not.toHaveBeenCalled();
  });

  it("空数据快照仍 reset（会话确实没有历史）", async () => {
    const term = createTerm();
    const writes: string[] = [];

    const resynced = await resyncFromReplaySnapshot({
      term,
      sessionId: "s-1",
      reason: "daemon-desync",
      getReplaySnapshot: async () => ({ data: "", bufferMode: "normal" }),
      writeData: async (data) => {
        writes.push(data);
      },
      syncTrackedBufferType: () => {},
      debugLog: () => {},
    });

    expect(resynced).toBe(true);
    expect(term.reset).toHaveBeenCalledTimes(1);
    expect(writes).toEqual([]);
  });
});
