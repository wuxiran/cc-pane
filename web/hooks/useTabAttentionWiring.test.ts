// 注意标记接线测试：发射条件与自动清除。
import { describe, it, expect } from "vitest";
import { attentionReasonOf, MIN_BUSY_FOR_DONE_MS } from "./useTabAttentionWiring";

describe("attentionReasonOf", () => {
  it("三种终态映射到注意原因", () => {
    expect(attentionReasonOf("error")).toBe("error");
    expect(attentionReasonOf("waitingInput")).toBe("waiting-input");
    expect(attentionReasonOf("exited")).toBe("completed");
  });

  it("运行中/空闲态不产生标记", () => {
    expect(attentionReasonOf("thinking")).toBeNull();
    expect(attentionReasonOf("toolRunning")).toBeNull();
    expect(attentionReasonOf("idle")).toBeNull();
    expect(attentionReasonOf("initializing")).toBeNull();
  });
});

describe("attentionReasonOf: agent 一轮跑完", () => {
  it("hook 忙碌态 → idle 且忙够时长 = completed", () => {
    expect(attentionReasonOf("idle", "thinking", MIN_BUSY_FOR_DONE_MS)).toBe("completed");
    expect(attentionReasonOf("idle", "toolRunning", 60_000)).toBe("completed");
    expect(attentionReasonOf("idle", "compacting", 60_000)).toBe("completed");
  });

  it("忙碌太短不算（启动握手 / 秒回）", () => {
    expect(attentionReasonOf("idle", "thinking", MIN_BUSY_FOR_DONE_MS - 1)).toBeNull();
  });

  it("legacy active（PTY 输出推断）→ idle 不算，避免 dev server 刷屏", () => {
    expect(attentionReasonOf("idle", "active", 60_000)).toBeNull();
  });

  it("首次见到就是 idle 不算", () => {
    expect(attentionReasonOf("idle", undefined, 60_000)).toBeNull();
  });
});
