// 资源琥珀徽标的接线（docs/107 W4）。
//
// 来源：W3 采样器在 episode 期间持续发 `heavy-session-usage{sessionId,cpuPercent,memoryBytes,active}`；
// `active:false` = 封账 → 撤销采样器原因（cpu/memory）。来源断流（app 卡死 / 事件丢失）
// 由 TTL sweep 兜底，会话从状态表消失也清。
//
// job-memory（W5）不走事件：它是 `TerminalStatusInfo.jobMemoryWarning` 的投影——字段出现即标记、
// 消失（后端判树内存回落并清除）即撤销。订阅状态表而不是再开一条事件通道。
//
// 与注意红点不同：**可见不清**。切过去看一眼并不会让 cargo build 停下来。
import { useEffect } from "react";
import { listenWebviewIfTauri } from "@/services/runtime";
import { usePanesStore } from "@/stores";
import {
  useTabResourceBadgeStore,
  type ResourceBadgeReason,
} from "@/stores/useTabResourceBadgeStore";
import { useTerminalStatusStore } from "@/stores/useTerminalStatusStore";
import type { HeavyQueueChangedPayload, HeavySessionUsagePayload } from "@/types/heavyCommand";
import type { TerminalStatusInfo } from "@/types";

export const HEAVY_SESSION_USAGE_EVENT = "heavy-session-usage";
/** W8 门禁：排队位次变化（只在变化时发，不是心跳）。 */
export const HEAVY_QUEUE_CHANGED_EVENT = "heavy-queue-changed";
/** 采样器 episode 内每 2 s 推一次；30 s 没来就当断流。 */
export const RESOURCE_BADGE_TTL_MS = 30_000;
const SWEEP_INTERVAL_MS = 10_000;
/** 与后端 EPISODE_CPU_PERCENT 一致：树 CPU 到一个核算 cpu 原因，否则是内存触发的 episode。 */
const CPU_REASON_THRESHOLD = 100;

/** 读数 → 徽标原因。 */
export function resourceBadgeReasonOf(payload: HeavySessionUsagePayload): ResourceBadgeReason {
  return payload.cpuPercent >= CPU_REASON_THRESHOLD ? "cpu" : "memory";
}

/** 把一条采样器事件落到 store；owner 解析失败（会话不在本实例任何布局里）忽略。 */
export function applyHeavySessionUsage(payload: HeavySessionUsagePayload): void {
  const location = usePanesStore.getState().findTabBySessionAcrossLayouts(payload.sessionId);
  if (!location) return;
  const owner = location.tab.id;
  const badges = useTabResourceBadgeStore.getState();
  if (!payload.active) {
    badges.clearReason(owner, "cpu");
    return;
  }
  badges.markResource(owner, {
    reason: resourceBadgeReasonOf(payload),
    sessionId: payload.sessionId,
    cpuPercent: payload.cpuPercent,
    memoryBytes: payload.memoryBytes,
  });
}

/**
 * 把状态表里的 Job 内存越线投影成 job-memory 徽标。`previous` 是上一轮带告警的会话集合，
 * 用来发现"消失"；返回本轮集合供下次调用。owner 解析失败的会话不记入集合（下次仍会重试）。
 */
export function syncJobMemoryBadges(
  statusMap: Map<string, TerminalStatusInfo>,
  previous: Set<string>,
): Set<string> {
  const current = new Set<string>();
  const panes = usePanesStore.getState();
  const badges = useTabResourceBadgeStore.getState();
  for (const [sessionId, status] of statusMap) {
    const warning = status.jobMemoryWarning;
    if (!warning) continue;
    const location = panes.findTabBySessionAcrossLayouts(sessionId);
    if (!location) continue;
    current.add(sessionId);
    badges.markResource(location.tab.id, {
      reason: "job-memory",
      sessionId,
      memoryBytes: warning.bytes,
    });
  }
  for (const sessionId of previous) {
    if (current.has(sessionId)) continue;
    const location = panes.findTabBySessionAcrossLayouts(sessionId);
    if (location) badges.clearReason(location.tab.id, "job-memory");
  }
  return current;
}

/** 门禁排队事件 → `queued` 徽标（带位次）；`queued:false` 撤销。owner 解析失败忽略。 */
export function applyHeavyQueueChanged(payload: HeavyQueueChangedPayload): void {
  const location = usePanesStore.getState().findTabBySessionAcrossLayouts(payload.sessionId);
  if (!location) return;
  const owner = location.tab.id;
  const badges = useTabResourceBadgeStore.getState();
  if (!payload.queued) {
    badges.clearReason(owner, "queued");
    return;
  }
  badges.markResource(owner, {
    reason: "queued",
    sessionId: payload.sessionId,
    queuePosition: payload.position,
    queueTotal: payload.total,
  });
}

function subscribe<T>(event: string, handler: (payload: T) => void): () => void {
  let disposed = false;
  let unlisten: (() => void) | null = null;
  listenWebviewIfTauri<T>(event, (e) => handler(e.payload))
    .then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    })
    .catch((error) => {
      console.warn(`[resource-badge] failed to subscribe to ${event}:`, error);
    });
  return () => {
    disposed = true;
    unlisten?.();
  };
}

/** App 级挂载一次。 */
export function useTabResourceBadgeWiring(): void {
  useEffect(() => {
    const unlistenUsage = subscribe<HeavySessionUsagePayload>(
      HEAVY_SESSION_USAGE_EVENT,
      applyHeavySessionUsage,
    );
    const unlistenQueue = subscribe<HeavyQueueChangedPayload>(
      HEAVY_QUEUE_CHANGED_EVENT,
      applyHeavyQueueChanged,
    );

    // 会话消失（关闭 / 退出）→ 它的标签不该再亮；Job 内存越线随状态字段出现/消失
    const knownSessions = new Set<string>();
    let warnedSessions = new Set<string>();
    const unsubStatus = useTerminalStatusStore.subscribe((state) => {
      warnedSessions = syncJobMemoryBadges(state.statusMap, warnedSessions);
      for (const sessionId of state.statusMap.keys()) knownSessions.add(sessionId);
      for (const sessionId of [...knownSessions]) {
        if (state.statusMap.has(sessionId)) continue;
        knownSessions.delete(sessionId);
        const location = usePanesStore.getState().findTabBySessionAcrossLayouts(sessionId);
        if (location) useTabResourceBadgeStore.getState().clearResource(location.tab.id);
      }
    });

    const sweep = setInterval(() => {
      useTabResourceBadgeStore.getState().sweepStale(Date.now(), RESOURCE_BADGE_TTL_MS);
    }, SWEEP_INTERVAL_MS);

    return () => {
      unlistenUsage();
      unlistenQueue();
      unsubStatus();
      clearInterval(sweep);
    };
  }, []);
}
