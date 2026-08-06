// 注意标记接线测试：发射条件与自动清除。
import { describe, it, expect } from "vitest";
import { attentionReasonOf } from "./useTabAttentionWiring";

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
