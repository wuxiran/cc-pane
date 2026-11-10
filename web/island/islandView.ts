// 灵动岛的纯视图推导：分组、收起态优先级、计时格式、审批快捷键。
import { DONE_TTL_MS } from "@/lib/island/islandSessionTracker";
import type { IslandApprovalOption, IslandSession } from "@/types/island";

export interface IslandGroups {
  needs: IslandSession[];
  running: IslandSession[];
  done: IslandSession[];
}

export type CollapsedView =
  | { kind: "idle" }
  | { kind: "running"; count: number; longestSince: number }
  | { kind: "needs"; session: IslandSession; count: number; running: number }
  | { kind: "done"; session: IslandSession };

/** 需要你：等得最久的在前；运行中：跑得最久的在前；刚完成：最新的在前。过期的完成不显示。 */
export function groupSessions(sessions: readonly IslandSession[], now: number): IslandGroups {
  const by = (state: IslandSession["state"]) => sessions.filter((session) => session.state === state);
  return {
    needs: by("needs").sort((a, b) => a.since - b.since),
    running: by("running").sort((a, b) => a.since - b.since),
    done: by("done")
      .filter((session) => now - session.since <= DONE_TTL_MS)
      .sort((a, b) => b.since - a.since),
  };
}

/**
 * 收起态优先级：需要你 > 刚完成（弹出中）> 运行中 > 空闲。
 * 「刚完成」只在弹出窗口期（`pop` 非空）占位，过了 4 秒退回运行中 / 空闲。
 */
export function deriveCollapsedView(groups: IslandGroups, pop: IslandSession | null): CollapsedView {
  const [firstNeed] = groups.needs;
  if (firstNeed) {
    return { kind: "needs", session: firstNeed, count: groups.needs.length, running: groups.running.length };
  }
  if (pop) return { kind: "done", session: pop };
  const [longest] = groups.running;
  if (longest) return { kind: "running", count: groups.running.length, longestSince: longest.since };
  return { kind: "idle" };
}

/** 12:48 / 1:02:03。 */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

export function minutesAgo(since: number, now: number): number {
  return Math.max(0, Math.floor((now - since) / 60_000));
}

/** 数字键 1–9 → 选项下标；超出选项数或非数字键返回 null。 */
export function optionIndexForKey(key: string, optionCount: number): number | null {
  if (!/^[1-9]$/.test(key)) return null;
  const index = Number(key) - 1;
  return index < optionCount ? index : null;
}

export type ApprovalTone = "primary" | "danger" | "neutral";

/** 首个 allow 选项用主按钮，reject 用警示色，其余中性——只改样式，不改顺序和文案。 */
export function approvalTones(options: readonly IslandApprovalOption[]): ApprovalTone[] {
  const primary = options.findIndex((option) => option.kind.startsWith("allow"));
  return options.map((option, index) => {
    if (index === primary) return "primary";
    if (option.kind.startsWith("reject")) return "danger";
    return "neutral";
  });
}

/** 行内「批准」快捷按钮对应的选项：首个 allow_once，没有就首个 allow。纯提问卡没有。 */
export function quickApproveOption(options: readonly IslandApprovalOption[]): IslandApprovalOption | null {
  return options.find((option) => option.kind === "allow_once")
    ?? options.find((option) => option.kind.startsWith("allow"))
    ?? null;
}
