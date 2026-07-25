// 布局标签摘要行的状态桶统计：不再展示项目名，只按会话状态分桶计数。
// 桶语义与 StatusIndicator 的状态色一致：blocked=error(红)、
// waitingInput=等用户(琥珀)、running=在干活(accent)。
import { collectTerminalSessionIds, collectTerminalTabs } from "@/lib/paneSessions";
import type { PaneNode, TerminalStatusInfo, TerminalStatusType } from "@/types";

export interface LayoutStatusSummary {
  running: number;
  waitingInput: number;
  blocked: number;
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
  const summary: LayoutStatusSummary = { running: 0, waitingInput: 0, blocked: 0 };

  for (const tab of collectTerminalTabs(rootPane)) {
    for (const sessionId of collectTerminalSessionIds(tab)) {
      const status = statusMap.get(sessionId)?.status;
      if (!status) continue;
      if (status === "error") summary.blocked += 1;
      else if (status === "waitingInput") summary.waitingInput += 1;
      else if (RUNNING_STATUSES.has(status)) summary.running += 1;
    }
  }

  return summary;
}
