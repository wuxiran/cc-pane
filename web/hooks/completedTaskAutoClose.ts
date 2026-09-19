import type { Tab, TaskBinding, TerminalSessionOutput } from "@/types";
import { getMetadataUi } from "@/components/sidebar/OrchestratorTaskUtils";
import { collectTerminalSessionIdsWithSaved } from "@/lib/paneSessions";

export const COMPLETED_TASK_GRACE_MS = 30_000;

export function completedTaskTabId(
  binding: TaskBinding, tabs: Tab[], enabled: boolean, now: number,
): string | null {
  const ui = getMetadataUi(binding);
  if (!enabled || binding.status !== "completed" || !binding.sessionId
    || !binding.completionSummary?.trim() || ui.autoCloseCompletedSessionId !== binding.sessionId
    || !ui.autoCloseCompletedTabId) return null;
  const age = now - Date.parse(binding.updatedAt);
  if (!Number.isFinite(age) || age < COMPLETED_TASK_GRACE_MS) return null;
  // Destroy detaches session-wide subscribers; keep a separate tab viewing the
  // same PTY intact, even though that PTY has exited.
  if (tabs.some((tab) => tab.id !== ui.autoCloseCompletedTabId
    && collectTerminalSessionIdsWithSaved(tab).some((id) => id === binding.sessionId))) return null;
  // removeTabsInternal applies to all layout copies of a tab id. Every copy must
  // belong solely to this exact task/session; do not touch unrelated split leaves.
  const copies = tabs.filter((tab) => tab.id === ui.autoCloseCompletedTabId);
  if (!copies.length || copies.some((tab) => {
    const sessions = collectTerminalSessionIdsWithSaved(tab);
    return tab.contentType !== "terminal" || tab.pinned || tab.dirty
      || tab.terminalRootPane?.type === "split"
      || sessions.length !== 1 || sessions[0] !== binding.sessionId;
  })) return null;
  return ui.autoCloseCompletedTabId;
}

export function hasRetainedExitedOutput(output: TerminalSessionOutput, sessionId: string): boolean {
  return output.sessionId === sessionId && output.exited === true && output.retained === true;
}
