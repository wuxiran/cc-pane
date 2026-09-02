// 工作空间右键菜单项：打开该工作空间的 Agent Skills / Memory / MCP 管理（复用项目级
// contentType 的 tab，projectPath 为空 + workspaceName 表示工作空间视图，docs/98）。
import { Database, Layers, Server } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ContextMenuItem } from "@/components/ui/context-menu";
import { usePanesStore } from "@/stores";
import type { Workspace } from "@/types";

export default function WorkspaceSkillsMenuItem({ workspace }: { workspace: Workspace }) {
  const { t } = useTranslation("sidebar");
  const title = workspace.alias || workspace.name;
  const open = () => usePanesStore.getState();
  return (
    <>
      <ContextMenuItem onClick={() => open().openWorkspaceSkillManager(workspace.name, title)}>
        <Layers /> {t("workspaceSkills")}
      </ContextMenuItem>
      <ContextMenuItem onClick={() => open().openWorkspaceMemoryManager(workspace.name, title)}>
        <Database /> {t("workspaceMemory")}
      </ContextMenuItem>
      <ContextMenuItem onClick={() => open().openWorkspaceMcpConfig(workspace.name, title)}>
        <Server /> {t("workspaceMcp")}
      </ContextMenuItem>
    </>
  );
}
