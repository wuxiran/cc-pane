// 工作空间树「终端模式」的数据派生：跨全部普通布局收集运行中的终端 tab，
// 按 workspace 归组。纯函数，与渲染解耦（惯例同 worktreeGrouping.ts / layoutStatusSummary.ts）。
import type { PanesState } from "@/stores/panesStoreTypes";
import { eachLayoutTree } from "@/stores/paneLayoutHelpers";

/** eachLayoutTree/layoutTree 实际只读这三个字段；收窄签名便于调用方按需订阅 */
export type PanesLayoutSlice = Pick<PanesState, "layouts" | "rootPane" | "currentLayoutId">;
import { collectTerminalLeaves, collectTerminalSessionIds, collectTerminalTabs } from "@/lib/paneSessions";
import { resolveTerminalContextSelection } from "@/hooks/useFollowActiveTerminalContext";
import type { Tab, Workspace } from "@/types";
import type { TerminalStatusInfo, TerminalStatusType } from "@/types";

export interface WorkspaceTerminalRow {
  tabId: string;
  layoutId: string;
  title: string;
  /**
   * 用户对该会话的首条输入（来自 session_index.first_prompt，经 resumeId 关联）。
   * 有值时 UI 优先用它作行名，原 title 降级为次行/tooltip。
   */
  firstPrompt: string | null;
  /** 各 leaf 中最严重的状态（无状态记录时为 null） */
  status: TerminalStatusType | null;
  /** toolRunning 时的工具名（取自状态最严重的那个 leaf） */
  toolName: string | null;
  /** 该 tab 下的活 PTY 会话数（分屏 >1 时 UI 显示 ×N） */
  sessionCount: number;
}

/** 状态严重度：越靠前越需要用户注意。分屏 tab 聚合时取最严重。 */
const STATUS_SEVERITY: TerminalStatusType[] = [
  "error",
  "waitingInput",
  "compacting",
  "toolRunning",
  "thinking",
  "initializing",
  "active",
  "idle",
  "exited",
];

export function severityRank(status: TerminalStatusType | null): number {
  if (!status) return STATUS_SEVERITY.length;
  const index = STATUS_SEVERITY.indexOf(status);
  return index === -1 ? STATUS_SEVERITY.length : index;
}

function worstStatus(
  sessionIds: string[],
  statusMap: Map<string, TerminalStatusInfo>,
): { status: TerminalStatusType | null; toolName: string | null } {
  let best: TerminalStatusInfo | null = null;
  for (const sessionId of sessionIds) {
    const info = statusMap.get(sessionId);
    if (!info) continue;
    if (!best || severityRank(info.status) < severityRank(best.status)) {
      best = info;
    }
  }
  return {
    status: best?.status ?? null,
    toolName: best?.currentToolName ?? null,
  };
}

/** tab 关联的全部 resumeId（tab 级 + 各 leaf 级），用于查 session_index 的首条输入 */
function collectResumeIds(tab: Tab): string[] {
  const ids = new Set<string>();
  if (tab.resumeId && tab.resumeId !== "new") ids.add(tab.resumeId);
  for (const leaf of collectTerminalLeaves(tab.terminalRootPane)) {
    if (leaf.resumeId && leaf.resumeId !== "new") ids.add(leaf.resumeId);
  }
  return [...ids];
}

function lookupFirstPrompt(
  tab: Tab,
  firstPrompts: ReadonlyMap<string, string> | undefined,
): string | null {
  if (!firstPrompts) return null;
  for (const resumeId of collectResumeIds(tab)) {
    const prompt = firstPrompts.get(resumeId)?.trim();
    if (prompt) return prompt;
  }
  return null;
}

function resolveWorkspaceId(tab: Tab, workspaces: Workspace[]): string | null {
  // 精确：tab 记录的 workspaceName
  const byName = tab.workspaceName
    ? workspaces.find((workspace) => workspace.name === tab.workspaceName)
    : null;
  if (byName) return byName.id;
  // 兜底：projectPath 跨形式等价反查（老 tab 可能缺 workspaceName）
  if (tab.projectPath) {
    const selection = resolveTerminalContextSelection(
      { projectPath: tab.projectPath, workspaceName: tab.workspaceName },
      workspaces,
    );
    if (selection) return selection.workspaceId;
  }
  // 双失败丢弃：错误归属比不显示更糟
  return null;
}

/**
 * 跨全部普通布局（starred 镜像已由 eachLayoutTree 跳过；当前布局自动取工作副本）
 * 收集「有活 PTY 会话」的终端 tab，按 workspaceId 归组。
 * 顺序稳定：布局序 + 树内序，不按状态重排（状态轮询下重排会让点击落空）。
 */
export function deriveWorkspaceTerminals(
  state: PanesLayoutSlice,
  workspaces: Workspace[],
  statusMap: Map<string, TerminalStatusInfo>,
  /** resumeId → 首条用户输入（session_index.first_prompt），可选 */
  firstPrompts?: ReadonlyMap<string, string>,
): Map<string, WorkspaceTerminalRow[]> {
  const grouped = new Map<string, WorkspaceTerminalRow[]>();
  eachLayoutTree(state as PanesState, (layout, tree) => {
    for (const tab of collectTerminalTabs(tree)) {
      const sessionIds = collectTerminalSessionIds(tab);
      if (sessionIds.length === 0) continue;
      const workspaceId = resolveWorkspaceId(tab, workspaces);
      if (!workspaceId) continue;
      const { status, toolName } = worstStatus(sessionIds, statusMap);
      const rows = grouped.get(workspaceId) ?? [];
      rows.push({
        tabId: tab.id,
        layoutId: layout.id,
        title: tab.title,
        firstPrompt: lookupFirstPrompt(tab, firstPrompts),
        status,
        toolName,
        sessionCount: sessionIds.length,
      });
      grouped.set(workspaceId, rows);
    }
  });
  return grouped;
}
