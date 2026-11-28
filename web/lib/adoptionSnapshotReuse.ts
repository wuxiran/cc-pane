// 启动认领轮读到的守护进程快照，给各标签的「旧会话还活着吗」查询复用。
//
// 认领轮（reconcileTerminalSessions）已经拿到一份完整快照：哪些会话还活着。之后每个
// 恢复中的标签又各自查一遍同一个问题。这里把快照记下来直接回答，但快照是某个时刻的
// 照片，只有能证明「照片仍然有效」时才复用，否则回退原来的单独查询：
//
// - 世代：快照的 daemonGeneration 必须等于当前已知的 daemon 世代。daemon 重启后旧
//   快照里的会话全部失效。
// - 时效：快照超过 REUSE_WINDOW_MS 不再复用（期间可能有会话退出而事件丢失）。
// - 快照后的新证据只会让结果更保守：状态缓存里已标 exited 的会话，即使快照说活着
//   也判死（退出是终态，不会复活）；快照里不活的会话不会因为后来的事件变活
//   （savedSessionId 不可能在快照之后才诞生）。
import { terminalService } from "@/services/terminalService";
import { useTerminalStatusStore } from "@/stores/useTerminalStatusStore";
import type { TerminalAdoptionSnapshot } from "@/types";

export const ADOPTION_SNAPSHOT_REUSE_WINDOW_MS = 30_000;

interface RecordedSnapshot {
  daemonGeneration: number;
  capturedAtMs: number;
  liveIds: ReadonlySet<string>;
}

let recorded: RecordedSnapshot | null = null;

/** 认领轮拿到**完整**快照后调用；不完整/无世代的快照不记录（无法判断有效性）。 */
export function recordAdoptionSnapshot(snapshot: TerminalAdoptionSnapshot): void {
  if (!snapshot.complete || snapshot.daemonGeneration === undefined) {
    recorded = null;
    return;
  }
  recorded = {
    daemonGeneration: snapshot.daemonGeneration,
    capturedAtMs: snapshot.capturedAtMs,
    liveIds: new Set(
      snapshot.sessions.filter((s) => s.status !== "exited").map((s) => s.sessionId),
    ),
  };
}

export function clearAdoptionSnapshotForTest(): void {
  recorded = null;
}

/**
 * 用快照回答 savedSessionId 是否仍活着。返回 null = 快照不可复用，调用方必须回退单独查询。
 */
export function liveFromAdoptionSnapshot(
  savedSessionId: string,
  now: number = Date.now(),
): boolean | null {
  if (!recorded) return null;
  const age = now - recorded.capturedAtMs;
  if (age < 0 || age > ADOPTION_SNAPSHOT_REUSE_WINDOW_MS) return null;
  const currentGeneration = terminalService.getCachedDaemonClientInfo()?.daemonGeneration;
  if (currentGeneration === undefined || currentGeneration !== recorded.daemonGeneration) {
    return null;
  }
  if (!recorded.liveIds.has(savedSessionId)) return false;
  const cached = useTerminalStatusStore.getState().statusMap.get(savedSessionId);
  return cached?.status !== "exited";
}
