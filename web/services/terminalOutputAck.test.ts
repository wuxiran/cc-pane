import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACK_BATCH_CHARS,
  ACK_FLUSH_MS,
  clearOutputAck,
  flushOutputAck,
  noteOutputConsumed,
  processedEndSeqFor,
  _resetOutputAckForTest,
  _setOutputAckReporterForTest,
} from "./terminalOutputAck";

describe("terminalOutputAck", () => {
  let reported: Array<{ sessionId: string; processedEndSeq: number }>;

  beforeEach(() => {
    vi.useFakeTimers();
    _resetOutputAckForTest();
    reported = [];
    _setOutputAckReporterForTest((sessionId, processedEndSeq) => {
      reported.push({ sessionId, processedEndSeq });
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("按字节阈值刷出", () => {
    noteOutputConsumed("s", 100, ACK_BATCH_CHARS);
    expect(reported).toEqual([{ sessionId: "s", processedEndSeq: 100 }]);
  });

  it("按时间刷出，覆盖低吞吐场景", () => {
    noteOutputConsumed("s", 10, 8);
    expect(reported).toEqual([]);
    vi.advanceTimersByTime(ACK_FLUSH_MS);
    expect(reported).toEqual([{ sessionId: "s", processedEndSeq: 10 }]);
  });

  it("max-merge：迟到/乱序的确认不把游标拽回去", () => {
    // 多视图各写各的 xterm，完成顺序不定；滞后视图的确认会带着更小的 endSeq 到达
    noteOutputConsumed("s", 200, 1);
    noteOutputConsumed("s", 50, 1);
    expect(processedEndSeqFor("s")).toBe(200);

    flushOutputAck("s");
    expect(reported).toEqual([{ sessionId: "s", processedEndSeq: 200 }]);
  });

  it("累计语义让丢失的上报自愈（不产生永久债务）", () => {
    noteOutputConsumed("s", 10, 1);
    flushOutputAck("s");
    // 假设这条上报在传输中丢了；下一次带的是累计值而非增量，上游 max-merge 后即对齐
    noteOutputConsumed("s", 999, 1);
    flushOutputAck("s");
    expect(reported[reported.length - 1]).toEqual({ sessionId: "s", processedEndSeq: 999 });
  });

  it("无变化时不空转上报", () => {
    noteOutputConsumed("s", 10, 1);
    flushOutputAck("s");
    flushOutputAck("s");
    flushOutputAck("s");
    expect(reported).toHaveLength(1);
  });

  it("缺 endSeq 的 chunk 直接忽略（轮询降级路径上游不计 in-flight）", () => {
    noteOutputConsumed("s", undefined, ACK_BATCH_CHARS * 4);
    vi.advanceTimersByTime(ACK_FLUSH_MS * 10);
    expect(reported).toEqual([]);
  });

  it("会话销毁前补发最后一次 ACK，再清账", () => {
    noteOutputConsumed("s", 77, 1);
    expect(reported).toEqual([]); // 还没到阈值

    clearOutputAck("s");
    // 不补发的话上游会把这批字节永远算作在途，同名会话重建后带着旧债起步
    expect(reported).toEqual([{ sessionId: "s", processedEndSeq: 77 }]);
    expect(processedEndSeqFor("s")).toBe(0);
  });

  it("各会话独立计账", () => {
    noteOutputConsumed("a", 10, 1);
    noteOutputConsumed("b", 20, 1);
    flushOutputAck("a");
    expect(reported).toEqual([{ sessionId: "a", processedEndSeq: 10 }]);
    expect(processedEndSeqFor("b")).toBe(20);
  });
});
