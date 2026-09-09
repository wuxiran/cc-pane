import type { TerminalRecoverySnapshot } from "@/types";
import { reanchorSeq } from "./terminalOutputSeqTracker";
import { writeTerminalReplay } from "./terminalReplayChunks";
import { restoreReplayBufferMode } from "./terminalReplayBufferMode";
import { withTerminalReplayPresentation, type ReplayPresentationTerminal } from "./terminalReplayPresentation";
import { checkpointRecoveredTerminal } from "./terminalRecoveryCheckpoint";

type ReplayTerminal = ReplayPresentationTerminal;
type ReplayLogger = (event: string, payload?: Record<string, unknown>) => void;

interface ReplayAttachedSessionOptions {
  canWrite?: () => boolean;
  term: ReplayTerminal;
  sessionId: string;
  getRecoverySnapshot: (sessionId: string) => Promise<TerminalRecoverySnapshot | null>;
  /** delta 管道：PTY 原始字节，调用方必须在此包 renderTerminalData。 */
  writeData: (data: string) => Promise<void>;
  /** photo 管道：SerializeAddon 成品 VT，直写 xterm——二次渲染会坏（裁决 B）。 */
  writeCheckpointData: (data: string) => Promise<void>;
  syncTrackedBufferType: (reason: string) => void;
  debugLog: ReplayLogger;
}

/** epoch≠0 时用恢复响应重锚 seq 记账（旧 daemon 回落 epoch=0 无记账能力，不动）。 */
export function reanchorAfterRecovery(
  sessionId: string,
  snapshot: TerminalRecoverySnapshot,
): void {
  if (snapshot.checkpointEpoch === 0) return;
  reanchorSeq(sessionId, snapshot.endSeq, snapshot.checkpointEpoch);
}

export function replayAttachedSession(options: ReplayAttachedSessionOptions): Promise<TerminalRecoverySnapshot | null> {
  return withTerminalReplayPresentation(options.term, () => restoreAttachedSnapshot(options));
}

async function restoreAttachedSnapshot({
  canWrite,
  term,
  sessionId,
  getRecoverySnapshot,
  writeData,
  writeCheckpointData,
  syncTrackedBufferType,
  debugLog,
}: ReplayAttachedSessionOptions): Promise<TerminalRecoverySnapshot | null> {
  const snapshot = await getRecoverySnapshot(sessionId);
  if (canWrite && !canWrite()) return null;

  if (!snapshot) {
    debugLog("session.attach-existing.replay.skip", {
      attachSessionId: sessionId,
      reason: "missing-snapshot",
    });
    return null;
  }

  if (!snapshot.checkpoint && !snapshot.delta && term.buffer.active.type === snapshot.bufferMode) {
    debugLog("session.attach-existing.replay.skip", {
      attachSessionId: sessionId,
      reason: "empty-snapshot",
      bufferMode: snapshot.bufferMode,
    });
    // 空会话也要重锚：endSeq/epoch 有效，attach 后上传链路即可转活。
    reanchorAfterRecovery(sessionId, snapshot);
    return snapshot;
  }

  debugLog("session.attach-existing.replay.begin", {
    attachSessionId: sessionId,
    bufferMode: snapshot.bufferMode,
    checkpointChars: snapshot.checkpoint?.snapshotAnsi.length ?? 0,
    deltaLength: snapshot.delta.length,
  });

  // 双管道（裁决 B）：photo 直写、delta 过 renderTerminalData。
  if (snapshot.checkpoint) {
    await writeTerminalReplay(snapshot.checkpoint.snapshotAnsi, writeCheckpointData, { canWrite });
  } else {
    await restoreReplayBufferMode(snapshot, term, writeData, canWrite);
  }
  if (snapshot.delta) {
    await writeTerminalReplay(snapshot.delta, writeData, { canWrite });
  }
  syncTrackedBufferType("session.attach-existing.replay");
  reanchorAfterRecovery(sessionId, snapshot);
  checkpointRecoveredTerminal(term, sessionId);

  debugLog("session.attach-existing.replay.end", {
    attachSessionId: sessionId,
    bufferMode: snapshot.bufferMode,
    deltaLength: snapshot.delta.length,
    bufferAfter: term.buffer.active.type,
  });

  return snapshot;
}
