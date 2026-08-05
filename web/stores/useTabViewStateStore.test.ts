// 可见性单源 store 的契约测试（docs/78 批2 · B2-01）。
//
// 这个 store 之后要承载降档/休眠的唯一判据，所以测的重点不是「能存能取」，
// 而是三件容易出事的事：
//   1. 聚合语义（任一视图可见就不休眠）
//   2. 幂等与写前 diff（React19 dev 双挂载会 report/remove 各来两次）
//   3. foregroundLastSeenAt 不被 remove-再-report 重置（否则休眠时长 dev/prod 分叉）
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  aggregateOf,
  selfChatOwnerId,
  useTabViewStateStore,
  viewKey,
  type ViewRole,
} from "./useTabViewStateStore";

const ALL_ROLES: readonly ViewRole[] = ["primary", "mirror", "popup", "selfchat"];

function reset() {
  useTabViewStateStore.setState({ views: {}, aggregate: {} });
}

beforeEach(reset);
afterEach(() => vi.useRealTimers());

describe("视图登记与取用", () => {
  it("每种 role 都能登记并取回（穷举，新增 role 必须同步本测试）", () => {
    const store = useTabViewStateStore.getState();
    for (const role of ALL_ROLES) {
      store.reportView("t1", role, "visible");
    }
    for (const role of ALL_ROLES) {
      expect(useTabViewStateStore.getState().getViewVisibility("t1", role)).toBe("visible");
    }
    expect(Object.keys(useTabViewStateStore.getState().views).sort()).toEqual(
      ALL_ROLES.map((r) => viewKey("t1", r)).sort(),
    );
  });

  it("owner 隔离：不同 owner 的同名 role 互不干扰", () => {
    const store = useTabViewStateStore.getState();
    store.reportView("t1", "primary", "active");
    store.reportView("t2", "primary", "hidden");

    expect(aggregateOf("t1").anyActive).toBe(true);
    expect(aggregateOf("t2").anyVisible).toBe(false);
  });

  it("SelfChat 用独立 owner 标识（它没有 tabId）", () => {
    const owner = selfChatOwnerId("sess-abc");
    expect(owner).toBe("selfchat:sess-abc");

    useTabViewStateStore.getState().reportView(owner, "selfchat", "active");
    expect(aggregateOf(owner).anyVisible).toBe(true);
    // 不污染标签的键空间
    expect(aggregateOf("sess-abc").anyVisible).toBe(false);
  });
});

describe("聚合语义：任一视图可见就不休眠", () => {
  it("主视图隐藏但镜像可见 → anyVisible 为真（修「星标页在看、原 tab 休眠」）", () => {
    const store = useTabViewStateStore.getState();
    store.reportView("t1", "primary", "hidden");
    store.reportView("t1", "mirror", "visible");

    expect(aggregateOf("t1").anyVisible).toBe(true);
  });

  it("全部视图隐藏 → anyVisible 为假", () => {
    const store = useTabViewStateStore.getState();
    store.reportView("t1", "primary", "hidden");
    store.reportView("t1", "popup", "hidden");

    expect(aggregateOf("t1").anyVisible).toBe(false);
    expect(aggregateOf("t1").anyActive).toBe(false);
  });

  it("visible 不等于 active：分屏非焦点格算可见但不算活跃", () => {
    useTabViewStateStore.getState().reportView("t1", "primary", "visible");
    const agg = aggregateOf("t1");
    expect(agg.anyVisible).toBe(true);
    expect(agg.anyActive).toBe(false);
  });

  it("弹窗可见即可挡住休眠（弹窗开着的会话不休眠）", () => {
    const store = useTabViewStateStore.getState();
    store.reportView("t1", "primary", "hidden");
    store.reportView("t1", "popup", "active");

    expect(aggregateOf("t1").anyVisible).toBe(true);
    expect(aggregateOf("t1").anyActive).toBe(true);
  });

  it("无任何视图的 owner → 安全默认为不可见（宁可降档，不把已死视图当活的）", () => {
    expect(aggregateOf("never-seen")).toEqual({
      anyVisible: false,
      anyActive: false,
      foregroundLastSeenAt: null,
      lastReportedVisible: false,
    });
  });
});

describe("写前 diff 与幂等（React19 dev 双挂载）", () => {
  it("同值重复 report 不产生新状态对象（否则每帧唤醒全部订阅者）", () => {
    const store = useTabViewStateStore.getState();
    store.reportView("t1", "primary", "active");
    const snapshot = useTabViewStateStore.getState().views;

    store.reportView("t1", "primary", "active");
    expect(useTabViewStateStore.getState().views).toBe(snapshot);
  });

  it("removeView 幂等：不存在的视图重复移除不写状态", () => {
    const store = useTabViewStateStore.getState();
    store.reportView("t1", "primary", "active");
    store.removeView("t1", "primary");
    const snapshot = useTabViewStateStore.getState();

    store.removeView("t1", "primary");
    expect(useTabViewStateStore.getState().views).toBe(snapshot.views);
    expect(useTabViewStateStore.getState().aggregate).toBe(snapshot.aggregate);
  });

  it("remove 后同周期 report 复位：聚合回到原值，不留假边沿", () => {
    const store = useTabViewStateStore.getState();
    store.reportView("t1", "primary", "active");
    const before = aggregateOf("t1");

    // dev 双挂载：cleanup → mount
    store.removeView("t1", "primary");
    store.reportView("t1", "primary", "active");

    const after = aggregateOf("t1");
    expect(after.anyVisible).toBe(before.anyVisible);
    expect(after.anyActive).toBe(before.anyActive);
  });

  it("**foregroundLastSeenAt 不被 remove-再-report 重置**（否则休眠时长 dev/prod 分叉）", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-06T00:00:00Z"));

    const store = useTabViewStateStore.getState();
    store.reportView("t1", "primary", "visible");
    const firstSeen = aggregateOf("t1").foregroundLastSeenAt;
    expect(firstSeen).toBe(Date.now());

    vi.setSystemTime(new Date("2026-08-06T00:10:00Z"));
    store.removeView("t1", "primary");
    store.reportView("t1", "primary", "visible");

    expect(aggregateOf("t1").foregroundLastSeenAt).toBe(firstSeen);
  });

  it("真正的隐藏→可见边沿才推进 foregroundLastSeenAt", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-06T00:00:00Z"));

    const store = useTabViewStateStore.getState();
    store.reportView("t1", "primary", "visible");
    const first = aggregateOf("t1").foregroundLastSeenAt;

    vi.setSystemTime(new Date("2026-08-06T00:05:00Z"));
    store.reportView("t1", "primary", "hidden");
    expect(aggregateOf("t1").foregroundLastSeenAt).toBe(first);

    vi.setSystemTime(new Date("2026-08-06T00:09:00Z"));
    store.reportView("t1", "primary", "visible");
    expect(aggregateOf("t1").foregroundLastSeenAt).toBe(Date.now());
  });
});

describe("清理", () => {
  it("移除最后一个视图：视图清空，聚合置不可见但**保留条目**", () => {
    const store = useTabViewStateStore.getState();
    store.reportView("t1", "primary", "active");
    store.removeView("t1", "primary");

    // 条目保留是有意的：dev 双挂载 cleanup→mount 期间若删掉，
    // foregroundLastSeenAt 会丢失，休眠时长 dev/prod 分叉。
    expect(useTabViewStateStore.getState().views).toEqual({});
    expect(aggregateOf("t1").anyVisible).toBe(false);
    expect(useTabViewStateStore.getState().aggregate.t1).toBeDefined();
  });

  it("owner 表的清理归 removeOwner（tab 真正销毁时由批1 出口调）", () => {
    const store = useTabViewStateStore.getState();
    store.reportView("t1", "primary", "active");
    store.removeView("t1", "primary");
    store.removeOwner("t1");

    expect(useTabViewStateStore.getState().aggregate.t1).toBeUndefined();
  });

  it("还有其他视图时保留聚合并重算", () => {
    const store = useTabViewStateStore.getState();
    store.reportView("t1", "primary", "active");
    store.reportView("t1", "mirror", "hidden");

    store.removeView("t1", "primary");

    const agg = aggregateOf("t1");
    expect(agg.anyVisible).toBe(false);
    expect(agg.anyActive).toBe(false);
  });

  it("removeOwner 清掉该 owner 的全部视图，不碰别人", () => {
    const store = useTabViewStateStore.getState();
    store.reportView("t1", "primary", "active");
    store.reportView("t1", "popup", "visible");
    store.reportView("t2", "primary", "active");

    store.removeOwner("t1");

    expect(useTabViewStateStore.getState().aggregate.t1).toBeUndefined();
    expect(aggregateOf("t2").anyActive).toBe(true);
    expect(Object.keys(useTabViewStateStore.getState().views)).toEqual([viewKey("t2", "primary")]);
  });

  it("removeOwner 幂等", () => {
    const store = useTabViewStateStore.getState();
    store.removeOwner("nobody");
    expect(useTabViewStateStore.getState().views).toEqual({});
  });
});
