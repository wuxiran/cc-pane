// 布局条的工作空间分组（Chrome 标签组式）：纯函数，不碰 store。
//
// - 分组键 = 布局绑定的工作空间名（手动绑定优先，否则按首个终端推导）。
// - 只有 ≥2 个布局的工作空间才成组；单个布局、未绑定的布局照常平铺。
// - 组成员在条内连续排列，整组落在第一个成员原本的位置上，组头放在最前。
// - 折叠的组只剩组头；当前布局若在折叠组里，仍紧跟组头完整显示，避免「看不到自己在哪」。
import type { LayoutEntry, PaneNode } from "@/types";
import { getLayoutWorkspaceBinding } from "@/utils/layoutWorkspace";

export interface LayoutStripGroup {
  key: string;
  members: LayoutEntry[];
  collapsed: boolean;
}

export type LayoutStripEntry =
  | { type: "group"; group: LayoutStripGroup }
  | { type: "layout"; layout: LayoutEntry; group: LayoutStripGroup | null };

export function layoutGroupKey(layout: LayoutEntry, rootPane?: PaneNode): string | null {
  if (layout.kind === "starred") return null;
  return getLayoutWorkspaceBinding({
    workspaceName: layout.workspaceName,
    rootPane: rootPane ?? layout.rootPane,
  })?.workspaceName ?? null;
}

export function buildLayoutStripEntries(
  layouts: readonly LayoutEntry[],
  options: {
    currentLayoutId: string;
    /** 当前布局的活树（store 工作副本），推导绑定时覆盖 layout.rootPane。 */
    liveRootPane?: PaneNode;
    collapsedGroups: readonly string[];
  },
): LayoutStripEntry[] {
  const keys = layouts.map((layout) =>
    layoutGroupKey(layout, layout.id === options.currentLayoutId ? options.liveRootPane : undefined));
  const membersByKey = new Map<string, LayoutEntry[]>();
  layouts.forEach((layout, index) => {
    const key = keys[index];
    if (!key) return;
    membersByKey.set(key, [...(membersByKey.get(key) ?? []), layout]);
  });

  const collapsed = new Set(options.collapsedGroups);
  const emitted = new Set<string>();
  const entries: LayoutStripEntry[] = [];
  layouts.forEach((layout, index) => {
    const key = keys[index];
    const members = key ? membersByKey.get(key) ?? [] : [];
    if (!key || members.length < 2) {
      entries.push({ type: "layout", layout, group: null });
      return;
    }
    if (emitted.has(key)) return;
    emitted.add(key);
    const group: LayoutStripGroup = { key, members, collapsed: collapsed.has(key) };
    entries.push({ type: "group", group });
    for (const member of members) {
      if (group.collapsed && member.id !== options.currentLayoutId) continue;
      entries.push({ type: "layout", layout: member, group });
    }
  });
  return entries;
}

/** 「全部布局」下拉用：按工作空间分段，未绑定的归到末尾 null 段；段内保持条内顺序。 */
export function groupLayoutsByWorkspace(
  layouts: readonly LayoutEntry[],
  currentLayoutId: string,
  liveRootPane?: PaneNode,
): Array<{ key: string | null; members: LayoutEntry[] }> {
  const sections = new Map<string | null, LayoutEntry[]>();
  for (const layout of layouts) {
    const key = layoutGroupKey(layout, layout.id === currentLayoutId ? liveRootPane : undefined);
    sections.set(key, [...(sections.get(key) ?? []), layout]);
  }
  const ordered = [...sections.entries()].filter(([key]) => key !== null);
  const loose = sections.get(null);
  if (loose) ordered.push([null, loose]);
  return ordered.map(([key, items]) => ({ key, members: items }));
}
