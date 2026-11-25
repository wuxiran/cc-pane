// 任务视图（Explorer「任务」档）的分组派生：把跨布局的终端行按「轮到谁动」分三段。
// 纯函数，与渲染解耦（惯例同 workspaceTerminals.ts）。
//
//   等你处理：出错 / 等待输入 / 跑完了你还没看（注意标记 completed）
//   进行中：  忙碌态（thinking / toolRunning / compacting / legacy active）
//   已结束：  其余（看过的 idle、exited、尚无状态）
//
// 实时状态优先于注意标记：标记只在标签可见时才清，若会话已重新忙起来（比如权限被别处批了），
// 它该回到「进行中」而不是卡在「等你处理」。
import { isBusyStatus } from "@/types";
import type { AttentionEntry } from "@/stores/useTabAttentionStore";
import type { TerminalRowWithWorkspace } from "./workspaceTerminals";

export type TaskKind = "error" | "waiting" | "done" | "working" | "settled";

export interface TaskItem extends TerminalRowWithWorkspace {
  /** 任务分类（不与行自身的 kind = terminal/agent-chat 混淆） */
  taskKind: TaskKind;
  /** 进入当前分类的时刻（ms）；未知时为 null（UI 不显示时长） */
  since: number | null;
}

export interface TaskBoardGroups {
  needsYou: TaskItem[];
  working: TaskItem[];
  settled: TaskItem[];
}

export function classifyTask(
  row: TerminalRowWithWorkspace,
  attention: AttentionEntry | undefined,
): TaskKind {
  if (row.status === "error") return "error";
  if (row.status === "waitingInput") return "waiting";
  if (isBusyStatus(row.status)) return "working";
  if (attention?.reason === "error") return "error";
  if (attention?.reason === "waiting-input") return "waiting";
  if (attention?.reason === "completed") return "done";
  return "settled";
}

function sinceOf(
  kind: TaskKind,
  row: TerminalRowWithWorkspace,
  attention: AttentionEntry | undefined,
  since: Readonly<Record<string, number>>,
): number | null {
  // 「完成」的时刻就是打标时刻；之后 idle 的起点与之相同或更早，取标记更准
  if (kind === "done") return attention?.at ?? null;
  const statusSince = row.primarySessionId ? since[row.primarySessionId] : undefined;
  return statusSince ?? attention?.at ?? null;
}

/** 早的在前（等得最久 / 跑得最久的排最上）；无时间的沉底，同值保持原序（sort 稳定）。 */
function byOldest(a: TaskItem, b: TaskItem): number {
  if (a.since === b.since) return 0;
  if (a.since === null) return 1;
  if (b.since === null) return -1;
  return a.since - b.since;
}

export function groupTasks(
  rows: readonly TerminalRowWithWorkspace[],
  attention: Readonly<Record<string, AttentionEntry>>,
  since: Readonly<Record<string, number>>,
): TaskBoardGroups {
  const groups: TaskBoardGroups = { needsYou: [], working: [], settled: [] };
  for (const row of rows) {
    const entry = attention[row.tabId];
    const kind = classifyTask(row, entry);
    const item: TaskItem = { ...row, taskKind: kind, since: sinceOf(kind, row, entry, since) };
    if (kind === "working") groups.working.push(item);
    else if (kind === "settled") groups.settled.push(item);
    else groups.needsYou.push(item);
  }
  groups.needsYou.sort(byOldest);
  groups.working.sort(byOldest);
  // 已结束保持布局序：列表长、点击频率低，重排只会添乱
  return groups;
}
