// 快照覆盖的会话差集（docs/78）。
//
// 跨端同步每 5s 跑一轮 apply → reconcileTerminalSessions →
// runBackgroundLayoutRestore：整树替换后旧树会话会失去引用，但它们常常马上
// 被收养回来（新树经 savedSessionId 引用同一个会话）。所以杀决策必须后置到
// settle 之后复核，且真杀藏在默认关的开关后面——开闸前提是观察期零误报。
import { collectTerminalSessionIdsWithSavedFromTree } from "@/lib/paneSessions";
import { eachLayoutTreeWithStarred } from "@/lib/paneTree";
import { isTauriRuntime } from "@/services/runtime";
import type { PanesState } from "./panesStoreTypes";

/**
 * 全部布局（含星标）的会话引用全集，**含 savedSessionId**。
 *
 * 供快照覆盖算差集用：口径必须与销毁侧一致，漏掉 savedSessionId 会把
 * 「恢复中、尚未 attach」的活会话算成待杀，开闸后就是误杀。
 */
export function collectSnapshotSessionIds(state: PanesState): string[] {
  const ids: string[] = [];
  eachLayoutTreeWithStarred(state, (tree) => {
    ids.push(...collectTerminalSessionIdsWithSavedFromTree(tree));
  });
  return ids;
}

/** 旧引用 − 新引用。两侧口径必须都含 savedSessionId，否则会把恢复中的活会话算成待杀。 */
export function diffSnapshotSessionIds(
  before: ReadonlySet<string>,
  after: ReadonlySet<string>,
): string[] {
  return [...before].filter((id) => !after.has(id));
}

// ============================================================================
// 杀决策后置。
//
// apply 时算差集是不够的：跨端同步是 apply → reconcileTerminalSessions →
// runBackgroundLayoutRestore 三段，新树经 savedSessionId 引用的会话会在后两段
// 被**收养回来**。杀点必须等 settle，且杀前按当时的活会话/归属复核一遍。
// 真杀由 performSnapshotApplyKills 执行，受 settings 开关门控（默认关）；
// 关闭时本模块只打日志，口径为 settle 复核后的最终杀集，可直接与孤儿对账 GC
// 的发现互相印证。
//
// **桌面独占**：begin/finalize 都带 isTauriRuntime 门控——web/mobile 的布局是
// 残缺视图镜像，据此算差集必然把别端的活会话判成待杀（照抄孤儿 GC 先例）。
// ============================================================================

interface PendingSnapshotKill {
  candidates: Set<string>;
  startedAt: number;
}

let pendingKill: PendingSnapshotKill | null = null;

/**
 * 悬挂候选 TTL：正常一轮 settle 在秒级完成；候选存活超过这个时长说明当初的
 * apply 没有走到 finalize（不经 5s 轮询的 apply 入口），不是「上一轮还在跑」。
 * 悬挂候选必须丢弃，否则会把下一轮真候选顶掉（永远走 in-flight skip）。
 */
export const PENDING_KILL_TTL_MS = 60_000;

/** 测试用。 */
export function resetSnapshotKillState(): void {
  pendingKill = null;
}

/**
 * apply 阶段：登记候选杀集（旧引用 − 新引用），不杀。
 *
 * in-flight 锁：上一轮 apply→复核还没走完时，本轮**跳过杀决策**（树照常替换）。
 * 5s 轮询下两轮交叠意味着 reconcile 还在途，此时叠加候选集必然误判。
 */
export function beginSnapshotKillCandidates(
  before: ReadonlySet<string>,
  after: ReadonlySet<string>,
  now: number = Date.now(),
): void {
  if (!isTauriRuntime()) return;
  const candidates = diffSnapshotSessionIds(before, after);
  if (candidates.length === 0) return;
  if (pendingKill) {
    if (now - pendingKill.startedAt <= PENDING_KILL_TTL_MS) {
      console.info("[destroy] snapshot-apply kill-decision skipped (previous round in flight)", {
        skippedCandidates: candidates.length,
      });
      return;
    }
    // 超时悬挂 ≠ in-flight：丢弃死候选，让本轮正常登记
    console.info("[destroy] snapshot-apply dangling candidates discarded", {
      danglingCandidates: pendingKill.candidates.size,
      ageMs: now - pendingKill.startedAt,
    });
    pendingKill = null;
  }
  pendingKill = { candidates: new Set(candidates), startedAt: now };
}

/**
 * 放弃本轮杀决策（候选作废，不产生任何 would-kill/杀集判定）。
 *
 * 用于保护集来源不可达的场合：少了任何一路保护集，复核只会**放大**杀集
 * （方向与「宁可不杀」相反），所以不能带残缺保护集继续 finalize。
 */
export function abandonSnapshotKillCandidates(reason: string): void {
  if (!pendingKill) return;
  console.info("[destroy] snapshot-apply kill-decision abandoned", {
    reason,
    candidates: pendingKill.candidates.size,
  });
  pendingKill = null;
}

/**
 * settle 阶段（reconcile + backgroundRestore 完成后）：复核并给出最终杀集。
 *
 * 保护集 = 当前树全部引用 ∪ 后端仍活的会话 ∪ 共享引用集（SelfChat/runner/
 * task binding，与孤儿 GC 同源，调用方并入 currentTreeRefs）。
 * 候选 ∩ 保护 = 被收养回来的，从杀集扣除。本函数只打日志并返回最终集合；
 * 真杀由调用方经 performSnapshotApplyKills 决定。
 */
export function finalizeSnapshotWouldKill(
  currentTreeRefs: ReadonlySet<string>,
  liveBackendSessions: ReadonlySet<string>,
): string[] {
  if (!isTauriRuntime()) return [];
  const pending = pendingKill;
  pendingKill = null;
  if (!pending) return [];

  const finalKill = [...pending.candidates].filter(
    (id) => !currentTreeRefs.has(id) && !liveBackendSessions.has(id),
  );
  const adopted = pending.candidates.size - finalKill.length;
  if (finalKill.length > 0 || adopted > 0) {
    console.info("[destroy] snapshot-apply would-kill (post-settle, re-verified)", {
      sessionIds: finalKill,
      adoptedBack: adopted,
      settleMs: Date.now() - pending.startedAt,
    });
  }
  return finalKill;
}

/** 单轮真杀上限（照抄孤儿 GC 的 maxKillsPerSweep：差集异常大 = 判定可疑，宁可分轮）。 */
export const SNAPSHOT_APPLY_KILL_CAP = 10;

/**
 * 差集杀执行器。开关关闭（默认）时零副作用——finalize 的 would-kill 日志
 * 就是全部行为，与开闸前完全一致。开启时逐个 kill（reason 用回收类
 * orphan-reclaim：这些会话已无标签指向，session-killed 的「保留标签」分流
 * 无副作用），带每轮上限与逐杀日志。
 */
export async function performSnapshotApplyKills(
  finalKill: readonly string[],
  opts: {
    enabled: boolean;
    killSession: (sessionId: string, reason: "orphan-reclaim") => Promise<unknown>;
  },
): Promise<number> {
  if (!opts.enabled || finalKill.length === 0) return 0;
  const targets = finalKill.slice(0, SNAPSHOT_APPLY_KILL_CAP);
  if (targets.length < finalKill.length) {
    console.info("[destroy] snapshot-apply kill capped", {
      total: finalKill.length,
      cap: SNAPSHOT_APPLY_KILL_CAP,
    });
  }
  let killed = 0;
  for (const sessionId of targets) {
    try {
      await opts.killSession(sessionId, "orphan-reclaim");
      killed += 1;
      console.info("[destroy] snapshot-apply killed orphaned session", sessionId);
    } catch (error) {
      console.warn("[destroy] snapshot-apply kill failed", sessionId, error);
    }
  }
  return killed;
}
