import { terminalRestoreLaunchQueue } from "@/components/panes/terminalRestoreQueue";
import { collectTerminalLeaves } from "@/lib/paneSessions";
import { acquireTerminalSlot } from "@/lib/terminalSlot";
import { terminalService } from "@/services";
import { usePanesStore, useTerminalStatusStore } from "@/stores";
import { writeTerminalRestoreLog } from "@/stores/useTerminalRestoreLogStore";

function hasLiveSavedSession(savedSessionId?: string): boolean {
  if (!savedSessionId) return false;
  const status = useTerminalStatusStore.getState().statusMap.get(savedSessionId);
  return Boolean(status && status.status !== "exited");
}

function restoreQueueSnapshot(): { active: number; pending: number } {
  return terminalRestoreLaunchQueue.getSnapshot?.() ?? { active: 0, pending: 0 };
}

// 后台逐步恢复非当前布局里还没有活会话的终端。当前布局由已挂载的 TerminalView 负责。
export async function runBackgroundLayoutRestore(): Promise<void> {
  const store = usePanesStore.getState();
  const currentLayoutId = store.currentLayoutId;
  const targets = store.getRestorableTabs().flatMap(({ tab, layoutId }) => {
    if (layoutId === currentLayoutId || tab.contentType !== "terminal" || !tab.projectPath) {
      return [];
    }
    return collectTerminalLeaves(tab.terminalRootPane)
      .filter((leaf) => (
        !leaf.sessionId
        && !leaf.restoreBlockedReason
        && !hasLiveSavedSession(leaf.savedSessionId)
      ))
      .map((leaf) => ({
        tab,
        leaf,
        layoutId,
        expectedSavedSessionId: leaf.savedSessionId,
      }));
  });
  if (targets.length === 0) return;
  console.info(`[BackgroundRestore] scheduling ${targets.length} leaf/leaves across other layouts`);
  for (const { tab, leaf, layoutId, expectedSavedSessionId } of targets) {
    writeTerminalRestoreLog(tab.id, leaf.id, "background.queue.scheduled", {
      layoutId,
      expectedSavedSessionId: expectedSavedSessionId ?? null,
      ...restoreQueueSnapshot(),
    });
    // 槽位释放句柄提升到链外：create 抛错走 .catch 时也必须能释放，
    // 否则该 (tabId, paneId) 的槽永久泄漏、再也无法创建。
    let releaseSlotOuter: (() => void) | null = null;
    void terminalRestoreLaunchQueue
      .run(async () => {
        writeTerminalRestoreLog(tab.id, leaf.id, "background.queue.active", restoreQueueSnapshot());
        // 出队时重检：已被恢复或布局已切到前台时跳过，避免重复建会话。
        const live = usePanesStore.getState();
        const fresh = live.getRestorableTabs().find(
          (entry) => entry.tab.id === tab.id && entry.layoutId === layoutId,
        );
        const freshLeaf = fresh
          ? collectTerminalLeaves(fresh.tab.terminalRootPane).find((item) => item.id === leaf.id)
          : undefined;
        if (
          !fresh
          || !freshLeaf
          || freshLeaf.sessionId
          || freshLeaf.restoreBlockedReason
          || hasLiveSavedSession(freshLeaf.savedSessionId)
          || fresh.layoutId === live.currentLayoutId
          || !live.canCreateTerminalSession(tab.id, leaf.id, expectedSavedSessionId)
        ) {
          writeTerminalRestoreLog(tab.id, leaf.id, "background.create.cancelled-before-create");
          return null;
        }
        // 槽位（批4）：同进程并发的重复创建在 spawn 前就挡掉——否则竞态时
        // 会真的起一个 PTY 再回滚杀掉。跨进程竞态仍靠下面的复查+回滚。
        const releaseSlot = acquireTerminalSlot(tab.id, leaf.id);
        releaseSlotOuter = releaseSlot;
        if (!releaseSlot) {
          writeTerminalRestoreLog(tab.id, leaf.id, "background.create.cancelled-before-create", {
            reason: "slot-in-flight",
          });
          return null;
        }
        writeTerminalRestoreLog(tab.id, leaf.id, "background.backend-create.begin", {
          expectedSavedSessionId: expectedSavedSessionId ?? null,
        });
        const launchId = `launch-${crypto.randomUUID()}`;
        live.updateTerminalLaunchId(tab.id, leaf.id, launchId);
        const sessionId = await terminalService.createSession({
          launchId,
          projectPath: tab.projectPath,
          cols: 80,
          rows: 24,
          workspaceName: freshLeaf.workspaceName ?? tab.workspaceName,
          providerId: freshLeaf.providerId ?? tab.providerId,
          modelId: freshLeaf.modelId ?? tab.modelId,
          providerSelection: freshLeaf.providerSelection ?? tab.providerSelection,
          launchProfileId: freshLeaf.launchProfileId ?? tab.launchProfileId,
          workspacePath: freshLeaf.workspacePath ?? tab.workspacePath,
          workspaceSnapshotId: freshLeaf.workspaceSnapshotId ?? tab.workspaceSnapshotId,
          launchClaude: freshLeaf.launchClaude ?? tab.launchClaude,
          cliTool: freshLeaf.cliTool ?? tab.cliTool,
          resumeId: freshLeaf.resumeId ?? tab.resumeId,
          ssh: freshLeaf.ssh ?? tab.ssh,
          wsl: freshLeaf.wsl ?? tab.wsl,
          originLayoutId: layoutId,
          originTabId: tab.id,
          originTerminalPaneId: leaf.id,
          expectedSavedSessionId,
        });
        writeTerminalRestoreLog(tab.id, leaf.id, "background.backend-create.end", {
          sessionId,
          reusedExpected: sessionId === expectedSavedSessionId,
        });
        const afterCreate = usePanesStore.getState();
        if (!afterCreate.canCreateTerminalSession(
          tab.id,
          leaf.id,
          expectedSavedSessionId,
          sessionId === expectedSavedSessionId,
        )) {
          if (sessionId !== expectedSavedSessionId) {
            await terminalService.killSession(sessionId).catch(() => {});
          }
          writeTerminalRestoreLog(tab.id, leaf.id, "background.create.cancelled-after-create", {
            sessionId,
            killedDuplicate: sessionId !== expectedSavedSessionId,
          });
          releaseSlot();
          return null;
        }
        useTerminalStatusStore.getState().markSessionLive(sessionId);
        afterCreate.setBackgroundRestoreSession(tab.id, leaf.id, sessionId);
        writeTerminalRestoreLog(tab.id, leaf.id, "background.restore.ready", { sessionId });
        releaseSlot();
        return sessionId;
      })
      .catch((error) => {
        releaseSlotOuter?.();
        writeTerminalRestoreLog(tab.id, leaf.id, "background.restore.failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        console.warn(`[BackgroundRestore] failed for leaf ${tab.id}/${leaf.id}:`, error);
      });
  }
}
