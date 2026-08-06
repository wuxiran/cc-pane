// B2-04 回归网：降档/休眠的判据从「本视图可见」切到「任一视图可见」。
//
// 既有测试覆盖了定时器状态机（terminalBackgroundLifecycle.test.ts）与休眠容器
// （terminalHibernation.test.ts），但**接线层没有回归网**——降档信号源换掉时
// 没有任何测试会挂。这个文件补的就是那一层：store 聚合 → 降档状态机的联动。
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { createTerminalBackgroundLifecycle } from "./terminalBackgroundLifecycle";
import { aggregateOf, selfChatOwnerId, useTabViewStateStore } from "@/stores/useTabViewStateStore";

const TIER1_MS = 5 * 60_000;
const TIER2_MS = 30 * 60_000;

function makeLifecycle() {
  const events: string[] = [];
  const lifecycle = createTerminalBackgroundLifecycle({
    onTier1: () => events.push("tier1"),
    onTier1Restore: () => events.push("tier1-restore"),
    onTier2: () => events.push("tier2"),
    onTier2Restore: () => events.push("tier2-restore"),
  });
  return { lifecycle, events };
}

/** 模拟 TerminalView 的接线：聚合变化 → notifyVisibility。 */
function wire(owner: string, lifecycle: ReturnType<typeof makeLifecycle>["lifecycle"]) {
  lifecycle.notifyVisibility(aggregateOf(owner).anyVisible);
  let last = aggregateOf(owner).anyVisible;
  return useTabViewStateStore.subscribe((state) => {
    const next = state.aggregate[owner]?.anyVisible ?? false;
    if (next === last) return;
    last = next;
    lifecycle.notifyVisibility(next);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  useTabViewStateStore.setState({ views: {}, aggregate: {} });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("同一 PTY 多视图：任一可见就不降档", () => {
  it("主视图隐藏但镜像可见 → 不进 Tier1/Tier2（修「星标页在看、原 tab 休眠」）", () => {
    const store = useTabViewStateStore.getState();
    store.reportView("t1", "primary", "active");
    store.reportView("t1", "mirror", "hidden");

    const { lifecycle, events } = makeLifecycle();
    const unsub = wire("t1", lifecycle);

    // 用户切到星标页：主视图隐藏，镜像变可见
    store.reportView("t1", "primary", "hidden");
    store.reportView("t1", "mirror", "visible");

    vi.advanceTimersByTime(TIER2_MS + 1000);
    expect(events).toEqual([]);

    unsub();
    lifecycle.dispose();
  });

  it("全部视图隐藏后才开始计时，5min 进 Tier1、30min 进 Tier2", () => {
    const store = useTabViewStateStore.getState();
    store.reportView("t1", "primary", "active");

    const { lifecycle, events } = makeLifecycle();
    const unsub = wire("t1", lifecycle);

    store.reportView("t1", "primary", "hidden");

    vi.advanceTimersByTime(TIER1_MS);
    expect(events).toEqual(["tier1"]);

    vi.advanceTimersByTime(TIER2_MS - TIER1_MS);
    expect(events).toEqual(["tier1", "tier2"]);

    unsub();
    lifecycle.dispose();
  });

  it("降档后任一视图恢复可见 → 唤醒", () => {
    const store = useTabViewStateStore.getState();
    store.reportView("t1", "primary", "hidden");

    const { lifecycle, events } = makeLifecycle();
    const unsub = wire("t1", lifecycle);

    vi.advanceTimersByTime(TIER2_MS + 1000);
    expect(events).toContain("tier2");

    // 弹窗打开（不是主视图）也应当唤醒
    store.reportView("t1", "popup", "active");
    expect(events).toContain("tier2-restore");

    unsub();
    lifecycle.dispose();
  });

  it("镜像退场后只剩隐藏主视图 → 计时重新开始", () => {
    const store = useTabViewStateStore.getState();
    store.reportView("t1", "primary", "hidden");
    store.reportView("t1", "mirror", "visible");

    const { lifecycle, events } = makeLifecycle();
    const unsub = wire("t1", lifecycle);

    vi.advanceTimersByTime(TIER2_MS + 1000);
    expect(events).toEqual([]);

    store.removeView("t1", "mirror");
    vi.advanceTimersByTime(TIER1_MS);
    expect(events).toEqual(["tier1"]);

    unsub();
    lifecycle.dispose();
  });
});

describe("React19 dev 双挂载不产生假边沿", () => {
  it("removeView 后同周期 report 复位 → 不触发降档计时", () => {
    const store = useTabViewStateStore.getState();
    store.reportView("t1", "primary", "active");

    const { lifecycle, events } = makeLifecycle();
    const unsub = wire("t1", lifecycle);

    // cleanup → mount
    store.removeView("t1", "primary");
    store.reportView("t1", "primary", "active");

    vi.advanceTimersByTime(TIER2_MS + 1000);
    expect(events).toEqual([]);

    unsub();
    lifecycle.dispose();
  });
});

// 注意：以下弹窗用例把 popup 与 primary 接进**同一份** store——生产里两者在
// 不同 WebView（各一份 store），这个组合不会出现。用例测的是 store 的聚合
// 语义本身；跨窗口场景的行为正确性依赖「主窗口对弹出标签不挂 TerminalView」。
describe("弹窗与 SelfChat 的可见性语义（B2-05）", () => {
  it("弹窗最小化但主标签可见 → 该会话不降档（同一 PTY 两路视图）", () => {
    const store = useTabViewStateStore.getState();
    store.reportView("t1", "primary", "active");
    store.reportView("t1", "popup", "active");

    const { lifecycle, events } = makeLifecycle();
    const unsub = wire("t1", lifecycle);

    // 弹窗最小化
    store.reportView("t1", "popup", "hidden");
    vi.advanceTimersByTime(TIER2_MS + 1000);

    expect(events).toEqual([]);
    unsub();
    lifecycle.dispose();
  });

  it("主标签切走 + 弹窗最小化 → 两路都隐藏才降档", () => {
    const store = useTabViewStateStore.getState();
    store.reportView("t1", "primary", "active");
    store.reportView("t1", "popup", "visible");

    const { lifecycle, events } = makeLifecycle();
    const unsub = wire("t1", lifecycle);

    store.reportView("t1", "primary", "hidden");
    vi.advanceTimersByTime(TIER1_MS);
    expect(events).toEqual([]); // 弹窗还开着

    store.reportView("t1", "popup", "hidden");
    vi.advanceTimersByTime(TIER1_MS);
    expect(events).toEqual(["tier1"]);

    unsub();
    lifecycle.dispose();
  });

  it("SelfChat 的 owner 与标签命名空间隔离", () => {
    const store = useTabViewStateStore.getState();
    store.reportView(selfChatOwnerId("s1"), "selfchat", "active");
    store.reportView("s1", "primary", "hidden");

    expect(aggregateOf(selfChatOwnerId("s1")).anyVisible).toBe(true);
    expect(aggregateOf("s1").anyVisible).toBe(false);
  });
});

describe("轴1 输入豁免（归段判定接进休眠）", () => {
  it("忙碌段的近期输入挡住休眠判定；waitingInput 段不挡", async () => {
    const { inputBlocksHibernation } = await import("@/stores/useTerminalInputActivityStore");
    const now = 5_000_000;
    // 草稿：working 段输入 → 挡
    expect(inputBlocksHibernation({ lastInputAt: now, segment: "thinking" }, now + 1000)).toBe(true);
    // 已答完：waitingInput 段输入 → 不挡（否则确认过一次就永不休眠）
    expect(inputBlocksHibernation({ lastInputAt: now, segment: "waitingInput" }, now + 1000)).toBe(false);
  });
});
