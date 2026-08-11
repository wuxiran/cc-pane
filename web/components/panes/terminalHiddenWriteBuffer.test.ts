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

  it("合并大量微小 chunk，避免隐藏缓冲保留无界字符串对象", () => {
    const buffer = createTerminalHiddenWriteBuffer({ isVisible: () => false });

    for (let index = 0; index < 10_000; index += 1) {
      buffer.push("x");
    }

    expect(buffer.pendingLength()).toBe(10_000);
    expect(buffer.pendingChunkCount()).toBeLessThanOrEqual(192);
    expect(buffer.drain()).toBe("x".repeat(10_000));
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

  it("didOverflow 标记溢出，drain/reset 后清除（可见性回归据此改走 snapshot 重放）", () => {
    const buffer = createTerminalHiddenWriteBuffer({
      isVisible: () => false,
      maxPendingChars: 4,
    });

    expect(buffer.didOverflow()).toBe(false);
    buffer.push("12345");
    expect(buffer.didOverflow()).toBe(true);

    buffer.drain();
    expect(buffer.didOverflow()).toBe(false);

    buffer.push("67890");
    expect(buffer.didOverflow()).toBe(true);
    buffer.reset();
    expect(buffer.didOverflow()).toBe(false);
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

// B2-07 复核：两条 flush 防线覆盖的场景不同，删任何一条都会丢字。
describe("drain-on-push 的覆盖边界（为什么边沿 flush 不能删）", () => {
  it("可见后有新数据 → 积压被 drain-on-push 带出来（防线一生效）", () => {
    let visible = false;
    const buffer = createTerminalHiddenWriteBuffer({ isVisible: () => visible });

    expect(buffer.push("backlog")).toBeNull();
    visible = true;
    // 新数据到来时，积压拼在前面（顺序正确）
    expect(buffer.push("fresh")).toBe("backlogfresh");
  });

  it("**可见后没有新数据 → 积压出不来**（防线一够不着，必须靠边沿 flush）", () => {
    let visible = false;
    const buffer = createTerminalHiddenWriteBuffer({ isVisible: () => visible });

    expect(buffer.push("backlog")).toBeNull();
    visible = true;

    // 会话已经跑完，不再有 push——积压只能靠调用方在可见性边沿主动 flush，
    // 否则屏幕永远停在切走前的样子。
    expect(buffer.drain()).toBe("backlog");
  });
});
