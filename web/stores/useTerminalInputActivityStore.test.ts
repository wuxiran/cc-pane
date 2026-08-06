// 轴1 输入归段测试（B2-10）。
//
// 归段判定的价值全在一条边界上：**答过一次权限确认的会话，不该永远不休眠**。
// 单纯的「最近有输入就不休眠」冷却窗口做不到这点。
import { describe, it, expect, beforeEach } from "vitest";
import {
  INPUT_ACTIVE_WINDOW_MS,
  inputBlocksHibernation,
  useTerminalInputActivityStore,
} from "./useTerminalInputActivityStore";

beforeEach(() => {
  useTerminalInputActivityStore.setState({ entries: {} });
});

describe("输入活跃窗口", () => {
  it("刚输入过 → 活跃", () => {
    const now = 1_000_000;
    useTerminalInputActivityStore.getState().recordInput("s1", "thinking", now);
    expect(useTerminalInputActivityStore.getState().isInputActive("s1", now + 1000)).toBe(true);
  });

  it("超出窗口 → 不活跃", () => {
    const now = 1_000_000;
    useTerminalInputActivityStore.getState().recordInput("s1", "thinking", now);
    expect(
      useTerminalInputActivityStore.getState().isInputActive("s1", now + INPUT_ACTIVE_WINDOW_MS),
    ).toBe(false);
  });

  it("从未输入过 → 不活跃", () => {
    expect(useTerminalInputActivityStore.getState().isInputActive("nobody")).toBe(false);
  });

  it("会话清理后记录消失", () => {
    useTerminalInputActivityStore.getState().recordInput("s1", "idle");
    useTerminalInputActivityStore.getState().clearSession("s1");
    expect(useTerminalInputActivityStore.getState().getEntry("s1")).toBeUndefined();
  });
});

describe("输入归段：决定要不要挡住休眠", () => {
  const now = 2_000_000;

  it("忙碌段里打字 = 正在写草稿 → 挡住休眠", () => {
    const entry = { lastInputAt: now, segment: "thinking" };
    expect(inputBlocksHibernation(entry, now + 1000)).toBe(true);
  });

  it("**waitingInput 段里打字 = 已答完那个问题 → 不挡**（否则确认过一次就永不休眠）", () => {
    const entry = { lastInputAt: now, segment: "waitingInput" };
    expect(inputBlocksHibernation(entry, now + 1000)).toBe(false);
  });

  it("窗口外的输入无论哪个段都不挡", () => {
    const entry = { lastInputAt: now, segment: "thinking" };
    expect(inputBlocksHibernation(entry, now + INPUT_ACTIVE_WINDOW_MS)).toBe(false);
  });

  it("无记录不挡", () => {
    expect(inputBlocksHibernation(undefined)).toBe(false);
  });
});
