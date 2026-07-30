// Sidebar 工作空间树的分区与拖拽落点解析（纯函数，无 React 依赖，便于单测）。
import { arrayMove } from "@dnd-kit/sortable";
import { normalizedWorkspaceGroup, UNGROUPED_WORKSPACE_FILTER } from "@/stores/useWorkspacesStore";
import type { Workspace } from "@/types";

/** 分组头 droppable 的 id 前缀；未分组段用 UNGROUPED_WORKSPACE_FILTER 作 key */
export const WORKSPACE_GROUP_DROP_PREFIX = "ws-group:";

export function workspaceGroupDropId(groupKey: string): string {
  return `${WORKSPACE_GROUP_DROP_PREFIX}${groupKey}`;
}

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

/** 一次拖放要落盘的动作。regroup 的 orderedNames 可缺省——缺省时位置交给后端排序律 */
export type WorkspaceDropPlan =
  | { kind: "reorder"; orderedNames: string[] }
  | {
      kind: "regroup";
      workspaceName: string;
      nextGroup: string | undefined;
      orderedNames?: string[];
    }
  | null;

export interface WorkspaceDropTarget {
  id: string;
  /** dnd-kit 的 over.data.current；分组头是 { type:"workspace-group", group } */
  type?: string;
  group?: string | null;
}

function groupKeyOf(workspace: Workspace): string | null {
  return workspace.group?.trim() || null;
}

/**
 * 解析工作空间拖放：
 * - 落到同组成员 → 纯排序（既有行为）
 * - 落到他组成员 → 改组 + 插到该成员位置；跨 pinned 边界时只改组不排序
 * - 落到分组头（含折叠的组）→ 改组，位置交给后端排序律，只发一次写
 * - 落到「未分组」头 → 清空 group
 * 默认工作空间恒置顶，任一侧命中即拒绝。
 */
export function resolveWorkspaceDrop(
  workspaces: Workspace[],
  activeId: string,
  over: WorkspaceDropTarget,
): WorkspaceDropPlan {
  const active = workspaces.find((workspace) => workspace.id === activeId);
  if (!active || active.isDefault) return null;

  if (over.type === "workspace-group") {
    const rawGroup = over.group ?? null;
    const nextGroup =
      !rawGroup || rawGroup === UNGROUPED_WORKSPACE_FILTER ? undefined : rawGroup.trim();
    // 已经在目标组里，拖到自己组的头上是空操作
    if ((groupKeyOf(active) ?? undefined) === nextGroup) return null;
    return { kind: "regroup", workspaceName: active.name, nextGroup };
  }

  const overIndex = workspaces.findIndex((workspace) => workspace.id === over.id);
  const activeIndex = workspaces.findIndex((workspace) => workspace.id === activeId);
  if (overIndex === -1 || activeIndex === -1 || overIndex === activeIndex) return null;

  const overWorkspace = workspaces[overIndex];
  if (overWorkspace.isDefault) return null;

  const activeGroup = groupKeyOf(active);
  const overGroup = groupKeyOf(overWorkspace);

  if (activeGroup === overGroup) {
    const orderedNames = getReorderedWorkspaceNames(workspaces, activeId, over.id);
    return orderedNames ? { kind: "reorder", orderedNames } : null;
  }

  // 跨组：group 与 pinned 是正交属性，允许改组；但跨 pinned 边界时不下发排序，
  // 交给后端 list_workspaces 的 is_default → group_min_orders → pinned → sort_order
  // 排序律安置，避免发一个会被后端重排的顺序。
  const crossesPinnedBoundary = !!active.pinned !== !!overWorkspace.pinned;
  return {
    kind: "regroup",
    workspaceName: active.name,
    nextGroup: overGroup ?? undefined,
    orderedNames: crossesPinnedBoundary
      ? undefined
      : arrayMove(workspaces, activeIndex, overIndex).map((workspace) => workspace.name),
  };
}
