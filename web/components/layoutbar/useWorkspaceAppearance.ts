// 布局分组按工作空间名取展示名（别名优先）与颜色变量。
import { workspaceColorVar } from "@/components/sidebar/WorkspaceColorDot";
import { useWorkspacesStore } from "@/stores";

export function useWorkspaceAppearance(name: string) {
  const workspace = useWorkspacesStore((s) => s.workspaces.find((item) => item.name === name));
  return {
    label: workspace?.alias || name,
    color: workspaceColorVar(workspace?.color),
  };
}
