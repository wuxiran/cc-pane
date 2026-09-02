// 工作空间右键菜单项：打开该工作空间的 Agent Skills / Memory 管理（复用 skill-manager /
// memory-manager tab，projectPath 为空 + workspaceName 表示工作空间视图）。
import { Database, Layers } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ContextMenuItem } from "@/components/ui/context-menu";
import { usePanesStore } from "@/stores";
import type { Workspace } from "@/types";

export default function WorkspaceSkillsMenuItem({ workspace }: { workspace: Workspace }) {
  const { t } = useTranslation("sidebar");
  const title = workspace.alias || workspace.name;
  return (
    <>
      <ContextMenuItem onClick={() => usePanesStore.getState().openWorkspaceSkillManager(workspace.name, title)}>
        <Layers /> {t("workspaceSkills")}
      </ContextMenuItem>
      <ContextMenuItem onClick={() => usePanesStore.getState().openWorkspaceMemoryManager(workspace.name, title)}>
        <Database /> {t("workspaceMemory")}
      </ContextMenuItem>
    </>
  );
}
