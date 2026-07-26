import type { AiPanelSummary, AiPanelWorkspaceGroup } from "@/types/aiPanel";

/**
 * 把历史摘要按工作空间分组。
 *
 * 依赖后端已排好的顺序（工作空间名 NOCASE 升序、未归类垫底、组内最近更新在前），
 * 这里只做**相邻聚合**，不再排序——重排会把后端的 NULL 垫底规则打乱。
 */
export function groupPanelsByWorkspace(panels: AiPanelSummary[]): AiPanelWorkspaceGroup[] {
  const groups: AiPanelWorkspaceGroup[] = [];
  for (const panel of panels) {
    const last = groups[groups.length - 1];
    if (last && last.workspaceName === panel.workspaceName) {
      last.panels.push(panel);
    } else {
      groups.push({ workspaceName: panel.workspaceName, panels: [panel] });
    }
  }
  return groups;
}

/** 人类可读的体积，用于让用户判断该不该删。 */
export function formatContentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
