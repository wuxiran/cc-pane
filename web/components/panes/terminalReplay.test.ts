import { describe, expect, it, vi } from "vitest";
import { replayAttachedSession } from "./terminalReplay";
import type { TerminalReplaySnapshot } from "@/services/terminalService";

function createTerminal(bufferType: "normal" | "alternate" = "normal") {
  const term = {
    buffer: {
      active: {
        type: bufferType,
      },
    },
    write: vi.fn((data: string, callback?: () => void) => {
      if (data.includes("\x1b[?1049h")) {
        term.buffer.active.type = "alternate";
      }
      callback?.();
    }),
  };
  return term;
}

let terminal = createTerminal();

describe("replayAttachedSession", () => {
  it("在没有快照时跳过回放", async () => {
    terminal = createTerminal();
    const debugLog = vi.fn();
    const syncTrackedBufferType = vi.fn();

    const result = await replayAttachedSession({
      term: terminal,
      sessionId: "session-1",
      getReplaySnapshot: vi.fn().mockResolvedValue(null),
      syncTrackedBufferType,
      debugLog,
    });

    expect(result).toBeNull();
    expect(terminal.write).not.toHaveBeenCalled();
    expect(syncTrackedBufferType).not.toHaveBeenCalled();
    expect(debugLog).toHaveBeenCalledWith("session.attach-existing.replay.skip", {
      attachSessionId: "session-1",
      reason: "missing-snapshot",
    });
  });

  it("先写入快照再同步 buffer 跟踪状态", async () => {
    terminal = createTerminal();
    const order: string[] = [];
    const debugLog = vi.fn((event: string) => order.push(`log:${event}`));
    const syncTrackedBufferType = vi.fn(() => order.push("sync"));
    const snapshot: TerminalReplaySnapshot = {
      data: "\x1b[?1049hhello",
      bufferMode: "alternate",
    };

    terminal.write = vi.fn((data: string, callback?: () => void) => {
      order.push("write");
      if (data.includes("\x1b[?1049h")) {
        terminal.buffer.active.type = "alternate";
      }
      callback?.();
    });

    const result = await replayAttachedSession({
      term: terminal,
      sessionId: "session-2",
      getReplaySnapshot: vi.fn().mockResolvedValue(snapshot),
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
      dataLength: snapshot.data.length,
      bufferAfter: "alternate",
    });
  });

  it("对空快照记录 skip 日志", async () => {
    terminal = createTerminal();
    const debugLog = vi.fn();
    const syncTrackedBufferType = vi.fn();
    const snapshot: TerminalReplaySnapshot = {
      data: "",
      bufferMode: "normal",
    };

    const result = await replayAttachedSession({
      term: terminal,
      sessionId: "session-3",
      getReplaySnapshot: vi.fn().mockResolvedValue(snapshot),
      syncTrackedBufferType,
      debugLog,
    });

    expect(result).toEqual(snapshot);
    expect(terminal.write).not.toHaveBeenCalled();
    expect(syncTrackedBufferType).not.toHaveBeenCalled();
    expect(debugLog).toHaveBeenCalledWith("session.attach-existing.replay.skip", {
      attachSessionId: "session-3",
      reason: "empty-snapshot",
      bufferMode: "normal",
    });
  });
});
