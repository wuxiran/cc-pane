/** 布局所属空间的稳定身份键。仅用于布局分组与查找，不作为路径或持久化数据。 */
export type LayoutScope = `workspace:${string}` | `ssh-machine:${string}`;

export const DEFAULT_LAYOUT_SCOPE: LayoutScope = "workspace:default";

type IdentityValue =
  | string
  | { id?: string | null; machineId?: string | null }
  | null
  | undefined;

type ActiveTabContext = {
  workspaceId?: string | null;
  machineId?: string | null;
  sshMachineId?: string | null;
  ssh?: { machineId?: string | null } | null;
};

export interface LayoutScopeContext {
  /** 当前工作空间，支持 ID 或带 id 的 Workspace 对象。 */
  workspace?: IdentityValue;
  workspaceId?: string | null;
  /** 当前 SSH 机器，支持 ID、SshMachine 或带 machineId 的连接信息。 */
  ssh?: IdentityValue;
  machineId?: string | null;
  /** 当前活动标签；其 SSH 连接身份优先于外层上下文。 */
  activeTab?: ActiveTabContext | null;
}

function normalizeIdentity(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized || null;
}

function identityId(value: IdentityValue): string | null {
  if (typeof value === "string") return normalizeIdentity(value);
  return normalizeIdentity(value?.machineId ?? value?.id);
}

/** 根据工作空间 ID 创建布局空间身份。 */
export function workspaceLayoutScope(workspaceId: string | null | undefined): LayoutScope {
  return `workspace:${normalizeIdentity(workspaceId) ?? "default"}`;
}

/** 根据 SSH 机器 ID 创建布局空间身份。缺失 ID 时回退到默认工作空间。 */
export function sshMachineLayoutScope(machineId: string | null | undefined): LayoutScope {
  const id = normalizeIdentity(machineId);
  return id ? `ssh-machine:${id}` : DEFAULT_LAYOUT_SCOPE;
}

/**
 * 从工作空间、SSH 机器和活动标签上下文解析布局空间身份。
 * 活动标签的 SSH 身份优先，其次是显式 SSH 上下文，再其次是工作空间上下文。
 */
export function resolveLayoutScope(context: LayoutScopeContext = {}): LayoutScope {
  const activeMachineId = context.activeTab?.ssh?.machineId
    ?? context.activeTab?.sshMachineId
    ?? context.activeTab?.machineId;
  const activeMachineScope = sshMachineLayoutScope(activeMachineId);
  if (activeMachineScope !== DEFAULT_LAYOUT_SCOPE) return activeMachineScope;

  const machineScope = sshMachineLayoutScope(
    context.machineId ?? identityId(context.ssh),
  );
  if (machineScope !== DEFAULT_LAYOUT_SCOPE) return machineScope;

  const activeWorkspaceId = normalizeIdentity(context.activeTab?.workspaceId);
  return workspaceLayoutScope(
    activeWorkspaceId ?? context.workspaceId ?? identityId(context.workspace),
  );
}
