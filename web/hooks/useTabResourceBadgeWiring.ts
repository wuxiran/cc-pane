// 资源琥珀徽标的接线（docs/107 W4）。
//
// 来源：W3 采样器在 episode 期间持续发 `heavy-session-usage{sessionId,cpuPercent,memoryBytes,active}`；
// `active:false` = 封账 → 撤销采样器原因（cpu/memory）。来源断流（app 卡死 / 事件丢失）
// 由 TTL sweep 兜底，会话从状态表消失也清。
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
import type { HeavySessionUsagePayload } from "@/types/heavyCommand";

export const HEAVY_SESSION_USAGE_EVENT = "heavy-session-usage";
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

/** App 级挂载一次。 */
export function useTabResourceBadgeWiring(): void {
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    listenWebviewIfTauri<HeavySessionUsagePayload>(HEAVY_SESSION_USAGE_EVENT, (event) => {
      applyHeavySessionUsage(event.payload);
    })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch((error) => {
        console.warn("[resource-badge] failed to subscribe to heavy-session-usage:", error);
      });

    // 会话消失（关闭 / 退出）→ 它的标签不该再亮
    const knownSessions = new Set<string>();
    const unsubStatus = useTerminalStatusStore.subscribe((state) => {
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
      disposed = true;
      unlisten?.();
      unsubStatus();
      clearInterval(sweep);
    };
  }, []);
}
