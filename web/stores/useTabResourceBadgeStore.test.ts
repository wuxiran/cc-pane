// 资源琥珀徽标 store：不随可见清除，只随条件消失清除。
import { beforeEach, describe, expect, it } from "vitest";
import { QUEUED_BADGE_TTL_MS, useTabResourceBadgeStore } from "./useTabResourceBadgeStore";

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

  it("sweepStale 不碰 job-memory（状态字段驱动，没有流可断）", () => {
    const store = useTabResourceBadgeStore.getState();
    store.markResource("jm", { reason: "job-memory", at: 1 });
    expect(useTabResourceBadgeStore.getState().sweepStale(1_000_000, 30_000)).toEqual([]);
    expect(useTabResourceBadgeStore.getState().hasResourceBadge("jm")).toBe(true);
  });

  it("queued 有自己的 60 s TTL：丢了 queued:false 也不会留下永远亮着的 chip", () => {
    const store = useTabResourceBadgeStore.getState();
    store.markResource("q", { reason: "queued", at: 0, queuePosition: 1, queueTotal: 1 });
    // 30 s 的采样器 TTL 不碰它（门禁 25 s 才重发一次）
    expect(useTabResourceBadgeStore.getState().sweepStale(QUEUED_BADGE_TTL_MS, 30_000)).toEqual([]);
    expect(useTabResourceBadgeStore.getState().hasResourceBadge("q")).toBe(true);
    // 刷新把 at 往后推
    store.markResource("q", { reason: "queued", at: QUEUED_BADGE_TTL_MS, queuePosition: 1, queueTotal: 1 });
    expect(useTabResourceBadgeStore.getState().sweepStale(QUEUED_BADGE_TTL_MS * 2, 30_000)).toEqual([]);
    // 之后再没刷新：过 TTL 即清
    expect(useTabResourceBadgeStore.getState().sweepStale(QUEUED_BADGE_TTL_MS * 2 + 1, 30_000)).toEqual(["q"]);
    expect(useTabResourceBadgeStore.getState().hasResourceBadge("q")).toBe(false);
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
