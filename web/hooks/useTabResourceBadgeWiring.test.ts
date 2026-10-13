// 资源琥珀徽标接线：事件 → store，封账撤销，owner 解析。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePanesStore } from "@/stores";
import { useTabResourceBadgeStore } from "@/stores/useTabResourceBadgeStore";
import {
  applyHeavyQueueChanged,
  applyHeavySessionUsage,
  resourceBadgeReasonOf,
} from "./useTabResourceBadgeWiring";

function stubLocation(sessionId: string, tabId: string | null) {
  vi.spyOn(usePanesStore.getState(), "findTabBySessionAcrossLayouts").mockImplementation((id) =>
    id === sessionId && tabId
      ? ({ tab: { id: tabId } } as unknown as ReturnType<
          ReturnType<typeof usePanesStore.getState>["findTabBySessionAcrossLayouts"]
        >)
      : null,
  );
}

beforeEach(() => {
  useTabResourceBadgeStore.setState({ entries: {} });
  vi.restoreAllMocks();
});

describe("resourceBadgeReasonOf", () => {
  it("树 CPU 到一个核算 cpu，否则按内存触发", () => {
    expect(resourceBadgeReasonOf({ sessionId: "s", cpuPercent: 100, memoryBytes: 1, active: true })).toBe("cpu");
    expect(resourceBadgeReasonOf({ sessionId: "s", cpuPercent: 350, memoryBytes: 1, active: true })).toBe("cpu");
    expect(resourceBadgeReasonOf({ sessionId: "s", cpuPercent: 3, memoryBytes: 3e9, active: true })).toBe("memory");
  });
});

describe("applyHeavySessionUsage", () => {
  it("active 事件按会话所在标签打琥珀点，并带读数与 sessionId", () => {
    stubLocation("s1", "tab-1");
    applyHeavySessionUsage({ sessionId: "s1", cpuPercent: 420, memoryBytes: 2048, active: true });
    const entry = useTabResourceBadgeStore.getState().getResourceBadge("tab-1");
    expect(entry?.reason).toBe("cpu");
    expect(entry?.sessionId).toBe("s1");
    expect(entry?.cpuPercent).toBe(420);
    expect(entry?.memoryBytes).toBe(2048);
  });

  it("active:false（封账）撤销采样器原因，但不碰 job-memory", () => {
    stubLocation("s1", "tab-1");
    applyHeavySessionUsage({ sessionId: "s1", cpuPercent: 420, memoryBytes: 1, active: true });
    applyHeavySessionUsage({ sessionId: "s1", cpuPercent: 0, memoryBytes: 0, active: false });
    expect(useTabResourceBadgeStore.getState().hasResourceBadge("tab-1")).toBe(false);

    useTabResourceBadgeStore.getState().markResource("tab-1", { reason: "job-memory" });
    applyHeavySessionUsage({ sessionId: "s1", cpuPercent: 0, memoryBytes: 0, active: false });
    expect(useTabResourceBadgeStore.getState().getResourceBadge("tab-1")?.reason).toBe("job-memory");
  });

  it("会话不在本实例任何布局里：忽略", () => {
    stubLocation("s1", null);
    applyHeavySessionUsage({ sessionId: "s1", cpuPercent: 420, memoryBytes: 1, active: true });
    expect(useTabResourceBadgeStore.getState().entries).toEqual({});
  });
});

describe("applyHeavyQueueChanged（W8 门禁排队 chip）", () => {
  it("queued:true 按会话所在标签打 queued 徽标并带位次", () => {
    stubLocation("s1", "tab-1");
    applyHeavyQueueChanged({ sessionId: "s1", position: 2, total: 4, queued: true });
    const entry = useTabResourceBadgeStore.getState().getResourceBadge("tab-1");
    expect(entry?.reason).toBe("queued");
    expect(entry?.sessionId).toBe("s1");
    expect(entry?.queuePosition).toBe(2);
    expect(entry?.queueTotal).toBe(4);
  });

  it("位次变化刷新数字；queued:false 撤销", () => {
    stubLocation("s1", "tab-1");
    applyHeavyQueueChanged({ sessionId: "s1", position: 2, total: 4, queued: true });
    applyHeavyQueueChanged({ sessionId: "s1", position: 1, total: 3, queued: true });
    expect(useTabResourceBadgeStore.getState().getResourceBadge("tab-1")?.queuePosition).toBe(1);
    expect(useTabResourceBadgeStore.getState().getResourceBadge("tab-1")?.queueTotal).toBe(3);
    applyHeavyQueueChanged({ sessionId: "s1", position: 0, total: 0, queued: false });
    expect(useTabResourceBadgeStore.getState().hasResourceBadge("tab-1")).toBe(false);
  });

  it("queued 比采样器 cpu 优先级高，且采样器封账不撤销排队", () => {
    stubLocation("s1", "tab-1");
    applyHeavySessionUsage({ sessionId: "s1", cpuPercent: 420, memoryBytes: 1, active: true });
    applyHeavyQueueChanged({ sessionId: "s1", position: 1, total: 1, queued: true });
    expect(useTabResourceBadgeStore.getState().getResourceBadge("tab-1")?.reason).toBe("queued");
    applyHeavySessionUsage({ sessionId: "s1", cpuPercent: 0, memoryBytes: 0, active: false });
    expect(useTabResourceBadgeStore.getState().getResourceBadge("tab-1")?.reason).toBe("queued");
  });

  it("queued 不被 TTL sweep 清掉（门禁只在变化时发事件）", () => {
    stubLocation("s1", "tab-1");
    applyHeavyQueueChanged({ sessionId: "s1", position: 1, total: 1, queued: true });
    useTabResourceBadgeStore.getState().markResource("tab-2", { reason: "cpu", at: 0 });
    const swept = useTabResourceBadgeStore.getState().sweepStale(Date.now() + 10 * 60_000, 30_000);
    expect(swept).toEqual(["tab-2"]);
    expect(useTabResourceBadgeStore.getState().hasResourceBadge("tab-1")).toBe(true);
  });

  it("会话不在本实例任何布局里：忽略", () => {
    stubLocation("s1", null);
    applyHeavyQueueChanged({ sessionId: "s1", position: 1, total: 1, queued: true });
    expect(useTabResourceBadgeStore.getState().entries).toEqual({});
  });
});
