import { describe, expect, it } from "vitest";
import {
  RECONCILE_ARMED_TTL_MS,
  RECONCILE_HOLD_TIMEOUT_MS,
  createResyncGateBacklog,
  createSnapshotReconciler,
  type SeqChunk,
} from "./terminalSnapshotOverlap";

function harness() {
  let time = 0;
  const timers: Array<{ at: number; callback: () => void; cancelled: boolean }> = [];
  const timedOut: SeqChunk[] = [];
  const reconciler = createSnapshotReconciler({
    now: () => time,
    setTimer: (callback, ms) => {
      const timer = { at: time + ms, callback, cancelled: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => {
      (handle as { cancelled: boolean }).cancelled = true;
    },
    onHoldTimeout: (chunk) => timedOut.push(chunk),
  });
  const advance = (ms: number) => {
    time += ms;
    for (const timer of timers.splice(0)) {
      if (timer.cancelled) continue;
      if (timer.at <= time) timer.callback();
      else timers.push(timer);
    }
  };
  return { reconciler, advance, timedOut };
}

describe("createSnapshotReconciler", () => {
  it("passes everything through until armed", () => {
    const { reconciler } = harness();
    expect(reconciler.active()).toBe(false);
    expect(reconciler.accept("abc", 3)).toEqual([{ data: "abc", endSeq: 3 }]);
    expect(reconciler.accept("slice")).toEqual([{ data: "slice", endSeq: undefined }]);
  });

  it("drops frames the snapshot already contains and stops once a frame passes the boundary", () => {
    const { reconciler } = harness();
    reconciler.arm(108);
    expect(reconciler.accept("aaaa", 104)).toEqual([]);
    expect(reconciler.accept("bbbb", 108)).toEqual([]);
    expect(reconciler.active()).toBe(true);
    expect(reconciler.accept("cccc", 112)).toEqual([{ data: "cccc", endSeq: 112 }]);
    expect(reconciler.active()).toBe(false);
  });

  it("trims the overlapping head of a frame that straddles the boundary", () => {
    const { reconciler } = harness();
    reconciler.arm(104);
    expect(reconciler.accept("aaaabbbb", 108)).toEqual([{ data: "bbbb", endSeq: 108 }]);
  });

  it("counts UTF-8 bytes, not string length, when trimming", () => {
    const { reconciler } = harness();
    // 「中文」6 字节 + "ok" 2 字节：seq 跨度 8，快照覆盖前 6 字节。
    reconciler.arm(206);
    expect(reconciler.accept("中文ok", 208)).toEqual([{ data: "ok", endSeq: 208 }]);
  });

  it("treats seq-less slices and the final slice as one frame", () => {
    // 调度器把 20,000 字符的一帧拆成 16,384 + 3,616，只有最后一片带 endSeq。
    const { reconciler } = harness();
    reconciler.arm(20_000);
    expect(reconciler.accept("x".repeat(16_384))).toEqual([]);
    expect(reconciler.accept("x".repeat(3_616), 20_000)).toEqual([]);
    expect(reconciler.active()).toBe(true);
  });

  it("trims across slices when the boundary falls inside a sliced frame", () => {
    const { reconciler } = harness();
    reconciler.arm(10);
    expect(reconciler.accept("0123456789AB")).toEqual([]);
    // 帧 = [0,16)，快照覆盖到 10：保留 "ABCDEF"。
    expect(reconciler.accept("CDEF", 16)).toEqual([{ data: "ABCDEF", endSeq: 16 }]);
  });

  it("rejoins a surrogate pair that the slicer cut in half", () => {
    const { reconciler } = harness();
    const emoji = "😀"; // 2 个 UTF-16 码元，4 个 UTF-8 字节
    reconciler.arm(2);
    expect(reconciler.accept("ab" + emoji[0])).toEqual([]);
    expect(reconciler.accept(emoji[1] + "z", 7)).toEqual([{ data: emoji + "z", endSeq: 7 }]);
  });

  it("is end-anchored: a frame whose head was already written live still trims correctly", () => {
    // 帧 [100,120) 的前 8 字节在闸门关上之前已直写；这里只看到后 12 字节。
    const { reconciler } = harness();
    reconciler.arm(112);
    expect(reconciler.accept("0123", undefined)).toEqual([]);
    expect(reconciler.accept("456789AB", 120)).toEqual([{ data: "456789AB", endSeq: 120 }]);
  });

  it("releases held slices unchanged when the frame tail never arrives", () => {
    const { reconciler, advance, timedOut } = harness();
    reconciler.arm(50);
    expect(reconciler.accept("orphan")).toEqual([]);
    advance(RECONCILE_HOLD_TIMEOUT_MS - 1);
    expect(timedOut).toEqual([]);
    advance(1);
    expect(timedOut).toEqual([{ data: "orphan" }]);
    expect(reconciler.active()).toBe(false);
  });

  it("gives up after the armed TTL so a restarted seq space is not swallowed", () => {
    const { reconciler, advance } = harness();
    reconciler.arm(1_000);
    advance(RECONCILE_ARMED_TTL_MS + 1);
    expect(reconciler.accept("fresh", 5)).toEqual([{ data: "fresh", endSeq: 5 }]);
    expect(reconciler.active()).toBe(false);
  });

  it("re-arming discards slices held for the replaced screen; disarm hands them back", () => {
    const { reconciler } = harness();
    reconciler.arm(10);
    reconciler.accept("stale");
    reconciler.arm(20);
    expect(reconciler.accept("new", 23)).toEqual([{ data: "new", endSeq: 23 }]);

    reconciler.arm(30);
    reconciler.accept("held");
    expect(reconciler.disarm()).toEqual([{ data: "held" }]);
    expect(reconciler.active()).toBe(false);
  });
});

describe("createResyncGateBacklog", () => {
  it("returns chunks in arrival order and empties itself", () => {
    const backlog = createResyncGateBacklog();
    backlog.push("a", 1);
    backlog.push("b", 2);
    expect(backlog.count()).toBe(2);
    expect(backlog.take()).toEqual({ chunks: [{ data: "a", endSeq: 1 }, { data: "b", endSeq: 2 }], overflowed: false });
    expect(backlog.take()).toEqual({ chunks: [], overflowed: false });
  });

  it("gives up the whole backlog once it overflows", () => {
    const backlog = createResyncGateBacklog(4);
    backlog.push("abc", 3);
    backlog.push("de", 5);
    backlog.push("f", 6);
    expect(backlog.overflowed()).toBe(true);
    expect(backlog.pendingLength()).toBe(0);
    expect(backlog.take()).toEqual({ chunks: [], overflowed: true });
    backlog.push("g", 7);
    expect(backlog.take()).toEqual({ chunks: [{ data: "g", endSeq: 7 }], overflowed: false });
  });

  it("reset discards content and the overflow flag", () => {
    const backlog = createResyncGateBacklog(2);
    backlog.push("abc", 3);
    backlog.reset();
    expect(backlog.overflowed()).toBe(false);
    expect(backlog.take()).toEqual({ chunks: [], overflowed: false });
  });
});
