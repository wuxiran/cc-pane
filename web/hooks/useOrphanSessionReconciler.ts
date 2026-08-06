import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { terminalService } from "@/services/terminalService";
import { notificationService } from "@/services/notificationService";
import { isTauriRuntime } from "@/services/runtime";
import { waitForTauri } from "@/utils";
import { selectOrphanSessions } from "@/lib/orphanSessionReconcile";
import {
  collectReferencedSessionIdsAcrossSources,
  isSweepUnsafeForMultiClient,
} from "./sessionReferenceCollector";

/** 首轮延迟：等布局 rehydrate、会话收养/restore 完成后再对账 */
const FIRST_SWEEP_DELAY_MS = 5 * 60 * 1000;
/** 对账周期 */
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
const LOG_PREFIX = "[orphan-reconcile]";

function isReapingDisabled(): boolean {
  const settings = useSettingsStore.getState().settings;
  return settings === null || settings.terminal.daemonOrphanReaperDisabled;
}

/**
 * 孤儿终端会话对账回收。
 *
 * daemon 会话可能失去全部前端引用（布局删除、崩溃重启后未被收养等），
 * 空闲 TUI 每帧重绘持续消耗 CPU。本 hook 周期性把 daemon 全量会话与
 * 所有引用来源对账，无引用且非活跃状态的会话直接 kill 并聚合通知。
 *
 * 只在桌面端运行：web/mobile 镜像的布局是残缺视图，会误判孤儿。
 * daemon 侧另有 TTL 兜底（session_reaper，默认 24h）覆盖 app 不运行的时段。
 */
export function useOrphanSessionReconciler() {
  const { t } = useTranslation("settings");
  const sweeping = useRef(false);

  useEffect(() => {
    if (!isTauriRuntime()) return;

    let disposed = false;
    let intervalId: ReturnType<typeof setInterval> | undefined;

    const sweep = async () => {
      if (sweeping.current) return;
      if (isReapingDisabled()) return;
      sweeping.current = true;
      try {
        if (await isSweepUnsafeForMultiClient(LOG_PREFIX)) return;
        const referenced = await collectReferencedSessionIdsAcrossSources();
        const statuses = await terminalService.getAllStatus();
        const orphans = selectOrphanSessions(statuses, referenced, Date.now());

        // 验收仪表（docs/78）：销毁出口统一后，孤儿发现数应当趋零——
        // 每轮都打一行，**包括零发现**。只在有发现时打印的话，「一直是 0」
        // 与「对账压根没跑」在日志里完全同形，趋势就无从判断。
        // 快照覆盖的 would-kill 日志要与这里的发现对账：would-kill 报了、
        // 这里却没发现，说明差集算多了，真杀开闸即误杀活会话。
        console.info("[orphan-reconcile] sweep", {
          orphanCount: orphans.length,
          liveCount: statuses.length,
          referencedCount: referenced.size,
          orphanIds: orphans,
        });

        if (orphans.length === 0) return;

        let killed = 0;
        for (const sessionId of orphans) {
          if (disposed || isReapingDisabled()) break;
          // sweep 期间可能有第二个桌面实例刚启动，杀前复查
          if (await isSweepUnsafeForMultiClient(LOG_PREFIX)) break;
          // TOCTOU 复查：对账快照与 kill 之间该会话可能刚被 tab/binding 认领
          const latest = await collectReferencedSessionIdsAcrossSources();
          if (latest.has(sessionId)) continue;
          try {
            await terminalService.killSession(sessionId, "orphan-reclaim");
            killed += 1;
            console.info("[orphan-reconcile] reclaimed session", sessionId);
          } catch (error) {
            console.warn("[orphan-reconcile] failed to kill session", sessionId, error);
          }
        }

        if (killed > 0) {
          await notificationService
            .trigger({
              kind: "orphan-session-reclaimed",
              title: t("orphanSessionReclaimedTitle"),
              body: t("orphanSessionReclaimedBody", { count: killed }),
              dedupeKey: "orphan-session-reclaimed",
              source: "orphan-reconciler",
            })
            .catch(() => {});
        }
      } catch (error) {
        // fail-closed：任一引用来源查询失败都跳过本轮，绝不基于残缺集合杀会话
        console.warn("[orphan-reconcile] sweep skipped:", error);
      } finally {
        sweeping.current = false;
      }
    };

    const timerId = setTimeout(async () => {
      const ready = await waitForTauri();
      if (!ready || disposed) return;
      void sweep();
      intervalId = setInterval(() => void sweep(), SWEEP_INTERVAL_MS);
    }, FIRST_SWEEP_DELAY_MS);

    return () => {
      disposed = true;
      clearTimeout(timerId);
      if (intervalId !== undefined) clearInterval(intervalId);
    };
  }, [t]);
}
