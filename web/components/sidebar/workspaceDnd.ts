// Sidebar 工作空间树的分区与拖拽落点解析（纯函数，无 React 依赖，便于单测）。
import { arrayMove } from "@dnd-kit/sortable";
import { normalizedWorkspaceGroup } from "@/stores/useWorkspacesStore";
import type { Workspace } from "@/types";

export interface WorkspacePartition {
  defaults: Workspace[];
  groups: Array<{ group: string; workspaces: Workspace[] }>;
  ungrouped: Workspace[];
}

export function partitionWorkspaces(workspaces: Workspace[]): WorkspacePartition {
  const defaults: Workspace[] = [];
  const ungrouped: Workspace[] = [];
  const groupMap = new Map<string, Workspace[]>();

  for (const workspace of workspaces) {
    if (workspace.isDefault) {
      defaults.push(workspace);
      continue;
    }
    const group = normalizedWorkspaceGroup(workspace);
    if (!group) {
      ungrouped.push(workspace);
      continue;
    }
    const members = groupMap.get(group) ?? [];
    members.push(workspace);
    groupMap.set(group, members);
  }

  return {
    defaults,
    groups: [...groupMap].map(([group, members]) => ({ group, workspaces: members })),
    ungrouped,
  };
}

export function getReorderedWorkspaceNames(
  workspaces: Workspace[],
  activeId: string,
  overId: string,
): string[] | null {
  const oldIndex = workspaces.findIndex((workspace) => workspace.id === activeId);
  const newIndex = workspaces.findIndex((workspace) => workspace.id === overId);
  if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) {
    return null;
  }

  const activeWorkspace = workspaces[oldIndex];
  const overWorkspace = workspaces[newIndex];
  // 默认工作空间恒置顶，不参与拖拽排序
  if (activeWorkspace.isDefault || overWorkspace.isDefault) {
    return null;
  }
  if (!!activeWorkspace.pinned !== !!overWorkspace.pinned) {
    return null;
  }
  const activeGroup = activeWorkspace.group?.trim() || null;
  const overGroup = overWorkspace.group?.trim() || null;
  if (activeGroup !== overGroup) {
    return null;
  }

  return arrayMove(workspaces, oldIndex, newIndex).map((workspace) => workspace.name);
}
