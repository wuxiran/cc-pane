// 权限自动放行策略：把 ACP ToolKind（read/edit/delete/move/search/execute/
// fetch/think/switch_mode/other）归成用户能理解的几组，UI 多选后展开成
// kind 集合交给后端做纯集合匹配（后端只认 kind 与 `*` 通配，不知道分组）。

export const AUTO_APPROVE_ALL = "*";

export type PermissionGroupLabelKey =
  | "agentChatPermRead"
  | "agentChatPermEdit"
  | "agentChatPermExecute"
  | "agentChatPermFetch"
  | "agentChatPermOther";

export interface PermissionGroup {
  id: string;
  /** panes 命名空间下的 i18n key。 */
  labelKey: PermissionGroupLabelKey;
  /** 该组覆盖的 ACP ToolKind。 */
  kinds: readonly string[];
}

export const PERMISSION_GROUPS: readonly PermissionGroup[] = [
  { id: "read", labelKey: "agentChatPermRead", kinds: ["read", "search"] },
  { id: "edit", labelKey: "agentChatPermEdit", kinds: ["edit", "delete", "move"] },
  { id: "execute", labelKey: "agentChatPermExecute", kinds: ["execute"] },
  { id: "fetch", labelKey: "agentChatPermFetch", kinds: ["fetch"] },
  { id: "other", labelKey: "agentChatPermOther", kinds: ["think", "switch_mode", "other"] },
];

export function isAutoApproveAll(kinds: readonly string[]): boolean {
  return kinds.includes(AUTO_APPROVE_ALL);
}

/** 某组是否已被整体勾选（组内每个 kind 都在集合里，或通配）。 */
export function isGroupEnabled(kinds: readonly string[], group: PermissionGroup): boolean {
  if (isAutoApproveAll(kinds)) return true;
  return group.kinds.every((kind) => kinds.includes(kind));
}

/** 切换一组；从通配态退出时先展开成全组集合再去掉该组。 */
export function toggleGroup(kinds: readonly string[], group: PermissionGroup): string[] {
  const expanded = isAutoApproveAll(kinds)
    ? PERMISSION_GROUPS.flatMap((item) => [...item.kinds])
    : [...kinds];
  if (isGroupEnabled(expanded, group)) {
    return expanded.filter((kind) => !group.kinds.includes(kind));
  }
  const next = new Set(expanded);
  for (const kind of group.kinds) next.add(kind);
  return normalize([...next]);
}

/** 全部勾上 → 折叠为通配；否则原样（去重、剔除通配）。 */
export function normalize(kinds: readonly string[]): string[] {
  const unique = Array.from(new Set(kinds.filter((kind) => kind && kind !== AUTO_APPROVE_ALL)));
  const everyGroup = PERMISSION_GROUPS.every((group) => isGroupEnabled(unique, group));
  return everyGroup ? [AUTO_APPROVE_ALL] : unique;
}

export function toggleAll(kinds: readonly string[]): string[] {
  return isAutoApproveAll(kinds) ? [] : [AUTO_APPROVE_ALL];
}

/** 已勾选的组数（通配 = 全部组）。 */
export function enabledGroupCount(kinds: readonly string[]): number {
  return PERMISSION_GROUPS.filter((group) => isGroupEnabled(kinds, group)).length;
}
