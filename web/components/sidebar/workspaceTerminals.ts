// 工作空间树「终端模式」的数据派生：跨全部普通布局收集运行中的终端 tab，
// 按 workspace 归组。纯函数，与渲染解耦（惯例同 worktreeGrouping.ts / layoutStatusSummary.ts）。
import type { PanesState } from "@/stores/panesStoreTypes";
import { eachLayoutTree } from "@/stores/paneLayoutHelpers";

/** eachLayoutTree/layoutTree 实际只读这三个字段；收窄签名便于调用方按需订阅 */
export type PanesLayoutSlice = Pick<PanesState, "layouts" | "rootPane" | "currentLayoutId">;
import { collectTabs, collectTerminalLeaves, collectTerminalSessionIdsWithSaved } from "@/lib/paneSessions";
import { projectPathsEquivalent } from "@/utils/projectIdentity";
import type { AgentChatRowIndex } from "./agentChatRows";
import { engineSequence } from "./sessionCardModel";
import { severityRank } from "@/lib/statusPresentation";
import { resolveTerminalContextSelection } from "@/hooks/useFollowActiveTerminalContext";
import type { Tab, Workspace } from "@/types";
import type { OscProgressBadge, TerminalStatusInfo, TerminalStatusType } from "@/types";

export { severityRank } from "@/lib/statusPresentation";

export interface WorkspaceTerminalRow {
  tabId: string;
  /** 终端标签 / Agent 对话标签（后者没有 PTY，状态来自 chat 阶段） */
  kind: "terminal" | "agent-chat";
  layoutId: string;
  title: string;
  /**
   * 用户对该会话的首条输入（来自 session_index.first_prompt，经 resumeId 关联）。
   * 有值时 UI 优先用它作行名，原 title 降级为次行/tooltip。
   */
  firstPrompt: string | null;
  /** CLI 自己起的会话标题（优先级高于首条输入）；没有则 null */
  sessionTitle: string | null;
  /** 用户手动重命名过标签：行名直接用 title */
  titleRenamed: boolean;
  /** 固定（置顶）的标签：列表里排在最前 */
  pinned: boolean;
  /** 各 leaf 中最严重的状态（无状态记录时为 null） */
  status: TerminalStatusType | null;
  /** toolRunning 时的工具名（取自状态最严重的那个 leaf） */
  toolName: string | null;
  /** OSC 9;4 进度徽章（F5），取自状态最严重的那个 leaf；null = 无信号 */
  oscProgress: OscProgressBadge | null;
  /** 该 tab 下的活 PTY 会话数（分屏 >1 时 UI 显示 ×N） */
  sessionCount: number;
  /** 所属项目显示名（项目别名 > 目录名）；拿不到时为空串 */
  projectName: string;
  /** 用过的 CLI/引擎（去重，最近的在后） */
  engines: string[];
  /** 最近活动时间（毫秒）；未知为 null */
  lastActivityAt: number | null;
}

function worstStatus(
  sessionIds: string[],
  statusMap: Map<string, TerminalStatusInfo>,
): {
  status: TerminalStatusType | null;
  toolName: string | null;
  oscProgress: OscProgressBadge | null;
  sessionId: string | null;
} {
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
    oscProgress: best?.oscProgress ?? null,
    sessionId: best?.sessionId ?? null,
  };
}

/** tab 关联的全部 resumeId（tab 级 + 各 leaf 级），用于查 session_index 的首条输入 */
export function collectResumeIds(tab: Tab): string[] {
  const ids = new Set<string>();
  if (tab.resumeId && tab.resumeId !== "new") ids.add(tab.resumeId);
  for (const leaf of collectTerminalLeaves(tab.terminalRootPane)) {
    if (leaf.resumeId && leaf.resumeId !== "new") ids.add(leaf.resumeId);
  }
  return [...ids];
}

/** 会话索引里的命名信息：CLI 标题 + 首条输入。 */
export interface SessionLabel {
  title: string;
  firstPrompt: string;
  /** 索引里记录的 CLI（claude / codex …），用于补齐引擎图标 */
  cliTool?: string;
  /** 转录文件 mtime（毫秒），无 PTY 输出记录时作最近活动兜底 */
  mtimeMs?: number;
}

export type SessionLabelIndex = ReadonlyMap<string, string | SessionLabel>;

function lookupSessionLabel(
  tab: Tab,
  labels: SessionLabelIndex | undefined,
): { firstPrompt: string | null; sessionTitle: string | null; label: SessionLabel | null } {
  if (labels) {
    for (const resumeId of collectResumeIds(tab)) {
      const entry = labels.get(resumeId);
      if (!entry) continue;
      const label: SessionLabel = typeof entry === "string" ? { title: "", firstPrompt: entry } : entry;
      const firstPrompt = label.firstPrompt.trim() || null;
      const sessionTitle = label.title.trim() || null;
      if (firstPrompt || sessionTitle) return { firstPrompt, sessionTitle, label };
    }
  }
  return { firstPrompt: null, sessionTitle: null, label: null };
}

function basename(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
}

/** 项目显示名：工作空间里登记的项目别名 > 项目目录名 > 标签路径目录名。 */
export function resolveProjectName(tab: Tab, workspace: Workspace | undefined): string {
  const projectPath = tab.projectPath?.trim();
  if (!projectPath) return "";
  const project = workspace?.projects?.find((item) => projectPathsEquivalent(item.path, projectPath));
  return project?.alias?.trim() || basename(project?.path ?? projectPath);
}

/** 终端 tab 用过的 CLI：各 leaf 按最近输出时间升序排，去重后最近的在右。 */
function terminalEngines(
  tab: Tab,
  statusMap: Map<string, TerminalStatusInfo>,
  label: SessionLabel | null,
): { engines: string[]; lastActivityAt: number | null } {
  const leaves = collectTerminalLeaves(tab.terminalRootPane);
  const entries = leaves.map((leaf, order) => ({
    cli: leaf.cliTool ?? tab.cliTool,
    at: leaf.sessionId ? statusMap.get(leaf.sessionId)?.lastOutputAt ?? 0 : 0,
    order,
  }));
  if (entries.length === 0) {
    entries.push({ cli: tab.cliTool, at: tab.sessionId ? statusMap.get(tab.sessionId)?.lastOutputAt ?? 0 : 0, order: 0 });
  }
  entries.sort((a, b) => a.at - b.at || a.order - b.order);
  const tools = entries.map((entry) => (entry.cli && entry.cli !== "none" ? entry.cli : null));
  const engines = engineSequence(tools.some(Boolean) ? tools : [label?.cliTool]);
  const latest = Math.max(0, ...entries.map((entry) => entry.at));
  return { engines, lastActivityAt: latest > 0 ? latest : label?.mtimeMs || null };
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
 * 带归属信息的会话行（任务视图用）：
 * - workspaceId：归属失败为 null（任务视图照常展示，工作空间树丢弃）
 * - primarySessionId：状态最严重的那个 leaf，任务视图据此查「进入当前状态的时刻」；Agent 对话为 null
 */
export interface TerminalRowWithWorkspace extends WorkspaceTerminalRow {
  workspaceId: string | null;
  primarySessionId: string | null;
  /** 标签的项目路径（「在此项目新开」用）；没有为 null */
  projectPath: string | null;
}

/**
 * 跨全部普通布局（starred 镜像已由 eachLayoutTree 跳过；当前布局自动取工作副本）
 * 收集「有活 PTY 会话」的终端 tab 与 Agent 对话 tab，平铺返回。
 * 顺序稳定：布局序 + 树内序，不按状态重排（状态轮询下重排会让点击落空）。
 */
export function collectTerminalRows(
  state: PanesLayoutSlice,
  workspaces: Workspace[],
  statusMap: Map<string, TerminalStatusInfo>,
  /** resumeId → 会话标题/首条用户输入（session_index），可选 */
  firstPrompts?: SessionLabelIndex,
  /** chat 标签摘要（key = tabId）；不传则不列 Agent 对话标签 */
  agentChats?: AgentChatRowIndex,
): TerminalRowWithWorkspace[] {
  const rows: TerminalRowWithWorkspace[] = [];
  const workspaceById = (id: string | null) => (id ? workspaces.find((ws) => ws.id === id) : undefined);
  eachLayoutTree(state as PanesState, (layout, tree) => {
    for (const tab of collectTabs(tree)) {
      if (tab.contentType === "agent-chat") {
        const chat = agentChats?.get(tab.id);
        if (!chat) continue;
        const workspaceId = resolveWorkspaceId(tab, workspaces);
        rows.push({
          tabId: tab.id,
          kind: "agent-chat",
          layoutId: layout.id,
          title: tab.title,
          firstPrompt: chat.firstPrompt,
          sessionTitle: chat.title,
          titleRenamed: tab.titleRenamed === true,
          pinned: tab.pinned === true,
          status: chat.status,
          toolName: null,
          oscProgress: null,
          sessionCount: 1,
          projectName: resolveProjectName(tab, workspaceById(workspaceId)),
          engines: chat.engines,
          lastActivityAt: chat.lastActivityAt,
          workspaceId,
          primarySessionId: null,
          projectPath: tab.projectPath?.trim() || null,
        });
        continue;
      }
      if (tab.contentType !== "terminal") continue;
      // 全量口径：恢复中（savedSessionId 尚未 attach）的会话也算活 PTY，进列表且计入 ×N
      const sessionIds = collectTerminalSessionIdsWithSaved(tab);
      if (sessionIds.length === 0) continue;
      const workspaceId = resolveWorkspaceId(tab, workspaces);
      const { status, toolName, oscProgress, sessionId } = worstStatus(sessionIds, statusMap);
      const { label, ...naming } = lookupSessionLabel(tab, firstPrompts);
      rows.push({
        tabId: tab.id,
        kind: "terminal",
        layoutId: layout.id,
        title: tab.title,
        ...naming,
        titleRenamed: tab.titleRenamed === true,
        pinned: tab.pinned === true,
        status,
        toolName,
        oscProgress,
        sessionCount: sessionIds.length,
        projectName: resolveProjectName(tab, workspaceById(workspaceId)),
        ...terminalEngines(tab, statusMap, label),
        workspaceId,
        primarySessionId: sessionId,
        projectPath: tab.projectPath?.trim() || null,
      });
    }
  });
  return rows;
}

/** collectTerminalRows 按 workspaceId 归组；归属失败的行丢弃（错误归属比不显示更糟）。 */
export function deriveWorkspaceTerminals(
  state: PanesLayoutSlice,
  workspaces: Workspace[],
  statusMap: Map<string, TerminalStatusInfo>,
  firstPrompts?: SessionLabelIndex,
  agentChats?: AgentChatRowIndex,
): Map<string, WorkspaceTerminalRow[]> {
  const grouped = new Map<string, WorkspaceTerminalRow[]>();
  for (const { workspaceId, primarySessionId: _primary, projectPath: _path, ...row } of collectTerminalRows(
    state, workspaces, statusMap, firstPrompts, agentChats,
  )) {
    if (!workspaceId) continue;
    const rows = grouped.get(workspaceId) ?? [];
    rows.push(row);
    grouped.set(workspaceId, rows);
  }
  return grouped;
}

/** 全部普通布局里终端标签关联的 resumeId（去重排序，作为会话索引精确查询的键）。 */
export function collectLayoutResumeIds(state: PanesLayoutSlice): string[] {
  const ids = new Set<string>();
  eachLayoutTree(state as PanesState, (_layout, tree) => {
    for (const tab of collectTabs(tree)) {
      if (tab.contentType === "terminal") collectResumeIds(tab).forEach((id) => ids.add(id));
    }
  });
  return [...ids].sort();
}

/** 全部普通布局里的 Agent 对话标签（只取 id 与预选引擎，供 chat 摘要派生）。 */
export function collectLayoutAgentChatTabs(state: PanesLayoutSlice): { id: string; agentEngineId?: string }[] {
  const tabs: { id: string; agentEngineId?: string }[] = [];
  eachLayoutTree(state as PanesState, (_layout, tree) => {
    for (const tab of collectTabs(tree)) {
      if (tab.contentType === "agent-chat") tabs.push({ id: tab.id, agentEngineId: tab.agentEngineId });
    }
  });
  return tabs;
}
