// 重同步闸门期的实时输出与快照对账（端到端走 bindTerminalSessionCallbacks）。
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import type { TerminalRecoverySnapshot } from "@/types";

const service = vi.hoisted(() => ({
  output: null as ((data: string, endSeq?: number) => void) | null,
  desync: null as (() => Promise<boolean>) | null,
  snapshot: null as (() => Promise<TerminalRecoverySnapshot | null>) | null,
}));

vi.mock("@/services/terminalService", () => ({
  clearTerminalOutputDesyncLatch: vi.fn(),
  terminalService: {
    registerOutput: vi.fn(async (_id: string, callback: (data: string, endSeq?: number) => void) => {
      service.output = callback;
      return () => {};
    }),
    registerExit: vi.fn(async () => () => {}),
    registerDesync: vi.fn(async (_id: string, handler: () => Promise<boolean>) => {
      service.desync = handler;
      return () => {};
    }),
    registerHiddenTerminalQueryHandler: vi.fn(() => () => {}),
  },
}));
vi.mock("@/services/terminalRecovery", () => ({
  getRecoverySnapshot: vi.fn(() => service.snapshot!()),
}));
vi.mock("@/services/terminalCheckpoint", () => ({
  registerCheckpointRequest: vi.fn(async () => () => {}),
}));
vi.mock("./terminalCheckpointUpload", () => ({
  captureAndUploadCheckpoint: vi.fn(async () => {}),
}));

import { bindTerminalSessionCallbacks } from "./terminalSessionBinding";
import { _resetSeqTrackersForTest, anchorCandidate } from "./terminalOutputSeqTracker";

function snapshotOf(overrides: Partial<TerminalRecoverySnapshot>): TerminalRecoverySnapshot {
  return { checkpoint: null, delta: "", bufferMode: "normal", endSeq: 0, checkpointEpoch: "0", ...overrides };
}

async function bind() {
  const writes: string[] = [];
  const renderTerminalData = vi.fn((data: string, _options?: { discontinuity?: boolean }) => data);
  const resyncActiveRef = { current: false };
  const term = { reset: vi.fn(() => writes.push("<reset>")), buffer: { active: { type: "normal" } } };
  await bindTerminalSessionCallbacks("s-gate", {
    terminalInstanceRef: { current: term as unknown as Terminal },
    hiddenWriteBufferRef: { current: null },
    layoutSchedulerRef: { current: null },
    outputUnsubRef: { current: null },
    exitUnsubRef: { current: null },
    desyncUnsubRef: { current: null },
    isRenderVisible: () => true,
    keepCliOutputInNormalBuffer: false,
    renderTerminalData,
    renderCheckpointData: (data) => data,
    writeTerminalData: async (data, onWritten) => {
      writes.push(data);
      onWritten?.();
    },
    syncTrackedBufferType: () => {},
    unbindSessionCallbacks: () => {},
    onSessionExit: () => {},
    resyncActiveRef,
    overflowResyncRef: { current: null },
    flushHiddenWrites: async () => "ready",
    pendingExitRef: { current: null },
    debugLog: () => {},
  });
  return { writes, renderTerminalData, resyncActiveRef };
}

beforeEach(() => {
  _resetSeqTrackersForTest();
  service.output = null;
  service.desync = null;
  service.snapshot = null;
});

describe("resync gate backlog reconciliation", () => {
  it("writes only what the snapshot does not already contain", async () => {
    const { writes, renderTerminalData, resyncActiveRef } = await bind();
    service.output!("AAAA", 4);

    let finishSnapshot!: (snapshot: TerminalRecoverySnapshot) => void;
    service.snapshot = () => new Promise((resolve) => { finishSnapshot = resolve; });
    const resync = service.desync!();
    await vi.waitFor(() => expect(resyncActiveRef.current).toBe(true));

    // 闸门期到达：第一块完全在快照内，第二块跨过快照边界（[8,12) 在内、[12,16) 在外）。
    service.output!("BBBB", 8);
    service.output!("CCCCDDDD", 16);
    expect(writes).toEqual(["AAAA"]);

    finishSnapshot(snapshotOf({ delta: "SNAP", endSeq: 12, checkpointEpoch: "e1" }));
    expect(await resync).toBe(true);

    expect(writes).toEqual(["AAAA", "<reset>", "SNAP", "DDDD"]);
    expect(renderTerminalData).toHaveBeenCalledWith("", { discontinuity: true });
    // 闸门期的数据在快照写完之后才过渲染变换，且只有没被覆盖的那段。
    expect(renderTerminalData.mock.calls.map(([data]) => data)).toEqual(["AAAA", "", "SNAP", "DDDD"]);
    // seq 账本跟到补写的最后一块，可以继续拍 checkpoint。
    expect(anchorCandidate("s-gate")).toEqual({ anchorSeq: 16, checkpointEpoch: "e1" });
    expect(resyncActiveRef.current).toBe(false);
  });

  it("writes the whole backlog when the backend has no seq accounting", async () => {
    const { writes } = await bind();
    service.snapshot = async () => snapshotOf({ delta: "SNAP", endSeq: 12, checkpointEpoch: "0" });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const original = service.snapshot;
    service.snapshot = async () => { await held; return original(); };

    const resync = service.desync!();
    service.output!("BBBB", 8);
    release();
    await resync;

    expect(writes).toEqual(["<reset>", "SNAP", "BBBB"]);
  });

  it("keeps the backlog when recovery fails and the screen was not replaced", async () => {
    const { writes } = await bind();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    service.snapshot = async () => { await held; return null; };

    const resync = service.desync!();
    service.output!("BBBB", 8);
    release();
    expect(await resync).toBe(false);

    expect(writes.filter((entry) => entry === "BBBB")).toEqual(["BBBB"]);
    expect(writes).not.toContain("<reset>");
  });

  it("passes live output straight through when no resync is in flight", async () => {
    const { writes } = await bind();
    service.output!("one", 3);
    service.output!("two", 6);
    expect(writes).toEqual(["one", "two"]);
  });
});
