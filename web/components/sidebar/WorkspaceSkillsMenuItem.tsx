// 工作空间右键菜单项：Memory 用工作空间视图的标签（docs/98），技能和 MCP 打开资源库并选中该工作空间。
import { Database, Layers, Server } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ContextMenuItem } from "@/components/ui/context-menu";
import { usePanesStore } from "@/stores";
import { openResourceLibrary } from "@/stores/useResourceLibraryStore";
import type { Workspace } from "@/types";

export default function WorkspaceSkillsMenuItem({ workspace }: { workspace: Workspace }) {
  const { t } = useTranslation("sidebar");
  const title = workspace.alias || workspace.name;
  const open = () => usePanesStore.getState();
  return (
    <>
      <ContextMenuItem onClick={() => openResourceLibrary("skills", { workspaceName: workspace.name })}>
        <Layers /> {t("workspaceSkills")}
      </ContextMenuItem>
      <ContextMenuItem onClick={() => open().openWorkspaceMemoryManager(workspace.name, title)}>
        <Database /> {t("workspaceMemory")}
      </ContextMenuItem>
      <ContextMenuItem onClick={() => openResourceLibrary("mcp", { workspaceName: workspace.name })}>
        <Server /> {t("workspaceMcp")}
      </ContextMenuItem>
    </>
  );
}
