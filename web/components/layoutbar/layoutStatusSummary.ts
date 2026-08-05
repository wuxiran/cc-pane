// 布局标签 2×2 状态块的分桶统计：按会话状态计数。
// 桶语义与 StatusIndicator 的状态色一致：blocked=error(红)、waitingInput=等授权(琥珀)、
// running=在干活(accent)、idle=真空闲(灰)；total=会话总数（区分"无会话"与"全零"）。
import { collectTerminalSessionIdsWithSaved, collectTerminalTabs } from "@/lib/paneSessions";
import type { PaneNode, TerminalStatusInfo, TerminalStatusType } from "@/types";

export interface LayoutStatusSummary {
  running: number;
  waitingInput: number;
  blocked: number;
  idle: number;
  total: number;
}

const RUNNING_STATUSES: ReadonlySet<TerminalStatusType> = new Set([
  "thinking",
  "toolRunning",
  "compacting",
  "active",
]);

export function deriveLayoutStatusSummary(
  rootPane: PaneNode,
  statusMap: Map<string, TerminalStatusInfo>,
): LayoutStatusSummary {
  const summary: LayoutStatusSummary = {
    running: 0,
    waitingInput: 0,
    blocked: 0,
    idle: 0,
    total: 0,
  };

  for (const tab of collectTerminalTabs(rootPane)) {
    // 全量口径：restoring 中尚未 attach 的 savedSessionId 也是真实 PTY，计入 total
    for (const sessionId of collectTerminalSessionIdsWithSaved(tab)) {
      summary.total += 1;
      const status = statusMap.get(sessionId)?.status;
      if (!status) continue;
      if (status === "error") summary.blocked += 1;
      else if (status === "waitingInput") summary.waitingInput += 1;
      else if (status === "idle") summary.idle += 1;
      else if (RUNNING_STATUSES.has(status)) summary.running += 1;
    }
  }

  return summary;
}
