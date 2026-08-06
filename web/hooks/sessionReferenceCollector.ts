// 「仍被引用的会话全集」与多实例安全判定——孤儿对账 GC 与 snapshot-apply
// 差集杀共用的保护集来源（docs/78）。
//
// 两条杀链的保护集必须同源：此前 GC 保 runner / task binding / SelfChat 而
// would-kill 只看树引用 ∪ 后端活会话，两份日志结构性对不上，「would-kill 报了
// GC 没报」无法区分误报与口径差，观察期永远攒不出可信样本。
import { usePanesStore } from "@/stores/usePanesStore";
import { useSelfChatStore } from "@/stores/useSelfChatStore";
import { terminalService } from "@/services/terminalService";
import { runnerService } from "@/services/runnerService";
import { taskBindingService } from "@/services/taskBindingService";
import type { TaskBindingStatus } from "@/types";

/** 视为"仍被引用"的活跃 task binding 状态 */
export const LIVE_BINDING_STATUSES: TaskBindingStatus[] = ["pending", "running", "waiting"];
const TASK_BINDING_PAGE_SIZE = 200;

/**
 * 多桌面实例守卫：引用全集只来自本实例内存，多个桌面实例共享 daemon 时
 * 其他实例的 tab 不可见，据此杀会话会误杀别的窗口刚打开的面板。
 * daemon 且计数 ≠1（含旧 daemon 无计数、查询失败）一律 fail-closed 跳过。
 */
export async function isSweepUnsafeForMultiClient(logPrefix: string): Promise<boolean> {
  try {
    const info = await terminalService.getDaemonClientInfo();
    if (info.mode === "in-process") return false; // 会话为本实例独占
    if (info.desktopClientCount === 1) return false;
    console.info(
      `${logPrefix} sweep skipped: daemon shared by`,
      info.desktopClientCount ?? "unknown",
      "desktop clients",
    );
    return true;
  } catch (error) {
    console.warn(`${logPrefix} client info query failed; skipping sweep`, error);
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
export async function collectReferencedSessionIdsAcrossSources(): Promise<Set<string>> {
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
