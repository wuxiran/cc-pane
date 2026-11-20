// 「会话」视图的数据整形：CLI 启动记录和 Agent 对话合成一份列表，
// 按工作空间分组、组内按时间倒序。每一行自带 kind，界面据此打「终端 / 对话」标签。
import type { LaunchRecord } from "@/services";
import type { Workspace } from "@/types";
import type { AcpChatHistoryEntry } from "@/types/agentChat";

export type SessionKindFilter = "all" | "cli" | "chat";

export type SessionEntry =
  | { kind: "cli"; key: string; time: number; record: LaunchRecord }
  | { kind: "chat"; key: string; time: number; chat: AcpChatHistoryEntry };

export interface SessionGroup {
  workspaceName: string;
  entries: SessionEntry[];
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function isInside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(`${parent}/`);
}

/** 对话只记了 cwd：按「落在哪个工作空间的项目 / 根目录里」归组，取最长匹配。 */
export function workspaceNameForCwd(cwd: string, workspaces: Workspace[]): string | null {
  const target = normalizePath(cwd);
  if (!target) return null;
  let best: { name: string; length: number } | null = null;
  for (const workspace of workspaces) {
    // 系统工作空间不在侧栏列表里，归到「未分组」。
    if (workspace.isDefault || workspace.isAgentChat) continue;
    const roots = [workspace.path, ...workspace.projects.map((project) => project.path)];
    for (const root of roots) {
      if (!root) continue;
      const normalized = normalizePath(root);
      if (!normalized || !isInside(target, normalized)) continue;
      if (!best || normalized.length > best.length) best = { name: workspace.name, length: normalized.length };
    }
  }
  return best?.name ?? null;
}

export function buildSessionGroups(
  records: LaunchRecord[],
  chats: AcpChatHistoryEntry[],
  workspaces: Workspace[],
  ungroupedLabel: string,
  filter: SessionKindFilter = "all",
): SessionGroup[] {
  const map = new Map<string, SessionEntry[]>();
  const add = (name: string, entry: SessionEntry) => {
    const list = map.get(name);
    if (list) list.push(entry);
    else map.set(name, [entry]);
  };

  if (filter !== "chat") {
    for (const record of records) {
      // 只保留能恢复的记录。
      if (!record.resumeSessionId) continue;
      add(record.workspaceName || ungroupedLabel, {
        kind: "cli",
        key: `r:${record.id}`,
        time: Date.parse(record.launchedAt) || 0,
        record,
      });
    }
  }
  if (filter !== "cli") {
    for (const chat of chats) {
      add(workspaceNameForCwd(chat.cwd, workspaces) ?? ungroupedLabel, {
        kind: "chat",
        key: `c:${chat.acpSessionId}`,
        time: chat.updatedAt,
        chat,
      });
    }
  }

  const groups: SessionGroup[] = [];
  for (const [workspaceName, entries] of map) {
    // sort 稳定：同一时刻的保持原有顺序。
    groups.push({ workspaceName, entries: entries.sort((a, b) => b.time - a.time) });
  }
  // 「未分组」放到最后
  groups.sort((a, b) => {
    if (a.workspaceName === ungroupedLabel) return 1;
    if (b.workspaceName === ungroupedLabel) return -1;
    return a.workspaceName.localeCompare(b.workspaceName);
  });
  return groups;
}
