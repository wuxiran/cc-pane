import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { usePanesStore } from "@/stores/usePanesStore";
import { useSelfChatStore } from "@/stores/useSelfChatStore";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { terminalService } from "@/services/terminalService";
import { runnerService } from "@/services/runnerService";
import { taskBindingService } from "@/services/taskBindingService";
import { notificationService } from "@/services/notificationService";
import { isTauriRuntime } from "@/services/runtime";
import { waitForTauri } from "@/utils";
import { selectOrphanSessions } from "@/lib/orphanSessionReconcile";
import type { TaskBindingStatus } from "@/types";

/** 首轮延迟：等布局 rehydrate、会话收养/restore 完成后再对账 */
const FIRST_SWEEP_DELAY_MS = 5 * 60 * 1000;
/** 对账周期 */
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
/** 视为"仍被引用"的活跃 task binding 状态 */
const LIVE_BINDING_STATUSES: TaskBindingStatus[] = ["pending", "running", "waiting"];
const TASK_BINDING_PAGE_SIZE = 200;

function isReapingDisabled(): boolean {
  const settings = useSettingsStore.getState().settings;
  return settings === null || settings.terminal.daemonOrphanReaperDisabled;
}

/**
 * 多桌面实例守卫：本 hook 的"被引用会话全集"只来自本实例内存，
 * 多个桌面实例共享 daemon 时其他实例的 tab 不可见，据此杀会话会误杀
 * 别的窗口刚打开的面板（残留旧实例事故的根因）。
 * daemon 且计数 ≠1（含旧 daemon 无计数、查询失败）一律 fail-closed 跳过。
 */
async function isSweepUnsafeForMultiClient(): Promise<boolean> {
  try {
    const info = await terminalService.getDaemonClientInfo();
    if (info.mode === "in-process") return false; // 会话为本实例独占
    if (info.desktopClientCount === 1) return false;
    console.info(
      "[orphan-reconcile] sweep skipped: daemon shared by",
      info.desktopClientCount ?? "unknown",
      "desktop clients",
    );
    return true;
  } catch (error) {
    console.warn("[orphan-reconcile] client info query failed; skipping sweep", error);
    return true;
  }
}

async function collectBindingSessionIds(status: TaskBindingStatus): Promise<Set<string>> {
  const sessionIds = new Set<string>();
  const bindingIds = new Set<string>();
  let expectedTotal: number | undefined;
  let offset = 0;

  while (true) {
    const result = await taskBindingService.query({
      status,
      limit: TASK_BINDING_PAGE_SIZE,
      offset,
    });
    if (expectedTotal === undefined) {
      expectedTotal = result.total;
    } else if (result.total !== expectedTotal) {
      throw new Error(`task bindings changed during ${status} pagination`);
    }

    for (const binding of result.items) {
      if (bindingIds.has(binding.id)) {
        throw new Error(`duplicate task binding during ${status} pagination: ${binding.id}`);
      }
      bindingIds.add(binding.id);
      if (binding.sessionId) sessionIds.add(binding.sessionId);
    }

    if (!result.hasMore) {
      if (bindingIds.size !== expectedTotal) {
        throw new Error(
          `incomplete task binding pagination for ${status}: expected ${expectedTotal}, got ${bindingIds.size}`,
        );
      }
      return sessionIds;
    }
    if (result.items.length === 0) {
      throw new Error(`empty task binding page for ${status} at offset ${offset}`);
    }
    offset += TASK_BINDING_PAGE_SIZE;
  }
}

/**
 * 收集当前仍被引用的 sessionId 全集：
 * 全布局 tab（含星标/非当前布局）+ Self-Chat + Runner 实例 + 活跃编排任务。
 * 任一来源查询失败即抛错，调用方跳过本轮（fail-closed，宁可不杀）。
 */
async function collectReferencedIds(): Promise<Set<string>> {
  const referenced = usePanesStore.getState().collectReferencedSessionIds();

  const selfChatPty = useSelfChatStore.getState().activeSession?.ptySessionId;
  if (selfChatPty) referenced.add(selfChatPty);

  const runners = await runnerService.listActiveInstances();
  for (const runner of runners) {
    if (runner.sessionId) referenced.add(runner.sessionId);
  }

  const bindingSessionIds = await Promise.all(
    LIVE_BINDING_STATUSES.map((status) => collectBindingSessionIds(status)),
  );
  for (const sessionIds of bindingSessionIds) {
    for (const sessionId of sessionIds) referenced.add(sessionId);
  }

  return referenced;
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
        if (await isSweepUnsafeForMultiClient()) return;
        const referenced = await collectReferencedIds();
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
          if (await isSweepUnsafeForMultiClient()) break;
          // TOCTOU 复查：对账快照与 kill 之间该会话可能刚被 tab/binding 认领
          const latest = await collectReferencedIds();
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
