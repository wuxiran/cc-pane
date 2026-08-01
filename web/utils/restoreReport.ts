import { info as logInfo } from "@tauri-apps/plugin-log";
import { collectTerminalLeaves } from "@/lib/paneSessions";
import { usePanesStore } from "@/stores/usePanesStore";

export type RestoreReportSummary = {
  total: number;
  withResumeId: number;
  withoutResumeId: number;
  adopted: number;
  resumed: number;
  fresh: number;
  shell: number;
  /** Leaves that were expected to resume but lost their conversation id. */
  missingResumeId: number;
};

/**
 * 只有本次明确走 resumed 恢复的 agent leaf 丢失 resume id 才算回归。
 * adopted 已热接管原 PTY，fresh 本来就是新对话，shell 没有 resume 语义，三者都不报警。
 */
export function isRestoreRegression(summary: RestoreReportSummary): boolean {
  return summary.missingResumeId > 0;
}

/**
 * 重启恢复报告：rehydrate 后按 terminal leaf 把恢复模式和绑定状态写入应用日志
 * （经 @tauri-apps/plugin-log 落到 cc-panes.log，grep `[restore-report]` 查看）。
 * 用于事后核对「哪些 tab 带着 resumeId 恢复、哪些只能开新对话」。
 *
 * 返回汇总供调用方判断是否要让用户看见——只写日志等于没人知道。
 */
export async function logRestoreReport(): Promise<RestoreReportSummary> {
  const tabs = usePanesStore.getState().getRestorableTabs();
  const entries = tabs.flatMap(({ tab, paneId, layoutId }) => {
    if (tab.contentType !== "terminal" || !tab.projectPath) return [];
    const leaves = collectTerminalLeaves(tab.terminalRootPane);
    // A tab-level resumeId is only a legacy compatibility fallback for a single-leaf snapshot.
    // In a split tab it belongs to the active leaf and must not make sibling leaves look bound.
    const legacyResumeId = leaves.length === 1 ? tab.resumeId : undefined;
    return leaves.map((leaf) => {
      const resumeId = leaf.resumeId ?? legacyResumeId;
      const cliTool = leaf.cliTool
        ?? tab.cliTool
        ?? (leaf.launchClaude || tab.launchClaude || resumeId ? "claude" : "none");
      const hasResumeId = Boolean(resumeId && resumeId !== "new");
      const mode = cliTool === "none"
        ? "shell"
        : leaf.restoreMode
          ?? (leaf.restoring || leaf.savedSessionId
            ? "resumed"
            : leaf.sessionId
              ? "adopted"
              : hasResumeId
                ? "resumed"
                : "fresh");
      return {
        tabId: tab.id,
        terminalPaneId: leaf.id,
        paneId,
        layoutId,
        cliTool,
        mode,
        runtime: (leaf.ssh ?? tab.ssh) ? "ssh" : (leaf.wsl ?? tab.wsl) ? "wsl" : "local",
        project: tab.projectPath.split(/[/\\]/).pop() ?? tab.projectPath,
        hasResumeId,
        resumeIdPrefix: hasResumeId ? resumeId!.slice(0, 8) : null,
        resumeIdSource: leaf.resumeIdSource ?? tab.resumeIdSource ?? null,
      };
    });
  });

  const byCliTool: Record<string, { bound: number; unbound: number }> = {};
  for (const entry of entries) {
    const bucket = (byCliTool[entry.cliTool] ??= { bound: 0, unbound: 0 });
    if (entry.hasResumeId) bucket.bound += 1;
    else bucket.unbound += 1;
  }

  const agentEntries = entries.filter((entry) => entry.mode !== "shell");
  const summary = {
    total: agentEntries.length,
    withResumeId: agentEntries.filter((entry) => entry.hasResumeId).length,
    withoutResumeId: agentEntries.filter((entry) => !entry.hasResumeId).length,
    adopted: entries.filter((entry) => entry.mode === "adopted").length,
    resumed: entries.filter((entry) => entry.mode === "resumed").length,
    fresh: entries.filter((entry) => entry.mode === "fresh").length,
    shell: entries.filter((entry) => entry.mode === "shell").length,
    missingResumeId: entries.filter(
      (entry) => entry.mode === "resumed" && !entry.hasResumeId,
    ).length,
    byCliTool,
    tabs: entries,
  };

  try {
    await logInfo(`[restore-report] ${JSON.stringify(summary)}`);
  } catch {
    // plugin-log 不可用（如纯浏览器环境）时静默跳过
  }

  return {
    total: summary.total,
    withResumeId: summary.withResumeId,
    withoutResumeId: summary.withoutResumeId,
    adopted: summary.adopted,
    resumed: summary.resumed,
    fresh: summary.fresh,
    shell: summary.shell,
    missingResumeId: summary.missingResumeId,
  };
}
