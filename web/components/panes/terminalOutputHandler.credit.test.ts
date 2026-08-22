// B-5：输出写入管线的**流控信用**接线。
//
// 与 terminalOutputHandler.seq.test.ts（checkpoint 锚点账）刻意分开：两本账语义
// 相反——锚点账在丢弃时禁拍（保守才安全），信用账在丢弃时照样归还（不还就卡死）。
// 放一起容易被后来的改动"顺手统一"，那一统一就是生产事故。
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { createTerminalOutputHandler } from "./terminalOutputHandler";
import type { TerminalHiddenWriteBuffer } from "./terminalHiddenWriteBuffer";
import { deliverTerminalDataWithDeferredCredit } from "./terminalDeliveryCredit";
import { _resetSeqTrackersForTest } from "./terminalOutputSeqTracker";

const fakeTerm = { buffer: { active: { type: "normal" } } } as unknown as Terminal;

interface HarnessOptions {
  visible: boolean;
  term?: Terminal | null;
  /** 让 writeTerminalData 走失败分支。 */
  failWrite?: boolean;
  /** 不同步回调 onWritten，模拟写队列悬挂。 */
  deferWrite?: boolean;
}

function makeHandler(options: HarnessOptions): {
  handler: (data: string, endSeq?: number) => void;
  settleWrite: () => void;
} {
  let pendingOnWritten: (() => void) | null = null;
  const hiddenWriteBufferRef: { current: TerminalHiddenWriteBuffer | null } = { current: null };
  const handler = createTerminalOutputHandler({
    sessionId: "s1",
    terminalRef: { current: options.term === undefined ? fakeTerm : options.term },
    focusReportModeRef: { current: false },
    hiddenWriteBufferRef,
    isRenderVisible: () => options.visible,
    keepCliOutputInNormalBuffer: false,
    renderTerminalData: (data) => data,
    writeTerminalData: (_data, onWritten) => {
      if (options.failWrite) return Promise.reject(new Error("write failed"));
      if (options.deferWrite) {
        pendingOnWritten = onWritten ?? null;
        return Promise.resolve();
      }
      onWritten?.();
      return Promise.resolve();
    },
    syncTrackedBufferType: () => {},
    debugLog: () => {},
  });
  return { handler, settleWrite: () => pendingOnWritten?.() };
}

/** 模拟 terminalService.dispatchOutput 的扇出包装。 */
function dispatch(handler: (data: string, endSeq?: number) => void, data: string, endSeq?: number) {
  const complete = vi.fn();
  deliverTerminalDataWithDeferredCredit(complete, () => handler(data, endSeq));
  return complete;
}

beforeEach(() => {
  _resetSeqTrackersForTest();
});

describe("createTerminalOutputHandler 的流控信用归还", () => {
  it("可见直写：解析完成即归还", () => {
    const { handler } = makeHandler({ visible: true });
    expect(dispatch(handler, "hello", 10)).toHaveBeenCalledTimes(1);
  });

  it("后台标签连续 100 个 chunk 全进隐藏积压，信用仍每次归还", () => {
    // 这是整套机制最容易翻车的地方，也是本文件存在的理由。
    // 锚点账在这条路径上每个 chunk 都 invalidateSeq（terminalOutputHandler.ts:154）；
    // 信用账若跟着一起扣住，后台标签就会让 ACK 永不推进 → 上游窗口关死 →
    // 生产者永久暂停 → 终端彻底卡死。
    const { handler } = makeHandler({ visible: false });
    for (let i = 1; i <= 100; i++) {
      expect(dispatch(handler, `chunk-${i}`, i * 10)).toHaveBeenCalledTimes(1);
    }
  });

  it("隐藏积压溢出丢弃后仍归还（丢掉的字节同样要还信用）", () => {
    const { handler } = makeHandler({ visible: false });
    // 顶破 512KB 上限，push 转为丢弃并返回 null
    const big = "x".repeat(600 * 1024);
    expect(dispatch(handler, big, 10)).toHaveBeenCalledTimes(1);
    expect(dispatch(handler, "after-overflow", 20)).toHaveBeenCalledTimes(1);
  });

  it("xterm 不在时归还（数据整段丢弃）", () => {
    const { handler } = makeHandler({ visible: true, term: null });
    expect(dispatch(handler, "hello", 10)).toHaveBeenCalledTimes(1);
  });

  it("整段被剥空（alt-screen 序列）时归还", () => {
    const hiddenWriteBufferRef: { current: TerminalHiddenWriteBuffer | null } = { current: null };
    const handler = createTerminalOutputHandler({
      sessionId: "s1",
      terminalRef: { current: fakeTerm },
      focusReportModeRef: { current: false },
      hiddenWriteBufferRef,
      isRenderVisible: () => true,
      keepCliOutputInNormalBuffer: true,
      renderTerminalData: () => "", // 全被剥掉
      writeTerminalData: () => Promise.resolve(),
      syncTrackedBufferType: () => {},
      debugLog: () => {},
    });
    expect(dispatch(handler, "\x1b[?1049h", 10)).toHaveBeenCalledTimes(1);
  });

  it("写入失败时归还（一次渲染异常不该变成永久债务）", async () => {
    const { handler } = makeHandler({ visible: true, failWrite: true });
    const complete = dispatch(handler, "hello", 10);
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
  });

  it("写入未完成前不归还——信用反映的是解析完成，不是收到", async () => {
    const { handler, settleWrite } = makeHandler({ visible: true, deferWrite: true });
    const complete = dispatch(handler, "hello", 10);
    // Orca 踩过的坑：在入队时就 ACK，等于告诉上游"消化完了"而实际只是"收到了"
    await Promise.resolve();
    expect(complete).not.toHaveBeenCalled();

    settleWrite();
    expect(complete).toHaveBeenCalledTimes(1);
  });
});
