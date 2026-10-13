// 标签上的「资源」琥珀徽标（docs/107 W4）。形同 useTabAttentionStore，但语义相反：
//
// - 注意红点说的是「有事发生过」，用户看到即清；
// - 琥珀点说的是「此刻正在吃资源」，**不随可见清除**——切过去看一眼并不会让 cargo build
//   停下来，只有条件消失（采样器封账 / 内存回落 / 排队结束）才清。
//
// 原因与来源：
//   cpu / memory   ← W3 采样器 `heavy-session-usage` 事件（episode 期间持续推送）
//   job-memory     ← W5 Job 内存通知限
//   queued         ← W8 重负载门禁排队
import { create } from "zustand";

export type ResourceBadgeReason = "cpu" | "memory" | "job-memory" | "queued";

export interface ResourceBadgeEntry {
  reason: ResourceBadgeReason;
  /** 最近一次刷新（毫秒）。来源停止推送后由 sweep 按 TTL 清理。 */
  at: number;
  /** 触发徽标的会话；点琥珀点时让资源管理器定位到它。 */
  sessionId?: string;
  cpuPercent?: number;
  memoryBytes?: number;
  /** reason === "queued" 时：1-based 位次 / 队列总长，标签 chip 显示"排队 n/m"。 */
  queuePosition?: number;
  queueTotal?: number;
}

interface TabResourceBadgeState {
  /** owner（通常是 tabId）→ 当前徽标 */
  entries: Record<string, ResourceBadgeEntry>;
  /** 条件仍成立：刷新或按优先级覆盖（job-memory > queued > memory > cpu）。 */
  markResource: (owner: string, entry: Omit<ResourceBadgeEntry, "at"> & { at?: number }) => void;
  /** 条件消失：某一原因撤销。只清同原因的条目；其他原因仍成立就保留。 */
  clearReason: (owner: string, reason: ResourceBadgeReason) => void;
  /** 无条件清（标签关闭等）。 */
  clearResource: (owner: string) => void;
  /** 清掉 `at` 早于 `now - ttlMs` 的条目（来源断流兜底）。返回清掉的 owner。
   *  `queued` 不参与：门禁只在位次变化时发事件，不是心跳流；它由 `queued:false` 或会话消失清。 */
  sweepStale: (now: number, ttlMs: number) => string[];
  hasResourceBadge: (owner: string) => boolean;
  getResourceBadge: (owner: string) => ResourceBadgeEntry | undefined;
}

const PRIORITY: Record<ResourceBadgeReason, number> = {
  "job-memory": 4,
  queued: 3,
  memory: 2,
  cpu: 1,
};

export const useTabResourceBadgeStore = create<TabResourceBadgeState>((set, get) => ({
  entries: {},

  markResource: (owner, entry) => {
    const at = entry.at ?? Date.now();
    const current = get().entries[owner];
    // 高优先级条目仍成立时，低优先级只刷新时间戳，不换原因。
    if (current && PRIORITY[current.reason] > PRIORITY[entry.reason]) {
      set((state) => ({
        entries: { ...state.entries, [owner]: { ...current, at } },
      }));
      return;
    }
    set((state) => ({
      entries: {
        ...state.entries,
        [owner]: {
          reason: entry.reason,
          at,
          sessionId: entry.sessionId ?? current?.sessionId,
          cpuPercent: entry.cpuPercent,
          memoryBytes: entry.memoryBytes,
          queuePosition: entry.queuePosition,
          queueTotal: entry.queueTotal,
        },
      },
    }));
  },

  clearReason: (owner, reason) => {
    const current = get().entries[owner];
    if (!current) return;
    // cpu 与 memory 同源（同一个采样器 episode），任一撤销都算 episode 结束。
    const sameSource =
      current.reason === reason ||
      (isSamplerReason(current.reason) && isSamplerReason(reason));
    if (!sameSource) return;
    set((state) => {
      const entries = { ...state.entries };
      delete entries[owner];
      return { entries };
    });
  },

  clearResource: (owner) => {
    if (!get().entries[owner]) return;
    set((state) => {
      const entries = { ...state.entries };
      delete entries[owner];
      return { entries };
    });
  },

  sweepStale: (now, ttlMs) => {
    const stale = Object.entries(get().entries)
      .filter(([, entry]) => entry.reason !== "queued" && now - entry.at > ttlMs)
      .map(([owner]) => owner);
    if (stale.length === 0) return [];
    set((state) => {
      const entries = { ...state.entries };
      for (const owner of stale) delete entries[owner];
      return { entries };
    });
    return stale;
  },

  hasResourceBadge: (owner) => Boolean(get().entries[owner]),
  getResourceBadge: (owner) => get().entries[owner],
}));

function isSamplerReason(reason: ResourceBadgeReason): boolean {
  return reason === "cpu" || reason === "memory";
}
