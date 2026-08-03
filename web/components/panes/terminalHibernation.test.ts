import { describe, expect, it, vi } from "vitest";
import { createHibernatedTerminalState } from "./terminalHibernation";

describe("createHibernatedTerminalState", () => {
  it("基底 + 追加按序拼接（VT 流保序）", () => {
    const state = createHibernatedTerminalState({ sessionId: "s-1", base: "BASE" });
    state.appendRendered("chunk-1");
    state.appendRendered("chunk-2");

    expect(state.wakeData()).toBe("BASEchunk-1chunk-2");
    expect(state.didOverflow()).toBe(false);
  });

  it("超上限整体作废并释放，wakeData 返回 null", () => {
    const onOverflow = vi.fn();
    const state = createHibernatedTerminalState({
      sessionId: "s-1",
      base: "12345",
      maxChars: 10,
      onOverflow,
    });
    state.appendRendered("67890"); // 恰好到 10，不溢出
    expect(state.didOverflow()).toBe(false);

    state.appendRendered("x"); // 越界 → 作废
    expect(state.didOverflow()).toBe(true);
    expect(state.wakeData()).toBeNull();
    expect(state.pendingChars()).toBe(0);
    expect(onOverflow).toHaveBeenCalledTimes(1);

    // 作废后继续追加是 no-op，不重复回调
    state.appendRendered("y");
    expect(onOverflow).toHaveBeenCalledTimes(1);
  });

  it("基底本身超上限时立即作废", () => {
    const state = createHibernatedTerminalState({
      sessionId: "s-1",
      base: "toolong",
      maxChars: 3,
    });
    expect(state.didOverflow()).toBe(true);
    expect(state.wakeData()).toBeNull();
  });

  it("markDesynced 整体作废（休眠期间镜像流跳段 → 唤醒必须走 snapshot）", () => {
    const onOverflow = vi.fn();
    const state = createHibernatedTerminalState({ sessionId: "s-1", base: "BASE", onOverflow });
    state.appendRendered("chunk");
    state.markDesynced();

    expect(state.didOverflow()).toBe(true);
    expect(state.wakeData()).toBeNull();
    expect(state.pendingChars()).toBe(0);
    expect(onOverflow).toHaveBeenCalledTimes(1);
    // 作废后再 markDesynced/append 均为 no-op
    state.markDesynced();
    state.appendRendered("late");
    expect(onOverflow).toHaveBeenCalledTimes(1);
  });

  it("记录休眠期间的退出码", () => {
    const state = createHibernatedTerminalState({ sessionId: "s-1", base: "" });
    expect(state.exitCode()).toBeNull();
    state.recordExit(3);
    expect(state.exitCode()).toBe(3);
  });
});
