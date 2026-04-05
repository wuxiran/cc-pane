import type { TerminalReplaySnapshot } from "@/services/terminalService";

interface ReplayTerminal {
  write: (data: string, callback?: () => void) => void;
  buffer: {
    active: {
      type: "normal" | "alternate";
    };
  };
}
type ReplayLogger = (event: string, payload?: Record<string, unknown>) => void;

interface ReplayAttachedSessionOptions {
  term: ReplayTerminal;
  sessionId: string;
  getReplaySnapshot: (sessionId: string) => Promise<TerminalReplaySnapshot | null>;
  syncTrackedBufferType: (reason: string) => void;
  debugLog: ReplayLogger;
}

function writeTerminal(term: ReplayTerminal, data: string): Promise<void> {
  return new Promise((resolve) => {
    term.write(data, () => resolve());
  });
}

export async function replayAttachedSession({
  term,
  sessionId,
  getReplaySnapshot,
  syncTrackedBufferType,
  debugLog,
}: ReplayAttachedSessionOptions): Promise<TerminalReplaySnapshot | null> {
  const snapshot = await getReplaySnapshot(sessionId);

  if (!snapshot) {
    debugLog("session.attach-existing.replay.skip", {
      attachSessionId: sessionId,
      reason: "missing-snapshot",
    });
    return null;
  }

  if (!snapshot.data) {
    debugLog("session.attach-existing.replay.skip", {
      attachSessionId: sessionId,
      reason: "empty-snapshot",
      bufferMode: snapshot.bufferMode,
    });
    return snapshot;
  }

  debugLog("session.attach-existing.replay.begin", {
    attachSessionId: sessionId,
    bufferMode: snapshot.bufferMode,
    dataLength: snapshot.data.length,
  });

  await writeTerminal(term, snapshot.data);
  syncTrackedBufferType("session.attach-existing.replay");

  debugLog("session.attach-existing.replay.end", {
    attachSessionId: sessionId,
    bufferMode: snapshot.bufferMode,
    dataLength: snapshot.data.length,
    bufferAfter: term.buffer.active.type,
  });

  return snapshot;
}
