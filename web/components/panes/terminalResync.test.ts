import { beforeEach, describe, expect, it, vi } from "vitest";
import { resyncFromReplaySnapshot } from "./terminalResync";
import {
  _resetSeqTrackersForTest,
  anchorCandidate,
} from "./terminalOutputSeqTracker";
import type { TerminalRecoverySnapshot } from "@/types";

function createTerm() {
  return {
    reset: vi.fn(),
    buffer: { active: { type: "normal" as const } },
  };
}

function recoverySnapshot(
  overrides: Partial<TerminalRecoverySnapshot> = {},
): TerminalRecoverySnapshot {
  return {
    checkpoint: null,
    delta: "",
    bufferMode: "normal",
    endSeq: 0,
    checkpointEpoch: 0,
    ...overrides,
  };
}

beforeEach(() => {
  _resetSeqTrackersForTest();
});

describe("resyncFromReplaySnapshot", () => {
  it("reset 后全量写入快照并同步 buffer 追踪", async () => {
    const term = createTerm();
    const writes: string[] = [];
    const syncTrackedBufferType = vi.fn();

    const resynced = await resyncFromReplaySnapshot({
      term,
      sessionId: "s-1",
      reason: "daemon-desync",
      getRecoverySnapshot: async () => recoverySnapshot({ delta: "SNAPSHOT" }),
      writeData: async (data) => {
        writes.push(data);
      },
      writeCheckpointData: async () => {},
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
      getRecoverySnapshot: async () => null,
      writeData: async () => {},
      writeCheckpointData: async () => {},
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
      getRecoverySnapshot: async () => {
        throw new Error("network down");
      },
      writeData: async () => {},
      writeCheckpointData: async () => {},
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
      getRecoverySnapshot: async () => recoverySnapshot(),
      writeData: async (data) => {
        writes.push(data);
      },
      writeCheckpointData: async () => {},
      syncTrackedBufferType: () => {},
      debugLog: () => {},
    });

    expect(resynced).toBe(true);
    expect(term.reset).toHaveBeenCalledTimes(1);
    expect(writes).toEqual([]);
  });

  it("双管道序（裁决 B）：reset → photo 直写 → delta 渲染写 → sync", async () => {
    const term = {
      reset: vi.fn(() => order.push("reset")),
      buffer: { active: { type: "normal" as const } },
    };
    const order: string[] = [];
    const syncTrackedBufferType = vi.fn(() => order.push("sync"));

    const resynced = await resyncFromReplaySnapshot({
      term,
      sessionId: "s-2",
      reason: "daemon-desync",
      getRecoverySnapshot: async () =>
        recoverySnapshot({
          checkpoint: {
            checkpointEpoch: 4,
            anchorSeq: 10,
            snapshotAnsi: "PHOTO-VT",
            bufferMode: "normal",
            cols: 80,
            rows: 24,
            checkpointedAtMs: 1,
          },
          delta: "DELTA-RAW",
          endSeq: 20,
          checkpointEpoch: 4,
        }),
      writeData: async (data) => {
        order.push(`delta:${data}`);
      },
      writeCheckpointData: async (data) => {
        order.push(`photo:${data}`);
      },
      syncTrackedBufferType,
      debugLog: () => {},
    });

    expect(resynced).toBe(true);
    // photo 绝不过 delta（render）管道，且序固定：reset → photo → delta → sync
    expect(order).toEqual(["reset", "photo:PHOTO-VT", "delta:DELTA-RAW", "sync"]);
  });

  it("epoch≠0 时 resync 后 reanchor（恢复可拍）", async () => {
    const term = createTerm();
    expect(anchorCandidate("s-3")).toBeNull();

    await resyncFromReplaySnapshot({
      term,
      sessionId: "s-3",
      reason: "daemon-desync",
      getRecoverySnapshot: async () =>
        recoverySnapshot({ delta: "D", endSeq: 33, checkpointEpoch: 6 }),
      writeData: async () => {},
      writeCheckpointData: async () => {},
      syncTrackedBufferType: () => {},
      debugLog: () => {},
    });

    expect(anchorCandidate("s-3")).toEqual({ anchorSeq: 33, checkpointEpoch: 6 });
  });

  it("epoch=0（旧 daemon 回落）不 reanchor", async () => {
    const term = createTerm();

    await resyncFromReplaySnapshot({
      term,
      sessionId: "s-4",
      reason: "daemon-desync",
      getRecoverySnapshot: async () => recoverySnapshot({ delta: "D" }),
      writeData: async () => {},
      writeCheckpointData: async () => {},
      syncTrackedBufferType: () => {},
      debugLog: () => {},
    });

    expect(anchorCandidate("s-4")).toBeNull();
  });
});
