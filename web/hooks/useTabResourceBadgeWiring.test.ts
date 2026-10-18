// 资源琥珀徽标接线：事件 → store，封账撤销，owner 解析。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePanesStore } from "@/stores";
import { QUEUED_BADGE_TTL_MS, useTabResourceBadgeStore } from "@/stores/useTabResourceBadgeStore";
import type { TerminalStatusInfo } from "@/types";
import {
  applyHeavyQueueChanged,
  applyHeavySessionUsage,
  resourceBadgeReasonOf,
  syncJobMemoryBadges,
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

describe("syncJobMemoryBadges", () => {
  const status = (sessionId: string, warning?: TerminalStatusInfo["jobMemoryWarning"]): TerminalStatusInfo => ({
    sessionId,
    status: "active",
    lastOutputAt: 1,
    updatedAt: 1,
    jobMemoryWarning: warning,
  });

  it("状态里出现 jobMemoryWarning → job-memory 徽标；字段消失 → 撤销", () => {
    stubLocation("s1", "tab-1");
    const map = new Map<string, TerminalStatusInfo>();
    map.set("s1", status("s1", { bytes: 20e9, limitBytes: 16e9, at: 1 }));
    const warned = syncJobMemoryBadges(map, new Set());
    expect([...warned]).toEqual(["s1"]);
    const entry = useTabResourceBadgeStore.getState().getResourceBadge("tab-1");
    expect(entry?.reason).toBe("job-memory");
    expect(entry?.memoryBytes).toBe(20e9);
    expect(entry?.sessionId).toBe("s1");

    map.set("s1", status("s1"));
    const after = syncJobMemoryBadges(map, warned);
    expect(after.size).toBe(0);
    expect(useTabResourceBadgeStore.getState().hasResourceBadge("tab-1")).toBe(false);
  });

  it("job-memory 压过采样器原因；采样器封账不撤销它", () => {
    stubLocation("s1", "tab-1");
    applyHeavySessionUsage({ sessionId: "s1", cpuPercent: 420, memoryBytes: 1, active: true });
    const map = new Map<string, TerminalStatusInfo>();
    map.set("s1", status("s1", { bytes: 2, limitBytes: 1, at: 1 }));
    syncJobMemoryBadges(map, new Set());
    expect(useTabResourceBadgeStore.getState().getResourceBadge("tab-1")?.reason).toBe("job-memory");
    applyHeavySessionUsage({ sessionId: "s1", cpuPercent: 0, memoryBytes: 0, active: false });
    expect(useTabResourceBadgeStore.getState().getResourceBadge("tab-1")?.reason).toBe("job-memory");
  });

  it("会话不在任何布局里：不记入集合，不报错", () => {
    stubLocation("s1", null);
    const map = new Map<string, TerminalStatusInfo>();
    map.set("s1", status("s1", { bytes: 2, limitBytes: 1, at: 1 }));
    expect(syncJobMemoryBadges(map, new Set()).size).toBe(0);
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

  it("丢了 queued:false 的 chip 最多亮 60 s：门禁重发续命，断流即清", () => {
    stubLocation("s1", "tab-1");
    const t0 = 1_000_000;
    vi.spyOn(Date, "now").mockReturnValue(t0);
    applyHeavyQueueChanged({ sessionId: "s1", position: 2, total: 3, queued: true });
    // 门禁在 ctl 再轮询时重发同一位次 → 刷新时间戳
    vi.spyOn(Date, "now").mockReturnValue(t0 + 25_000);
    applyHeavyQueueChanged({ sessionId: "s1", position: 2, total: 3, queued: true });
    expect(useTabResourceBadgeStore.getState().getResourceBadge("tab-1")?.at).toBe(t0 + 25_000);
    // 50 s 后（距最近刷新 25 s）：还在
    expect(useTabResourceBadgeStore.getState().sweepStale(t0 + 50_000, 30_000)).toEqual([]);
    expect(useTabResourceBadgeStore.getState().hasResourceBadge("tab-1")).toBe(true);
    // 之后 ctl 退出、`queued:false` 丢了：最近刷新 + TTL 一过就清
    expect(
      useTabResourceBadgeStore.getState().sweepStale(t0 + 25_000 + QUEUED_BADGE_TTL_MS + 1, 30_000),
    ).toEqual(["tab-1"]);
    expect(useTabResourceBadgeStore.getState().hasResourceBadge("tab-1")).toBe(false);
  });

  it("会话不在本实例任何布局里：忽略", () => {
    stubLocation("s1", null);
    applyHeavyQueueChanged({ sessionId: "s1", position: 1, total: 1, queued: true });
    expect(useTabResourceBadgeStore.getState().entries).toEqual({});
  });
});
