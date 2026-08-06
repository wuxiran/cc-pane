import { beforeEach, describe, expect, it, vi } from "vitest";
import { replayAttachedSession } from "./terminalReplay";
import {
  _resetSeqTrackersForTest,
  anchorCandidate,
} from "./terminalOutputSeqTracker";
import type { TerminalRecoverySnapshot } from "@/types";

function createTerminal(bufferType: "normal" | "alternate" = "normal") {
  return {
    buffer: {
      active: {
        type: bufferType,
      },
    },
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

let terminal = createTerminal();

beforeEach(() => {
  _resetSeqTrackersForTest();
});

describe("replayAttachedSession", () => {
  it("在没有快照时跳过回放", async () => {
    terminal = createTerminal();
    const debugLog = vi.fn();
    const syncTrackedBufferType = vi.fn();

    const writeData = vi.fn().mockResolvedValue(undefined);
    const writeCheckpointData = vi.fn().mockResolvedValue(undefined);

    const result = await replayAttachedSession({
      term: terminal,
      sessionId: "session-1",
      getRecoverySnapshot: vi.fn().mockResolvedValue(null),
      writeData,
      writeCheckpointData,
      syncTrackedBufferType,
      debugLog,
    });

    expect(result).toBeNull();
    expect(writeData).not.toHaveBeenCalled();
    expect(writeCheckpointData).not.toHaveBeenCalled();
    expect(syncTrackedBufferType).not.toHaveBeenCalled();
    expect(debugLog).toHaveBeenCalledWith("session.attach-existing.replay.skip", {
      attachSessionId: "session-1",
      reason: "missing-snapshot",
    });
  });

  it("先写入 delta 再同步 buffer 跟踪状态", async () => {
    terminal = createTerminal();
    const order: string[] = [];
    const debugLog = vi.fn((event: string) => order.push(`log:${event}`));
    const syncTrackedBufferType = vi.fn(() => order.push("sync"));
    const snapshot = recoverySnapshot({
      delta: "\x1b[?1049hhello",
      bufferMode: "alternate",
    });

    const writeData = vi.fn(async (data: string) => {
      order.push("write");
      if (data.includes("\x1b[?1049h")) {
        terminal.buffer.active.type = "alternate";
      }
    });

    const result = await replayAttachedSession({
      term: terminal,
      sessionId: "session-2",
      getRecoverySnapshot: vi.fn().mockResolvedValue(snapshot),
      writeData,
      writeCheckpointData: vi.fn().mockResolvedValue(undefined),
      syncTrackedBufferType,
      debugLog,
    });

    expect(result).toEqual(snapshot);
    expect(order).toEqual([
      "log:session.attach-existing.replay.begin",
      "write",
      "sync",
      "log:session.attach-existing.replay.end",
    ]);
    expect(syncTrackedBufferType).toHaveBeenCalledWith("session.attach-existing.replay");
    expect(debugLog).toHaveBeenLastCalledWith("session.attach-existing.replay.end", {
      attachSessionId: "session-2",
      bufferMode: "alternate",
      deltaLength: snapshot.delta.length,
      bufferAfter: "alternate",
    });
  });

  it("对空快照记录 skip 日志", async () => {
    terminal = createTerminal();
    const debugLog = vi.fn();
    const syncTrackedBufferType = vi.fn();
    const snapshot = recoverySnapshot();

    const writeData = vi.fn().mockResolvedValue(undefined);

    const result = await replayAttachedSession({
      term: terminal,
      sessionId: "session-3",
      getRecoverySnapshot: vi.fn().mockResolvedValue(snapshot),
      writeData,
      writeCheckpointData: vi.fn().mockResolvedValue(undefined),
      syncTrackedBufferType,
      debugLog,
    });

    expect(result).toEqual(snapshot);
    expect(writeData).not.toHaveBeenCalled();
    expect(syncTrackedBufferType).not.toHaveBeenCalled();
    expect(debugLog).toHaveBeenCalledWith("session.attach-existing.replay.skip", {
      attachSessionId: "session-3",
      reason: "empty-snapshot",
      bufferMode: "normal",
    });
  });

  it("双管道（裁决 B）：photo 走 writeCheckpointData 直写、delta 走 writeData，photo 在前", async () => {
    terminal = createTerminal();
    const order: string[] = [];
    const writeData = vi.fn(async (data: string) => {
      order.push(`delta:${data}`);
    });
    const writeCheckpointData = vi.fn(async (data: string) => {
      order.push(`photo:${data}`);
    });
    const snapshot = recoverySnapshot({
      checkpoint: {
        checkpointEpoch: 7,
        anchorSeq: 100,
        snapshotAnsi: "PHOTO-VT",
        bufferMode: "normal",
        cols: 80,
        rows: 24,
        checkpointedAtMs: 1,
      },
      delta: "DELTA-RAW",
      endSeq: 142,
      checkpointEpoch: 7,
    });

    await replayAttachedSession({
      term: terminal,
      sessionId: "session-4",
      getRecoverySnapshot: vi.fn().mockResolvedValue(snapshot),
      writeData,
      writeCheckpointData,
      syncTrackedBufferType: vi.fn(),
      debugLog: vi.fn(),
    });

    // photo 绝不进 delta 管道（serialize 产物是成品 VT，二次渲染会坏），反之亦然
    expect(order).toEqual(["photo:PHOTO-VT", "delta:DELTA-RAW"]);
    expect(writeData).toHaveBeenCalledTimes(1);
    expect(writeCheckpointData).toHaveBeenCalledTimes(1);
  });

  it("epoch≠0 时 reanchor：anchorCandidate 从 null 转有值（上传链路激活钥匙）", async () => {
    terminal = createTerminal();
    expect(anchorCandidate("session-5")).toBeNull();

    await replayAttachedSession({
      term: terminal,
      sessionId: "session-5",
      getRecoverySnapshot: vi.fn().mockResolvedValue(
        recoverySnapshot({ delta: "D", endSeq: 42, checkpointEpoch: 9 }),
      ),
      writeData: vi.fn().mockResolvedValue(undefined),
      writeCheckpointData: vi.fn().mockResolvedValue(undefined),
      syncTrackedBufferType: vi.fn(),
      debugLog: vi.fn(),
    });

    expect(anchorCandidate("session-5")).toEqual({ anchorSeq: 42, checkpointEpoch: 9 });
  });

  it("epoch=0（旧 daemon 回落）不 reanchor：上传保持 dormant", async () => {
    terminal = createTerminal();

    await replayAttachedSession({
      term: terminal,
      sessionId: "session-6",
      getRecoverySnapshot: vi.fn().mockResolvedValue(
        recoverySnapshot({ delta: "D", endSeq: 0, checkpointEpoch: 0 }),
      ),
      writeData: vi.fn().mockResolvedValue(undefined),
      writeCheckpointData: vi.fn().mockResolvedValue(undefined),
      syncTrackedBufferType: vi.fn(),
      debugLog: vi.fn(),
    });

    expect(anchorCandidate("session-6")).toBeNull();
  });

  it("空快照（无 photo 无 delta）也 reanchor：attach 后即可拍照", async () => {
    terminal = createTerminal();

    await replayAttachedSession({
      term: terminal,
      sessionId: "session-7",
      getRecoverySnapshot: vi.fn().mockResolvedValue(
        recoverySnapshot({ endSeq: 5, checkpointEpoch: 3 }),
      ),
      writeData: vi.fn().mockResolvedValue(undefined),
      writeCheckpointData: vi.fn().mockResolvedValue(undefined),
      syncTrackedBufferType: vi.fn(),
      debugLog: vi.fn(),
    });

    expect(anchorCandidate("session-7")).toEqual({ anchorSeq: 5, checkpointEpoch: 3 });
  });
});
