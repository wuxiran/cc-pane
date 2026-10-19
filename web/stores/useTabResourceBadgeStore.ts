// 标签上的「资源」琥珀徽标（docs/107 W4）。形同 useTabAttentionStore，但语义相反：
//
// - 注意红点说的是「有事发生过」，用户看到即清；
// - 琥珀点说的是「此刻正在吃资源」，**不随可见清除**——切过去看一眼并不会让 cargo build
//   停下来，只有条件消失（采样器封账 / 内存回落 / 排队结束）才清。
//
// 原因与来源：
//   cpu / memory   ← W3 采样器 `heavy-session-usage` 事件（episode 期间持续推送）
//   job-memory     ← W5 Job 内存通知限
//   queued         ← W8 重负载门禁排队（ctl 每次再轮询门禁都重发位次；60 s 没来当掉队）
import { create } from "zustand";

/**
 * `queued` 的 TTL：门禁在 ctl 每次 acquire 长轮询（≤25 s 一次）时都重发一遍位次，
 * 60 s 没刷新说明 ctl 已经走了而 `queued:false` 那条丢了——chip 不能因此永远亮着。
 */
export const QUEUED_BADGE_TTL_MS = 60_000;

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

type BadgeSource = "sampler" | "queued" | "job-memory";
type OwnerSources = Partial<Record<BadgeSource, ResourceBadgeEntry>>;

interface TabResourceBadgeState {
  sources: Record<string, OwnerSources>;
  /** owner（通常是 tabId）→ 当前徽标 */
  entries: Record<string, ResourceBadgeEntry>;
  /** 条件仍成立：刷新或按优先级覆盖（job-memory > queued > memory > cpu）。 */
  markResource: (owner: string, entry: Omit<ResourceBadgeEntry, "at"> & { at?: number }) => void;
  /** 条件消失：某一原因撤销。只清同来源的条目，重新投影其余原因。 */
  clearReason: (owner: string, reason: ResourceBadgeReason) => void;
  /** 无条件清（标签关闭等）。 */
  clearResource: (owner: string) => void;
  /**
   * 清掉过期条目（来源断流兜底）。返回清掉的 owner。
   * - cpu / memory：采样器每 2 s 推一次，`at` 早于 `now - ttlMs` 即断流；
   * - queued：门禁每次长轮询重发位次，`at` 早于 `now - queuedTtlMs`（默认
   *   {@link QUEUED_BADGE_TTL_MS}）即 ctl 已走、`queued:false` 丢了；
   * - job-memory：由状态字段驱动，出现与消失都有明确事件，不按 TTL 清。
   */
  sweepStale: (now: number, ttlMs: number, queuedTtlMs?: number) => string[];
  hasResourceBadge: (owner: string) => boolean;
  getResourceBadge: (owner: string) => ResourceBadgeEntry | undefined;
}

const PRIORITY: Record<ResourceBadgeReason, number> = {
  "job-memory": 4,
  queued: 3,
  memory: 2,
  cpu: 1,
};

function sourceOf(reason: ResourceBadgeReason): BadgeSource {
  return isSamplerReason(reason) ? "sampler" : reason as "queued" | "job-memory";
}

function project(sources: Record<string, OwnerSources>): Record<string, ResourceBadgeEntry> {
  const entries: Record<string, ResourceBadgeEntry> = {};
  for (const [owner, candidates] of Object.entries(sources)) {
    for (const entry of Object.values(candidates)) {
      if (!entries[owner] || PRIORITY[entry.reason] > PRIORITY[entries[owner].reason]) entries[owner] = entry;
    }
  }
  return entries;
}

export const useTabResourceBadgeStore = create<TabResourceBadgeState>((set, get) => ({
  entries: {},
  sources: {},

  markResource: (owner, entry) => {
    set((state) => {
      const source = sourceOf(entry.reason);
      const previous = state.sources[owner]?.[source];
      const sources = { ...state.sources, [owner]: { ...state.sources[owner], [source]: {
        ...entry, at: entry.at ?? Date.now(), sessionId: entry.sessionId ?? previous?.sessionId,
      } } };
      return { sources, entries: project(sources) };
    });
  },

  clearReason: (owner, reason) => {
    const source = sourceOf(reason);
    if (!get().sources[owner]?.[source]) return;
    set((state) => {
      const remaining = { ...state.sources[owner] };
      delete remaining[source];
      const sources = { ...state.sources, [owner]: remaining };
      if (!Object.keys(remaining).length) delete sources[owner];
      return { sources, entries: project(sources) };
    });
  },

  clearResource: (owner) => {
    if (!get().sources[owner]) return;
    set((state) => {
      const sources = { ...state.sources };
      delete sources[owner];
      return { sources, entries: project(sources) };
    });
  },

  sweepStale: (now, ttlMs, queuedTtlMs = QUEUED_BADGE_TTL_MS) => {
    const sources = { ...get().sources };
    const changed: string[] = [];
    for (const [owner, original] of Object.entries(sources)) {
      const remaining = { ...original };
      for (const source of ["sampler", "queued"] as const) {
        const entry = remaining[source];
        const ttl = source === "queued" ? queuedTtlMs : ttlMs;
        if (entry && now - entry.at > ttl) delete remaining[source];
      }
      if (Object.keys(remaining).length === Object.keys(original).length) continue;
      changed.push(owner);
      if (Object.keys(remaining).length) sources[owner] = remaining;
      else delete sources[owner];
    }
    if (changed.length) set({ sources, entries: project(sources) });
    return changed;
  },
  hasResourceBadge: (owner) => Boolean(get().entries[owner]),
  getResourceBadge: (owner) => get().entries[owner],
}));

function isSamplerReason(reason: ResourceBadgeReason): boolean {
  return reason === "cpu" || reason === "memory";
}
