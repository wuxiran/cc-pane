import { describe, expect, it, vi } from "vitest";

import { createTerminalHiddenWriteBuffer } from "./terminalHiddenWriteBuffer";

describe("terminalHiddenWriteBuffer", () => {
  it("可见时数据直通", () => {
    const buffer = createTerminalHiddenWriteBuffer({ isVisible: () => true });
    expect(buffer.push("hello")).toBe("hello");
    expect(buffer.pendingLength()).toBe(0);
  });

  it("不可见时积压，drain 一次性取回且保序", () => {
    const buffer = createTerminalHiddenWriteBuffer({ isVisible: () => false });
    expect(buffer.push("a")).toBeNull();
    expect(buffer.push("b")).toBeNull();
    expect(buffer.push("c")).toBeNull();
    expect(buffer.pendingLength()).toBe(3);
    expect(buffer.drain()).toBe("abc");
    expect(buffer.drain()).toBeNull();
  });

  it("变可见后的第一个 chunk 会把积压拼在自己前面（不乱序）", () => {
    let visible = false;
    const buffer = createTerminalHiddenWriteBuffer({ isVisible: () => visible });
    buffer.push("old1");
    buffer.push("old2");

    visible = true;
    expect(buffer.push("new")).toBe("old1old2new");
    expect(buffer.pendingLength()).toBe(0);
  });

  it("积压超上限时整块 flush，且内存归零", () => {
    const onOverflowFlush = vi.fn();
    const buffer = createTerminalHiddenWriteBuffer({
      isVisible: () => false,
      maxPendingChars: 8,
      onOverflowFlush,
    });

    expect(buffer.push("1234")).toBeNull();
    expect(buffer.push("5678")).toBe("12345678");
    expect(onOverflowFlush).toHaveBeenCalledWith(8);
    expect(buffer.pendingLength()).toBe(0);
  });

  it("flush 出来的始终是完整前缀，不切断转义序列", () => {
    const buffer = createTerminalHiddenWriteBuffer({
      isVisible: () => false,
      maxPendingChars: 4,
    });

    // 单个 chunk 就超限时也整块吐出，不做任何切割。
    expect(buffer.push("\x1b[?1049h_long_chunk")).toBe("\x1b[?1049h_long_chunk");
  });

  it("reset 丢弃积压（换绑会话时防串台）", () => {
    const buffer = createTerminalHiddenWriteBuffer({ isVisible: () => false });
    buffer.push("stale");
    buffer.reset();
    expect(buffer.pendingLength()).toBe(0);
    expect(buffer.drain()).toBeNull();
  });

  it("忽略空 chunk", () => {
    const buffer = createTerminalHiddenWriteBuffer({ isVisible: () => true });
    expect(buffer.push("")).toBeNull();
  });
});
