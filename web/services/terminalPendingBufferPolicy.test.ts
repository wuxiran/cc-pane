import { beforeEach, describe, expect, it } from "vitest";
import {
  appendPendingOutput,
  clearAllPendingOutput,
  clearPendingOutput,
  consumeLatchedDesync,
  PENDING_BUFFER_MAX_CHARS,
  pendingChunkCount,
  takePendingOutput,
} from "./terminalPendingBufferPolicy";

/** 拼一个刚好把上限顶破的 chunk。 */
function oversizedChunk(): string {
  return "x".repeat(PENDING_BUFFER_MAX_CHARS + 1);
}

describe("terminalPendingBufferPolicy", () => {
  beforeEach(() => {
    clearAllPendingOutput();
  });

  it("在上限内正常暂存并原样交还，含 endSeq", () => {
    expect(appendPendingOutput("s", "hello", 5)).toBe("buffered");
    expect(appendPendingOutput("s", "world", 10)).toBe("buffered");
    expect(pendingChunkCount("s")).toBe(2);

    // endSeq 必须透传：丢了它 anchorCandidate 会因 received≠written 恒返回 null，
    // 该会话此后再也拍不出 checkpoint（terminalOutputSeqTracker.ts:109）。
    expect(takePendingOutput("s")).toEqual([
      { data: "hello", endSeq: 5 },
      { data: "world", endSeq: 10 },
    ]);
    // 取走即清空
    expect(takePendingOutput("s")).toEqual([]);
  });

  it("溢出时整体作废而不是切断 VT 流", () => {
    appendPendingOutput("s", "\x1b[38;5;", 7); // 半截 SGR 序列
    expect(appendPendingOutput("s", oversizedChunk())).toBe("overflowed");

    // 旧行为是 splice 掉最旧一半、保留后半段——那会把上面这条 SGR 从中间切开送进
    // xterm。新行为整段作废，改由 snapshot 重放重建，符合 §3.1 desync 契约。
    expect(takePendingOutput("s")).toEqual([]);
  });

  it("溢出后续 chunk 返回 discarded，不重复要求广播 desync", () => {
    expect(appendPendingOutput("s", oversizedChunk())).toBe("overflowed");
    // 洪流下这里每个 chunk 都会命中；逐次广播会变成 desync 风暴
    expect(appendPendingOutput("s", "a")).toBe("discarded");
    expect(appendPendingOutput("s", "b")).toBe("discarded");
    expect(pendingChunkCount("s")).toBe(0);
  });

  it("闩锁供迟到的订阅者消费，且只消费一次", () => {
    appendPendingOutput("s", oversizedChunk());
    // 溢出发生在无订阅者期间，当时广播必然落空——闩锁是唯一的补投通道
    expect(consumeLatchedDesync("s")).toBe(true);
    expect(consumeLatchedDesync("s")).toBe(false);
  });

  it("未溢出的会话不留闩锁", () => {
    appendPendingOutput("s", "hello", 5);
    expect(consumeLatchedDesync("s")).toBe(false);
  });

  it("会话清理同时清掉暂存与闩锁", () => {
    appendPendingOutput("s", oversizedChunk());
    clearPendingOutput("s");
    expect(consumeLatchedDesync("s")).toBe(false);
    expect(pendingChunkCount("s")).toBe(0);
  });

  it("各会话独立计账", () => {
    appendPendingOutput("a", oversizedChunk());
    expect(appendPendingOutput("b", "fine", 1)).toBe("buffered");
    expect(takePendingOutput("b")).toEqual([{ data: "fine", endSeq: 1 }]);
    expect(consumeLatchedDesync("b")).toBe(false);
  });
});
