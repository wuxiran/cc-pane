import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTerminalDesyncHandler, resyncFromReplaySnapshot } from "./terminalResync";
import { terminalReplaySemaphore } from "./terminalReplaySemaphore";
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
    checkpointEpoch: "0",
    ...overrides,
  };
}

beforeEach(() => {
  _resetSeqTrackersForTest();
});

type ResyncOptions = Parameters<typeof resyncFromReplaySnapshot>[0];

/**
 * 默认：快照缺失（null）、各写入管道记录到数组、debugLog 记录事件名。
 * 任意选项可覆盖；返回值附带 term 与各记录数组便于断言。
 */
async function runResync(
  overrides: Partial<Omit<ResyncOptions, "term">> & { term?: ReturnType<typeof createTerm> } = {},
) {
  const { term = createTerm(), ...options } = overrides;
  const writes: string[] = [];
  const checkpointWrites: string[] = [];
  const events: string[] = [];
  const syncTrackedBufferType = vi.fn();
  const resynced = await resyncFromReplaySnapshot({
    term,
    sessionId: "s-1",
    reason: "daemon-desync",
    getRecoverySnapshot: async () => null,
    writeData: async (data) => {
      writes.push(data);
    },
    writeCheckpointData: async (data) => {
      checkpointWrites.push(data);
    },
    syncTrackedBufferType,
    debugLog: (event) => {
      events.push(event);
    },
    ...options,
  });
  return { resynced, term, writes, checkpointWrites, events, syncTrackedBufferType };
}

describe("resyncFromReplaySnapshot", () => {
  it("reset 后全量写入快照并同步 buffer 追踪", async () => {
    const { resynced, term, writes, syncTrackedBufferType } = await runResync({
      getRecoverySnapshot: async () => recoverySnapshot({ delta: "SNAPSHOT" }),
    });

    expect(resynced).toBe(true);
    expect(term.reset).toHaveBeenCalledTimes(1);
    expect(writes).toEqual(["SNAPSHOT"]);
    expect(term.reset.mock.invocationCallOrder[0]).toBeLessThan(
      syncTrackedBufferType.mock.invocationCallOrder[0],
    );
  });

  it("快照缺失时不 reset（残缺画面优于空画面），并接地：CAN 丢弃被截断的控制串 + 清 pen", async () => {
    const { resynced, term, checkpointWrites } = await runResync();

    expect(resynced).toBe(false);
    expect(term.reset).not.toHaveBeenCalled();
    // 接地必须用 CAN 而非 ESC——ESC 会提交被 gap 截断的 OSC（改窗口标题 / 写剪贴板）。
    // xterm 派发 OSC/DCS/APC 的判据是 success = code !== 0x18 && code !== 0x1a，
    // 用 ESC 接地只让解析器归位、却把 gap 截断的那半段**提交**出去。
    expect(checkpointWrites).toEqual(["\x18\x1b[0m"]);
  });

  it("快照请求抛错时不 reset、返回 false，且同样接地（gap 已经发生，与拿不到快照的原因无关）", async () => {
    const { resynced, term, checkpointWrites } = await runResync({
      reason: "hibernation-overflow",
      getRecoverySnapshot: async () => {
        throw new Error("network down");
      },
    });

    expect(resynced).toBe(false);
    expect(term.reset).not.toHaveBeenCalled();
    expect(checkpointWrites).toEqual(["\x18\x1b[0m"]);
  });

  it("成功路径不接地（reset + 快照重画已经把状态全部重建）", async () => {
    const { resynced, checkpointWrites } = await runResync({
      // checkpoint 为 null，所以 checkpoint 管道只可能被接地写入触碰
      getRecoverySnapshot: async () => recoverySnapshot({ delta: "SNAPSHOT" }),
    });

    expect(resynced).toBe(true);
    expect(checkpointWrites).toEqual([]);
  });

  it("接地写入失败不改变返回值，也不把原本的失败原因盖掉", async () => {
    const { resynced, events } = await runResync({
      writeCheckpointData: async () => {
        throw new Error("xterm disposed");
      },
    });

    expect(resynced).toBe(false);
    expect(events).toContain("terminal.resync.skip");
    expect(events).toContain("terminal.resync.ground-failed");
  });

  it("空数据快照仍 reset（会话确实没有历史）", async () => {
    const { resynced, term, writes } = await runResync({
      getRecoverySnapshot: async () => recoverySnapshot(),
    });

    expect(resynced).toBe(true);
    expect(term.reset).toHaveBeenCalledTimes(1);
    expect(writes).toEqual([]);
  });

  it("双管道序（裁决 B）：reset → photo 直写 → delta 渲染写 → sync", async () => {
    const order: string[] = [];
    const term = createTerm();
    term.reset.mockImplementation(() => order.push("reset"));

    const { resynced } = await runResync({
      term,
      sessionId: "s-2",
      getRecoverySnapshot: async () =>
        recoverySnapshot({
          checkpoint: {
            checkpointEpoch: "4",
            anchorSeq: 10,
            snapshotAnsi: "PHOTO-VT",
            bufferMode: "normal",
            cols: 80,
            rows: 24,
            checkpointedAtMs: 1,
          },
          delta: "DELTA-RAW",
          endSeq: 20,
          checkpointEpoch: "4",
        }),
      writeData: async (data) => {
        order.push(`delta:${data}`);
      },
      writeCheckpointData: async (data) => {
        order.push(`photo:${data}`);
      },
      syncTrackedBufferType: () => {
        order.push("sync");
      },
    });

    expect(resynced).toBe(true);
    // photo 绝不过 delta（render）管道，且序固定：reset → photo → delta → sync
    expect(order).toEqual(["reset", "photo:PHOTO-VT", "delta:DELTA-RAW", "sync"]);
  });

  it.each([
    ["epoch≠0 时 resync 后 reanchor（恢复可拍）", "s-3",
      recoverySnapshot({ delta: "D", endSeq: 33, checkpointEpoch: "6" }),
      { anchorSeq: 33, checkpointEpoch: "6" }],
    ["epoch=0（旧 daemon 回落）不 reanchor", "s-4", recoverySnapshot({ delta: "D" }), null],
  ] as const)("%s", async (_label, sessionId, snapshot, expectedAnchor) => {
    expect(anchorCandidate(sessionId)).toBeNull();

    await runResync({ sessionId, getRecoverySnapshot: async () => snapshot });

    expect(anchorCandidate(sessionId)).toEqual(expectedAnchor);
  });
});

// createTerminalDesyncHandler 是 registerDesync 的标准回调，此前零覆盖。
// 它的三条不变式全都是「错了也不报错、只是丢字或永久静默」的类型：
// 闸门必须先落再发快照请求；不完整积压必须丢；无论成败都要放闸。
describe("createTerminalDesyncHandler", () => {
  it("defers hidden-view recovery until visible without releasing the recovery gate", async () => {
    let visible = false;
    const fetch = vi.fn(async () => recoverySnapshot({ delta: "data" }));
    const gate = vi.fn();
    const handler = createTerminalDesyncHandler({ sessionId: "hidden", terminalRef: { current: createTerm() },
      hiddenWriteBufferRef: { current: { reset: vi.fn() } }, isRenderVisible: () => visible,
      getRecoverySnapshot: fetch, writeData: async () => {}, writeCheckpointData: async () => {},
      syncTrackedBufferType: () => {}, setResyncActive: gate, onResyncSettled: () => {}, debugLog: () => {} });
    expect(await handler()).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(gate).toHaveBeenLastCalledWith(true);
    visible = true;
    expect(await handler()).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(gate).toHaveBeenLastCalledWith(false);
  });

  it.each([true, false])("does not write a disposed view after snapshot fetch (present=%s)", async (present) => {
    let finish!: (snapshot: TerminalRecoverySnapshot | null) => void;
    const term = createTerm();
    const write = vi.fn(async () => {});
    const settled = vi.fn();
    const handler = createTerminalDesyncHandler({ sessionId: "cancel", terminalRef: { current: term },
      hiddenWriteBufferRef: { current: null }, getRecoverySnapshot: () => new Promise(resolve => { finish = resolve; }),
      writeData: write, writeCheckpointData: write, syncTrackedBufferType: () => {},
      setResyncActive: () => {}, onResyncSettled: settled, debugLog: () => {} });
    const pending = handler(); handler.dispose(); finish(present ? recoverySnapshot({ delta: "old data" }) : null);
    expect(await pending).toBe(false);
    expect(term.reset).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
    expect(settled).not.toHaveBeenCalled();
  });
  function harness(
    overrides: {
      getRecoverySnapshot?: (sessionId: string) => Promise<TerminalRecoverySnapshot | null>;
      term?: ReturnType<typeof createTerm> | null;
      writeData?: (data: string) => Promise<void>;
      /** 传 null 模拟 hiddenWriteBufferRef.current 为空。 */
      hiddenWriteBuffer?: null;
      /** 在记录 order 之后调用，可返回 promise 模拟异步收尾。 */
      onResyncSettled?: (resynced: boolean) => unknown;
    } = {},
  ) {
    const order: string[] = [];
    const checkpointWrites: string[] = [];
    const term = overrides.term === undefined ? createTerm() : overrides.term;
    if (term) term.reset.mockImplementation(() => order.push("term.reset"));
    const hiddenWriteBuffer = { reset: vi.fn(() => order.push("buffer.reset")) };
    const setResyncActive = vi.fn((active: boolean) => order.push(`gate:${active}`));
    const onResyncSettled = vi.fn((resynced: boolean) => {
      order.push(`settled:${resynced}`);
      return overrides.onResyncSettled?.(resynced);
    });
    const getRecoverySnapshot = vi.fn(
      overrides.getRecoverySnapshot
        ?? (async () => {
          order.push("snapshot.request");
          return recoverySnapshot({ delta: "D" });
        }),
    );

    const handler = createTerminalDesyncHandler({
      sessionId: "s-desync",
      terminalRef: { current: term },
      hiddenWriteBufferRef: {
        current: overrides.hiddenWriteBuffer === null ? null : hiddenWriteBuffer,
      },
      getRecoverySnapshot,
      writeData: overrides.writeData ?? (async () => {}),
      writeCheckpointData: async (data) => {
        checkpointWrites.push(data);
        order.push("checkpoint.write");
      },
      syncTrackedBufferType: () => {},
      setResyncActive,
      onResyncSettled,
      debugLog: () => {},
    });

    return {
      handler,
      order,
      checkpointWrites,
      hiddenWriteBuffer,
      setResyncActive,
      onResyncSettled,
      getRecoverySnapshot,
    };
  }

  /** handler 是同步返回的，内部 promise 链要多刷几轮微任务才结算。 */
  async function flush(): Promise<void> {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  }

  it("闸门先落再发快照请求（否则「抓快照后、reset 前」到达的输出会被 reset 抹掉且不在快照里 = 真丢字）", async () => {
    const { handler, order } = harness();
    handler();
    await flush();

    expect(order.indexOf("gate:true")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("gate:true")).toBeLessThan(order.indexOf("snapshot.request"));
  });

  it("丢弃 desync 前的不完整积压（缺口在它中间），且发生在快照请求之前", async () => {
    const { handler, order, hiddenWriteBuffer } = harness();
    handler();
    await flush();

    expect(hiddenWriteBuffer.reset).toHaveBeenCalledTimes(1);
    expect(order.indexOf("buffer.reset")).toBeLessThan(order.indexOf("snapshot.request"));
    // 积压丢弃也在闸门之后：闸门保证之后的新输出进积压
    expect(order.indexOf("gate:true")).toBeLessThan(order.indexOf("buffer.reset"));
  });

  it("成功路径：放闸 + onResyncSettled(true)，且放闸在收尾之前", async () => {
    const { handler, order, setResyncActive, onResyncSettled } = harness();
    const completion = handler();
    await flush();

    expect(setResyncActive).toHaveBeenNthCalledWith(1, true);
    expect(setResyncActive).toHaveBeenNthCalledWith(2, false);
    expect(onResyncSettled).toHaveBeenCalledWith(true);
    expect(order.indexOf("gate:false")).toBeLessThan(order.indexOf("settled:true"));
    // 手动重置路径靠这个返回值决定要不要回退成裸 reset。
    await expect(completion).resolves.toBe(true);
  });

  describe("快照已发出后到达的 desync", () => {
    function deferredSnapshots() {
      const resolvers: Array<() => void> = [];
      const getRecoverySnapshot = () =>
        new Promise<TerminalRecoverySnapshot | null>((resolve) => {
          resolvers.push(() => resolve(recoverySnapshot({ delta: "D" })));
        });
      return { resolvers, getRecoverySnapshot };
    }

    it("补跑一轮：它报告的缺口可能不在已发出的快照里", async () => {
      const { resolvers, getRecoverySnapshot } = deferredSnapshots();
      const h = harness({ getRecoverySnapshot });

      const first = h.handler();
      await flush();
      expect(h.getRecoverySnapshot).toHaveBeenCalledTimes(1);

      expect(h.handler()).toBe(first);
      resolvers[0]();
      await first;
      await flush();

      expect(h.getRecoverySnapshot).toHaveBeenCalledTimes(2);
      resolvers[1]();
      await flush();
      expect(h.onResyncSettled).toHaveBeenCalledTimes(2);
      expect(h.setResyncActive).toHaveBeenLastCalledWith(false);
    });

    it("同一轮内多次 desync 只补跑一次", async () => {
      const { resolvers, getRecoverySnapshot } = deferredSnapshots();
      const h = harness({ getRecoverySnapshot });

      const first = h.handler();
      await flush();
      void h.handler();
      void h.handler();
      void h.handler();
      resolvers[0]();
      await first;
      await flush();
      resolvers[1]();
      await flush();

      expect(h.getRecoverySnapshot).toHaveBeenCalledTimes(2);
    });

    it("快照发出前到达的 desync 不补跑：快照一定包含它", async () => {
      // 占住重放信号量，让快照请求排队：两次 desync 都落在请求发出之前。
      let release!: () => void;
      const holder = terminalReplaySemaphore.run(() => new Promise<void>((resolve) => {
        release = resolve;
      }), { label: "test.hold" });
      await flush();
      const h = harness();

      const first = h.handler();
      expect(h.handler()).toBe(first);
      expect(h.getRecoverySnapshot).not.toHaveBeenCalled();

      release();
      await holder;
      await first;
      await flush();

      expect(h.getRecoverySnapshot).toHaveBeenCalledTimes(1);
    });

    it("视图已销毁时不补跑", async () => {
      const { resolvers, getRecoverySnapshot } = deferredSnapshots();
      const h = harness({ getRecoverySnapshot });

      const first = h.handler();
      await flush();
      void h.handler();
      h.handler.dispose();
      resolvers[0]();
      await first;
      await flush();

      expect(h.getRecoverySnapshot).toHaveBeenCalledTimes(1);
    });
  });

  it("returns one shared promise that includes asynchronous settled cleanup", async () => {
    let finishSettled!: () => void;
    const { handler, getRecoverySnapshot, onResyncSettled } = harness({
      onResyncSettled: () => new Promise<void>((resolve) => {
        finishSettled = resolve;
      }),
    });

    const first = handler();
    const second = handler();
    let settled = false;
    void first.then(() => {
      settled = true;
    });
    await flush();

    expect(second).toBe(first);
    expect(getRecoverySnapshot).toHaveBeenCalledOnce();
    expect(onResyncSettled).toHaveBeenCalledOnce();
    expect(settled).toBe(false);

    finishSettled();
    await first;

    expect(settled).toBe(true);
  });

  type SnapshotFetch = () => Promise<TerminalRecoverySnapshot | null>;
  it.each<[string, SnapshotFetch]>([
    ["快照返回 null 也放闸 + onResyncSettled(false)（否则闸门永不打开 = 终端永久静默）", async () => null],
    ["快照请求抛错也放闸 + onResyncSettled(false)", async () => {
      throw new Error("daemon unreachable");
    }],
  ])("%s", async (_label, getRecoverySnapshot) => {
    const { handler, setResyncActive, onResyncSettled } = harness({ getRecoverySnapshot });
    const completion = handler();
    await flush();

    expect(setResyncActive).toHaveBeenLastCalledWith(false);
    expect(onResyncSettled).toHaveBeenCalledWith(false);
    await expect(completion).resolves.toBe(false);
  });

  it("接地早于收尾：积压 flush 与失败提示都落在干净 pen 上", async () => {
    const { handler, order, checkpointWrites } = harness({
      getRecoverySnapshot: async () => null,
    });
    handler();
    await flush();

    // onResyncSettled 里会 flush 积压、再写失败提示——两者都必须晚于接地，
    // 否则被 gap 卡住的 pen 会把它们一起染上（Orca #14241）。
    expect(checkpointWrites).toEqual(["\x18\x1b[0m"]);
    expect(order.indexOf("checkpoint.write")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("checkpoint.write")).toBeLessThan(order.indexOf("settled:false"));
  });

  it("写入阶段抛错（reject 不被 resync 内部吞）同样放闸", async () => {
    const { handler, setResyncActive, onResyncSettled } = harness({
      writeData: async () => {
        throw new Error("write failed");
      },
    });

    handler();
    await flush();

    expect(setResyncActive).toHaveBeenLastCalledWith(false);
    expect(onResyncSettled).toHaveBeenCalledWith(false);
  });

  it("terminalRef 为 null 时早退：不落闸、不丢积压、不发请求（避免留下一个永不打开的闸门）", async () => {
    const { handler, hiddenWriteBuffer, setResyncActive, onResyncSettled, getRecoverySnapshot } =
      harness({ term: null });
    handler();
    await flush();

    expect(setResyncActive).not.toHaveBeenCalled();
    expect(hiddenWriteBuffer.reset).not.toHaveBeenCalled();
    expect(getRecoverySnapshot).not.toHaveBeenCalled();
    expect(onResyncSettled).not.toHaveBeenCalled();
  });

  it("hiddenWriteBufferRef 为 null 时不抛（可选链），流程照常走完", async () => {
    const { handler, onResyncSettled } = harness({ hiddenWriteBuffer: null });

    expect(() => handler()).not.toThrow();
    await flush();
    expect(onResyncSettled).toHaveBeenCalledWith(true);
  });
});
