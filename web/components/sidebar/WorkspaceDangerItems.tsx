// 工作空间右键菜单里的「生命周期」条目：归档 + 删除。
// 从 WorkspaceItem 拆出（行数棘轮）。常驻系统工作空间（默认 / Agent Chat）
// 由调用方决定不渲染本组件——后端对两者同样拒绝删除/归档，这里是 UI 双保险。
import { Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Workspace } from "@/types";
import { ContextMenuItem } from "@/components/ui/context-menu";
import { useWorkspacesStore } from "@/stores";
import ArchiveMenuItem from "./ArchiveMenuItem";

export interface WorkspaceDangerItemsProps {
  workspace: Workspace;
  onDelete: (ws: Workspace) => void;
}

export default function WorkspaceDangerItems({ workspace, onDelete }: WorkspaceDangerItemsProps) {
  const { t } = useTranslation(["sidebar", "common"]);
  const setArchived = useWorkspacesStore((state) => state.setArchived);

  return (
    <>
      <ArchiveMenuItem
        target="workspace"
        archivedAt={workspace.archivedAt}
        onToggle={(next) => void setArchived(workspace.name, next)}
      />
      <ContextMenuItem variant="destructive" onClick={() => onDelete(workspace)}>
        <Trash2 /> {t("deleteWorkspace")}
      </ContextMenuItem>
    </>
  );
}
