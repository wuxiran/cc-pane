// 资源琥珀徽标 store：不随可见清除，只随条件消失清除。
import { beforeEach, describe, expect, it } from "vitest";
import { useTabResourceBadgeStore } from "./useTabResourceBadgeStore";

beforeEach(() => {
  useTabResourceBadgeStore.setState({ entries: {} });
});

describe("useTabResourceBadgeStore", () => {
  it("标记后可查，带读数", () => {
    useTabResourceBadgeStore
      .getState()
      .markResource("t1", { reason: "cpu", sessionId: "s1", cpuPercent: 320, memoryBytes: 1024, at: 5 });
    const entry = useTabResourceBadgeStore.getState().getResourceBadge("t1");
    expect(entry).toEqual({ reason: "cpu", at: 5, sessionId: "s1", cpuPercent: 320, memoryBytes: 1024 });
    expect(useTabResourceBadgeStore.getState().hasResourceBadge("t1")).toBe(true);
  });

  it("高优先级原因不被低优先级覆盖，但时间戳刷新", () => {
    const store = useTabResourceBadgeStore.getState();
    store.markResource("t1", { reason: "job-memory", at: 1 });
    store.markResource("t1", { reason: "cpu", at: 9 });
    const entry = useTabResourceBadgeStore.getState().getResourceBadge("t1")!;
    expect(entry.reason).toBe("job-memory");
    expect(entry.at).toBe(9);
  });

  it("低优先级可被高优先级升级", () => {
    const store = useTabResourceBadgeStore.getState();
    store.markResource("t1", { reason: "cpu" });
    store.markResource("t1", { reason: "queued" });
    expect(useTabResourceBadgeStore.getState().getResourceBadge("t1")?.reason).toBe("queued");
  });

  it("clearReason 只清同源原因：cpu/memory 同源，job-memory 不受采样器撤销影响", () => {
    const store = useTabResourceBadgeStore.getState();
    store.markResource("t1", { reason: "memory" });
    store.clearReason("t1", "cpu");
    expect(useTabResourceBadgeStore.getState().hasResourceBadge("t1")).toBe(false);

    store.markResource("t2", { reason: "job-memory" });
    store.clearReason("t2", "cpu");
    expect(useTabResourceBadgeStore.getState().hasResourceBadge("t2")).toBe(true);
    store.clearReason("t2", "job-memory");
    expect(useTabResourceBadgeStore.getState().hasResourceBadge("t2")).toBe(false);
  });

  it("sweepStale 按 TTL 清掉断流条目并返回 owner", () => {
    const store = useTabResourceBadgeStore.getState();
    store.markResource("old", { reason: "cpu", at: 1_000 });
    store.markResource("fresh", { reason: "cpu", at: 40_000 });
    const swept = useTabResourceBadgeStore.getState().sweepStale(50_000, 30_000);
    expect(swept).toEqual(["old"]);
    expect(useTabResourceBadgeStore.getState().hasResourceBadge("old")).toBe(false);
    expect(useTabResourceBadgeStore.getState().hasResourceBadge("fresh")).toBe(true);
    expect(useTabResourceBadgeStore.getState().sweepStale(50_000, 30_000)).toEqual([]);
  });

  it("sweepStale 不碰状态驱动的原因（job-memory / queued 没有流可断）", () => {
    const store = useTabResourceBadgeStore.getState();
    store.markResource("jm", { reason: "job-memory", at: 1 });
    store.markResource("q", { reason: "queued", at: 1 });
    expect(useTabResourceBadgeStore.getState().sweepStale(1_000_000, 30_000)).toEqual([]);
    expect(useTabResourceBadgeStore.getState().hasResourceBadge("jm")).toBe(true);
    expect(useTabResourceBadgeStore.getState().hasResourceBadge("q")).toBe(true);
  });

  it("clearResource 无条件清；不存在时不触发更新", () => {
    const store = useTabResourceBadgeStore.getState();
    store.markResource("t1", { reason: "queued" });
    store.clearResource("t1");
    expect(useTabResourceBadgeStore.getState().hasResourceBadge("t1")).toBe(false);
    const before = useTabResourceBadgeStore.getState().entries;
    store.clearResource("missing");
    expect(useTabResourceBadgeStore.getState().entries).toBe(before);
  });
});
