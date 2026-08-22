import { Archive, ArchiveRestore } from "lucide-react";
import { useTranslation } from "react-i18next";

import { ContextMenuItem } from "@/components/ui/context-menu";

interface ArchiveMenuItemProps {
  /** 归档时间戳；有值即已归档，菜单翻成「恢复」 */
  archivedAt?: string | null;
  onToggle: (nextArchived: boolean) => void;
  /** 工作空间与项目的文案不同 */
  target: "workspace" | "project";
}

/**
 * 归档 / 恢复的右键菜单项，工作空间与项目共用。
 *
 * 归档是**可逆**的逻辑删除（只打时间戳，不删数据），因此刻意不做二次确认——
 * 调用方应把它放在 destructive 的删除项**之上**：可逆操作应该比不可逆的更容易够到。
 * 恢复走同一个入口（已归档时自动翻成「恢复」），用户不必去别处找回退路。
 */
export default function ArchiveMenuItem({
  archivedAt,
  onToggle,
  target,
}: ArchiveMenuItemProps) {
  const { t } = useTranslation("sidebar");
  const archived = !!archivedAt;
  const labelKey = archived
    ? target === "workspace"
      ? "restoreWorkspace"
      : "restoreProject"
    : target === "workspace"
      ? "archiveWorkspace"
      : "archiveProject";

  return (
    <ContextMenuItem onClick={() => onToggle(!archived)}>
      {archived ? <ArchiveRestore /> : <Archive />} {t(labelKey)}
    </ContextMenuItem>
  );
}
