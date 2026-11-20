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
import { _resetSeqTrackersForTest, anchorCandidate, noteReceived, noteWritten, reanchorSeq } from "./terminalOutputSeqTracker";
import { markSecondaryTerminalView, recordRecoveryFloor } from "./terminalViewOwnership";

function snapshotOf(overrides: Partial<TerminalRecoverySnapshot>): TerminalRecoverySnapshot {
  return { checkpoint: null, delta: "", bufferMode: "normal", endSeq: 0, checkpointEpoch: "0", ...overrides };
}

interface BindOverrides {
  /** 绑定前对 xterm 做的准备（登记为副视图、记下回放下限）。 */
  prepareTerm?: (term: object) => void;
  writeTerminalData?: (data: string, onWritten?: () => void) => Promise<void>;
  onSessionExit?: (sessionId: string, exitCode: number) => void;
  pendingExitRef?: { current: { sessionId: string; exitCode: number } | null };
}

async function bind(overrides: BindOverrides = {}) {
  const writes: string[] = [];
  const renderTerminalData = vi.fn((data: string, _options?: { discontinuity?: boolean }) => data);
  const resyncActiveRef = { current: false };
  const term = { reset: vi.fn(() => writes.push("<reset>")), buffer: { active: { type: "normal" } } };
  overrides.prepareTerm?.(term);
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
    writeTerminalData: overrides.writeTerminalData ?? (async (data, onWritten) => {
      writes.push(data);
      onWritten?.();
    }),
    syncTrackedBufferType: () => {},
    unbindSessionCallbacks: () => {},
    onSessionExit: overrides.onSessionExit ?? (() => {}),
    resyncActiveRef,
    overflowResyncRef: { current: null },
    flushHiddenWrites: async () => "ready",
    pendingExitRef: overrides.pendingExitRef ?? { current: null },
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

  it("drops a frame the snapshot contains even when it arrives after the gate reopens", async () => {
    const { writes } = await bind();
    service.snapshot = async () => snapshotOf({ delta: "A", endSeq: 1, checkpointEpoch: "e1" });
    expect(await service.desync!()).toBe(true);

    // 这一帧在快照取走之前就进了后端回放缓冲，但卡在批处理/调度队列里，放闸后才送到。
    noteReceived("s-gate", 1);
    service.output!("A", 1);
    expect(writes).toEqual(["<reset>", "A"]);

    noteReceived("s-gate", 4);
    service.output!("BCD", 4);
    expect(writes).toEqual(["<reset>", "A", "BCD"]);
    // 迟到帧不是缺口：账本没有被判失效，仍可拍 checkpoint。
    expect(anchorCandidate("s-gate")).toEqual({ anchorSeq: 4, checkpointEpoch: "e1" });
  });

  it("does not rewrite the seq-less slices of a large frame the snapshot contains", async () => {
    const { writes } = await bind();
    let finishSnapshot!: (snapshot: TerminalRecoverySnapshot) => void;
    service.snapshot = () => new Promise((resolve) => { finishSnapshot = resolve; });
    const resync = service.desync!();

    // 调度器把 20,000 字符的一帧拆成两片，只有最后一片带 endSeq。
    service.output!("x".repeat(16_384));
    service.output!("x".repeat(3_616), 20_000);
    finishSnapshot(snapshotOf({ delta: "SNAP", endSeq: 20_000, checkpointEpoch: "e1" }));
    await resync;

    expect(writes).toEqual(["<reset>", "SNAP"]);
  });

  it("reconciles output buffered before the view subscribed (replay first, bind second)", async () => {
    // attach / 唤醒：回放先完成、覆盖到 50，然后才绑定输出回调。
    const { writes } = await bind({ prepareTerm: (term) => recordRecoveryFloor(term, 50) });

    service.output!("covered", 50);
    service.output!("fresh", 55);
    service.output!("later", 60);
    expect(writes).toEqual(["fresh", "later"]);
  });

  it("shows the exit banner only after the reconciled backlog has reached xterm", async () => {
    const order: string[] = [];
    const pendingWrites: Array<() => void> = [];
    const pendingExitRef = { current: null as { sessionId: string; exitCode: number } | null };
    await bind({
      pendingExitRef,
      onSessionExit: () => order.push("exit"),
      writeTerminalData: (data, onWritten) => new Promise<void>((resolve) => {
        if (data.startsWith("TAIL")) {
          pendingWrites.push(() => { order.push(data); onWritten?.(); resolve(); });
        } else {
          order.push(data);
          onWritten?.();
          resolve();
        }
      }),
    });
    let finishSnapshot!: (snapshot: TerminalRecoverySnapshot) => void;
    service.snapshot = () => new Promise((resolve) => { finishSnapshot = resolve; });
    const resync = service.desync!();
    service.output!("TAIL1", 105);
    service.output!("TAIL2", 110);
    pendingExitRef.current = { sessionId: "s-gate", exitCode: 0 };
    finishSnapshot(snapshotOf({ delta: "SNAP", endSeq: 100, checkpointEpoch: "e1" }));

    await vi.waitFor(() => expect(pendingWrites).toHaveLength(2));
    expect(order).not.toContain("exit");
    pendingWrites.forEach((finish) => finish());
    await resync;

    expect(order).toEqual(["SNAP", "TAIL1", "TAIL2", "exit"]);
  });

  it("takes a fresh snapshot inside the same resync when the gate backlog overflows", async () => {
    const { writes, resyncActiveRef } = await bind();
    const resolvers: Array<(snapshot: TerminalRecoverySnapshot) => void> = [];
    service.snapshot = () => new Promise((resolve) => { resolvers.push(resolve); });
    let settled = false;
    const resync = service.desync!().then((result) => { settled = true; return result; });
    await vi.waitFor(() => expect(resolvers).toHaveLength(1));

    service.output!("z".repeat(600_000), 600_000); // 超过暂存上限：中段已缺
    resolvers[0](snapshotOf({ delta: "FIRST", endSeq: 10, checkpointEpoch: "e1" }));
    await vi.waitFor(() => expect(resolvers).toHaveLength(2));
    // 第一轮写完了，但调用方还没拿到结果，闸门也没放开。
    expect(settled).toBe(false);
    expect(resyncActiveRef.current).toBe(true);

    service.output!("tail", 600_004);
    resolvers[1](snapshotOf({ delta: "SECOND", endSeq: 600_000, checkpointEpoch: "e1" }));
    expect(await resync).toBe(true);

    expect(writes).toEqual(["<reset>", "FIRST", "<reset>", "SECOND", "tail"]);
    expect(resyncActiveRef.current).toBe(false);
  });

  it("keeps output gathered before the snapshot request when recovery fails", async () => {
    const { writes } = await bind();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    service.snapshot = async () => { await held; return null; };
    const resync = service.desync!();
    service.output!("tail-1", 6);
    service.output!("tail-2", 12);
    release();
    expect(await resync).toBe(false);

    expect(writes.filter((entry) => entry.startsWith("tail"))).toEqual(["tail-1", "tail-2"]);
  });

  describe("secondary views (starred mirror / popup)", () => {
    it("rebuilds from a fresh snapshot when output was dispatched during its replay", async () => {
      // 主视图已收到 120；镜像的回放快照只覆盖到 100，中间那段只发给了主视图。
      noteReceived("s-gate", 120);
      service.snapshot = async () => snapshotOf({ delta: "FULL", endSeq: 120, checkpointEpoch: "e1" });
      const { writes } = await bind({
        prepareTerm: (term) => {
          markSecondaryTerminalView(term);
          recordRecoveryFloor(term, 100);
        },
      });

      await vi.waitFor(() => expect(writes).toEqual(["<reset>", "FULL"]));
    });

    it("rebuilds when the next frame does not follow on from its snapshot", async () => {
      service.snapshot = async () => snapshotOf({ delta: "FULL", endSeq: 130, checkpointEpoch: "e1" });
      const { writes } = await bind({
        prepareTerm: (term) => {
          markSecondaryTerminalView(term);
          recordRecoveryFloor(term, 100);
        },
      });

      // 帧 [120,130)：100–120 这段镜像从没收到。这一帧不写，等新快照。
      service.output!("0123456789", 130);
      await vi.waitFor(() => expect(writes).toEqual(["<reset>", "FULL"]));
    });

    it("does not rebuild when its replay was already complete", async () => {
      noteReceived("s-gate", 100);
      const snapshot = vi.fn(async () => snapshotOf({ delta: "FULL", endSeq: 100, checkpointEpoch: "e1" }));
      service.snapshot = snapshot;
      const { writes } = await bind({
        prepareTerm: (term) => {
          markSecondaryTerminalView(term);
          recordRecoveryFloor(term, 100);
        },
      });

      service.output!("next", 104);
      expect(writes).toEqual(["next"]);
      expect(snapshot).not.toHaveBeenCalled();
    });

    it("never moves the shared seq ledger", async () => {
      // 主视图的账本：收到并写到 100。
      reanchorSeq("s-gate", 100, "e1");
      const { writes } = await bind({ prepareTerm: (term) => markSecondaryTerminalView(term) });

      // 主视图还没写完 110，镜像先写完了：账本不能因此前进。
      noteReceived("s-gate", 110);
      service.output!("mirror-first", 110);
      expect(writes).toEqual(["mirror-first"]);
      expect(anchorCandidate("s-gate")).toBeNull();
      noteWritten("s-gate", 110);
      expect(anchorCandidate("s-gate")).toEqual({ anchorSeq: 110, checkpointEpoch: "e1" });

      // 镜像自己重建也不重锚：主视图的进度留在 110。
      service.snapshot = async () => snapshotOf({ delta: "SNAP", endSeq: 90, checkpointEpoch: "e1" });
      await service.desync!();
      expect(anchorCandidate("s-gate")).toEqual({ anchorSeq: 110, checkpointEpoch: "e1" });
    });

    it("stops rebuilding after repeated gaps instead of resetting the screen forever", async () => {
      const snapshot = vi.fn(async () => snapshotOf({ delta: "S", endSeq: 100, checkpointEpoch: "e1" }));
      service.snapshot = snapshot;
      const { writes } = await bind({
        prepareTerm: (term) => {
          markSecondaryTerminalView(term);
          recordRecoveryFloor(term, 100);
        },
      });

      // 每次重建后下一帧仍然不连续（坐标推算出了偏差的情形）。
      for (let round = 0; round < 5; round += 1) {
        service.output!("xx", 200 + round * 10);
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      expect(snapshot.mock.calls.length).toBe(3);
      // 超过上限后帧照常放行。
      expect(writes.filter((entry) => entry === "xx").length).toBeGreaterThan(0);
    });
  });
});
