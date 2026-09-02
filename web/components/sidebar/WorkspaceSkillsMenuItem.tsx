// 工作空间右键菜单项：打开该工作空间的 Agent Skills 管理（复用 skill-manager tab）。
import { Layers } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ContextMenuItem } from "@/components/ui/context-menu";
import { usePanesStore } from "@/stores";
import type { Workspace } from "@/types";

export default function WorkspaceSkillsMenuItem({ workspace }: { workspace: Workspace }) {
  const { t } = useTranslation("sidebar");
  return (
    <ContextMenuItem
      onClick={() =>
        usePanesStore.getState().openWorkspaceSkillManager(workspace.name, workspace.alias || workspace.name)
      }
    >
      <Layers /> {t("workspaceSkills")}
    </ContextMenuItem>
  );
}
