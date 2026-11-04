// 简洁模式的纯模型：把终端启动记录和 Agent 对话合成一种「会话」，按项目挂载。
// 会话只有路径没有项目 id，归属靠路径最长前缀匹配；匹配不到的进「其他」。
import type { LaunchRecord } from "@/services/historyService";
import type { AcpChatHistoryEntry } from "@/types/agentChat";
import type { Workspace, WorkspaceProject } from "@/types";

export type SimpleSession =
  | { kind: "terminal"; key: string; record: LaunchRecord; path: string; title: string; time: number }
  | { kind: "chat"; key: string; entry: AcpChatHistoryEntry; path: string; title: string; time: number };

export interface SimpleProjectGroup {
  /** null = 「其他」（没落到任何已注册项目的会话） */
  project: WorkspaceProject | null;
  sessions: SimpleSession[];
}

export interface SimpleWorkspaceGroup {
  /** null = 「其他」 */
  workspace: Workspace | null;
  projects: SimpleProjectGroup[];
}

const TITLE_LIMIT = 40;

export function terminalSessionKey(record: Pick<LaunchRecord, "id">): string {
  return `launch:${record.id}`;
}

export function chatSessionKey(entry: Pick<AcpChatHistoryEntry, "acpSessionId">): string {
  return `chat:${entry.acpSessionId}`;
}

function terminalTitle(record: LaunchRecord): string {
  const prompt = record.lastPrompt?.trim();
  if (prompt) return prompt.length > TITLE_LIMIT ? `${prompt.slice(0, TITLE_LIMIT)}…` : prompt;
  return record.projectName;
}

export function mergeSessions(records: readonly LaunchRecord[], entries: readonly AcpChatHistoryEntry[]): SimpleSession[] {
  const terminals: SimpleSession[] = records
    .filter((record) => !!record.resumeSessionId)
    .map((record) => ({
      kind: "terminal",
      key: terminalSessionKey(record),
      record,
      path: record.projectPath,
      title: terminalTitle(record),
      time: Date.parse(record.launchedAt) || 0,
    }));
  const chats: SimpleSession[] = entries
    .filter((entry) => !!entry.acpSessionId)
    .map((entry) => ({
      kind: "chat",
      key: chatSessionKey(entry),
      entry,
      path: entry.cwd,
      title: entry.title?.trim() || entry.acpSessionId.slice(0, 8),
      time: entry.updatedAt || entry.createdAt || 0,
    }));
  return [...terminals, ...chats].sort((a, b) => b.time - a.time);
}

/** 用户自己的工作空间：剔除系统默认、Agent Chat 专用和已归档的，保持后端排序 */
export function userWorkspaces(workspaces: readonly Workspace[]): Workspace[] {
  return workspaces.filter((ws) => !ws.isDefault && !ws.isAgentChat && !ws.archivedAt);
}

const WINDOWS_PATH = /^[a-zA-Z]:[\\/]|^\\\\/;

/** 统一分隔符、去尾斜杠；Windows 路径不区分大小写 */
export function normalizePath(path: string): string {
  const unified = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return WINDOWS_PATH.test(path) ? unified.toLowerCase() : unified;
}

function isWithin(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

export function groupByProject(sessions: readonly SimpleSession[], workspaces: readonly Workspace[]): SimpleWorkspaceGroup[] {
  const candidates: { workspace: Workspace; project: WorkspaceProject; root: string }[] = [];
  for (const workspace of userWorkspaces(workspaces)) {
    for (const project of workspace.projects) {
      if (project.archivedAt) continue;
      candidates.push({ workspace, project, root: normalizePath(project.path) });
    }
  }

  const byProject = new Map<string, SimpleSession[]>();
  const other: SimpleSession[] = [];
  for (const session of sessions) {
    const path = normalizePath(session.path);
    let best: (typeof candidates)[number] | null = null;
    for (const candidate of candidates) {
      if (isWithin(path, candidate.root) && (!best || candidate.root.length > best.root.length)) best = candidate;
    }
    if (!best) {
      other.push(session);
      continue;
    }
    const list = byProject.get(best.project.id) ?? [];
    list.push(session);
    byProject.set(best.project.id, list);
  }

  const groups: SimpleWorkspaceGroup[] = [];
  for (const workspace of userWorkspaces(workspaces)) {
    const projects = workspace.projects
      .filter((project) => !project.archivedAt)
      .map((project) => ({ project, sessions: byProject.get(project.id) ?? [] }));
    groups.push({ workspace, projects });
  }
  if (other.length > 0) groups.push({ workspace: null, projects: [{ project: null, sessions: other }] });
  return groups;
}

export function recentSessions(sessions: readonly SimpleSession[], limit = 8): SimpleSession[] {
  return sessions.slice(0, limit);
}

/** 按置顶顺序取会话；已不存在的 key 忽略 */
export function pinnedSessions(sessions: readonly SimpleSession[], keys: readonly string[]): SimpleSession[] {
  const byKey = new Map(sessions.map((session) => [session.key, session]));
  return keys.flatMap((key) => {
    const session = byKey.get(key);
    return session ? [session] : [];
  });
}

/** 无选中项目时的上下文工作空间：偏好名存在且可用则用它，否则首个用户工作空间 */
export function defaultContextWorkspace(workspaces: readonly Workspace[], preferredName: string | null): Workspace | null {
  const usable = userWorkspaces(workspaces);
  return (preferredName ? usable.find((ws) => ws.name === preferredName) : undefined) ?? usable[0] ?? null;
}
