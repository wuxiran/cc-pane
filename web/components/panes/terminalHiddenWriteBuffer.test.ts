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

  it("隐藏输出超上限后停止接收，且不把积压转移到 xterm 写队列", () => {
    const onOverflowDrop = vi.fn();
    const buffer = createTerminalHiddenWriteBuffer({
      isVisible: () => false,
      maxPendingChars: 8,
      onOverflowDrop,
    });

    expect(buffer.push("1234")).toBeNull();
    expect(buffer.push("5678")).toBeNull();
    expect(buffer.push("9")).toBeNull();
    expect(buffer.push("more output")).toBeNull();

    expect(buffer.pendingLength()).toBe(8);
    expect(onOverflowDrop).toHaveBeenCalledTimes(1);
    expect(onOverflowDrop).toHaveBeenCalledWith(1);

    const drained = buffer.drain();
    expect(drained).toContain("12345678");
    expect(drained).toContain("Hidden terminal output was truncated");
    expect(buffer.pendingLength()).toBe(0);
  });

  it("单个超大 chunk 不会被保留或切开", () => {
    const buffer = createTerminalHiddenWriteBuffer({
      isVisible: () => false,
      maxPendingChars: 4,
    });

    expect(buffer.push("\x1b[?1049h_long_chunk")).toBeNull();
    expect(buffer.pendingLength()).toBe(0);
    expect(buffer.drain()).toContain("Hidden terminal output was truncated");
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
