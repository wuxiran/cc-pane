// 快照覆盖的会话差集（docs/78 批1 · B1-11）。
//
// 跨端同步每 5s 跑一轮 apply → reconcileTerminalSessions →
// runBackgroundLayoutRestore：整树替换后旧树会话会失去引用，但它们常常马上
// 被收养回来（新树经 savedSessionId 引用同一个会话）。所以差集只用于**观察**，
// 真杀要等批2 后开闸并在收养 settle 之后按当前活会话复核（Codex 评审必修1）。
import { collectTerminalSessionIdsWithSavedFromTree } from "@/lib/paneSessions";
import type { PanesState } from "./panesStoreTypes";

/**
 * 全部布局（含星标）的会话引用全集，**含 savedSessionId**。
 *
 * 供快照覆盖算差集用：口径必须与销毁侧一致，漏掉 savedSessionId 会把
 * 「恢复中、尚未 attach」的活会话算成待杀，开闸后就是误杀。
 */
export function collectSnapshotSessionIds(state: PanesState): string[] {
  const ids: string[] = [];
  for (const layout of state.layouts) {
    const tree = layout.id === state.currentLayoutId ? state.rootPane : layout.rootPane;
    if (!tree) continue;
    ids.push(...collectTerminalSessionIdsWithSavedFromTree(tree));
  }
  return ids;
}

/** 旧引用 − 新引用。两侧口径必须都含 savedSessionId，否则会把恢复中的活会话算成待杀。 */
export function diffSnapshotSessionIds(
  before: ReadonlySet<string>,
  after: ReadonlySet<string>,
): string[] {
  return [...before].filter((id) => !after.has(id));
}

/**
 * 观察期日志：真杀开闸前，这里每出现一条都应能在孤儿对账 GC 里找到对应发现。
 * 对不上说明差集算多了——开闸即误杀活会话。
 */
export function reportSnapshotWouldKill(
  before: ReadonlySet<string>,
  after: ReadonlySet<string>,
): void {
  const wouldKill = diffSnapshotSessionIds(before, after);
  if (wouldKill.length === 0) return;
  console.info("[destroy] snapshot-apply would-kill", {
    sessionIds: wouldKill,
    beforeCount: before.size,
    afterCount: after.size,
  });
}

// ============================================================================
// 杀决策后置（Codex plan 评审必修1 的完整落地；补账2）。
//
// apply 时算差集是不够的：跨端同步是 apply → reconcileTerminalSessions →
// runBackgroundLayoutRestore 三段，新树经 savedSessionId 引用的会话会在后两段
// 被**收养回来**。杀点必须等 settle，且杀前按当时的活会话/归属复核一遍。
// 本模块仍只打日志（开闸等观察期零误报），但日志口径已是「复核后的最终杀集」
// ——观察数据从此可信。
// ============================================================================

interface PendingSnapshotKill {
  candidates: Set<string>;
  startedAt: number;
}

let pendingKill: PendingSnapshotKill | null = null;

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
): void {
  const candidates = diffSnapshotSessionIds(before, after);
  if (candidates.length === 0) return;
  if (pendingKill) {
    console.info("[destroy] snapshot-apply kill-decision skipped (previous round in flight)", {
      skippedCandidates: candidates.length,
    });
    return;
  }
  pendingKill = { candidates: new Set(candidates), startedAt: Date.now() };
}

/**
 * settle 阶段（reconcile + backgroundRestore 完成后）：复核并给出最终杀集。
 *
 * 保护集 = 当前树全部引用 ∪ 后端仍活的会话。候选 ∩ 保护 = 被收养回来的，
 * 从杀集扣除。返回最终集合供调用方记录；本函数只打日志不杀。
 */
export function finalizeSnapshotWouldKill(
  currentTreeRefs: ReadonlySet<string>,
  liveBackendSessions: ReadonlySet<string>,
): string[] {
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
