// 布局 ↔ 工作空间绑定解析（阶段 1，纯前端）。
// 绑定键是 workspaceName（全链路只有 name 无 id）：
// - manual：LayoutEntry.workspaceName 手动绑定，优先级最高
// - derived：布局 rootPane 深度优先遍历，取第一个带 workspaceName 的 terminal tab 推导
import type { LayoutEntry, PaneNode, Tab } from "@/types";

export type LayoutWorkspaceBindingSource = "manual" | "derived";

export interface LayoutWorkspaceBinding {
  workspaceName: string;
  source: LayoutWorkspaceBindingSource;
}

function collectTabsDepthFirst(node: PaneNode): Tab[] {
  if (node.type === "panel") return node.tabs;
  return node.children.flatMap(collectTabsDepthFirst);
}

function deriveWorkspaceName(rootPane: PaneNode): string | null {
  for (const tab of collectTabsDepthFirst(rootPane)) {
    if (tab.contentType !== "terminal") continue;
    const name = tab.workspaceName?.trim();
    if (name) return name;
  }
  return null;
}

/** 解析布局的工作空间绑定：manual 优先，否则按布局内首个 terminal tab 推导；均无则 null */
export function getLayoutWorkspaceBinding(
  layout: Pick<LayoutEntry, "workspaceName" | "rootPane">,
): LayoutWorkspaceBinding | null {
  const manual = layout.workspaceName?.trim();
  if (manual) {
    return { workspaceName: manual, source: "manual" };
  }
  const derived = deriveWorkspaceName(layout.rootPane);
  return derived ? { workspaceName: derived, source: "derived" } : null;
}

/**
 * 找该工作空间应落位的布局：过滤星标；manual 绑定优先于 derived；
 * 同源多个命中时按 lastActiveAt 取最近使用的。无命中返回 null。
 */
export function findLayoutForWorkspace(
  layouts: LayoutEntry[],
  workspaceName: string,
): LayoutEntry | null {
  const target = workspaceName.trim();
  if (!target) return null;

  let best: { layout: LayoutEntry; source: LayoutWorkspaceBindingSource } | null = null;
  for (const layout of layouts) {
    if (layout.kind === "starred") continue;
    const binding = getLayoutWorkspaceBinding(layout);
    if (!binding || binding.workspaceName !== target) continue;
    if (!best) {
      best = { layout, source: binding.source };
      continue;
    }
    const bestManual = best.source === "manual";
    const currentManual = binding.source === "manual";
    if (currentManual !== bestManual) {
      if (currentManual) best = { layout, source: binding.source };
      continue;
    }
    if ((layout.lastActiveAt ?? 0) > (best.layout.lastActiveAt ?? 0)) {
      best = { layout, source: binding.source };
    }
  }
  return best?.layout ?? null;
}
