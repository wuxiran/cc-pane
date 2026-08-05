import { terminalService } from "@/services";
import { usePanesStore } from "@/stores";
import { writeTerminalRestoreLog as writeRestoreLog } from "@/stores/useTerminalRestoreLogStore";

/** Explicitly replace a live session when the connected daemon cannot claim it. */
export async function coldRestoreBlockedTerminal(
  tabId: string,
  terminalPaneId: string,
): Promise<void> {
  const panes = usePanesStore.getState();
  const previousSessionId = panes.beginTerminalColdRestore(tabId, terminalPaneId);
  if (!previousSessionId) {
    throw new Error("This terminal is no longer waiting for a cold restore");
  }

  writeRestoreLog(tabId, terminalPaneId, "cold-restore.kill.begin", {
    sessionId: previousSessionId,
  });
  try {
    await terminalService.killSession(previousSessionId);
  } catch (error) {
    panes.finishTerminalColdRestore(tabId, terminalPaneId, previousSessionId, false);
    writeRestoreLog(tabId, terminalPaneId, "cold-restore.kill.failed", {
      sessionId: previousSessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  panes.finishTerminalColdRestore(tabId, terminalPaneId, previousSessionId, true);
  writeRestoreLog(tabId, terminalPaneId, "cold-restore.kill.end", {
    sessionId: previousSessionId,
  });
  writeRestoreLog(tabId, terminalPaneId, "cold-restore.create.ready", {});
}
