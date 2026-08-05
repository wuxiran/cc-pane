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
