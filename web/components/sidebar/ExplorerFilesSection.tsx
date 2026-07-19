// Explorer 文件视图：工作空间下所有项目各一个可折叠根节点（IDEA 多模块风格）。
// 选中项目的根自动展开，其余默认折叠；折叠的项目根不挂载 FileTree（大工作空间懒加载）。
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight } from "lucide-react";
import { FileTree } from "@/components/filetree";
import { getProjectName } from "@/utils/path";
import type { Workspace } from "@/types";

interface ExplorerFilesSectionProps {
  workspace: Workspace | null;
  selectedProjectId: string | null;
}

export default function ExplorerFilesSection({
  workspace,
  selectedProjectId,
}: ExplorerFilesSectionProps) {
  const { t } = useTranslation("sidebar");
  // 用户手动开合的覆盖项；选中项目/工作空间变化时清空，让新选中的项目根立即自动展开
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  useEffect(() => {
    setOverrides({});
  }, [selectedProjectId, workspace?.id]);

  if (!workspace) {
    return (
      <div className="px-4 py-3 text-xs text-[var(--app-text-tertiary)]">
        {t("explorer.selectWorkspaceHint")}
      </div>
    );
  }

  if (workspace.projects.length === 0) {
    return (
      <div className="px-4 py-3 text-xs text-[var(--app-text-tertiary)]">
        {t("explorer.noProjects")}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-0.5">
      {workspace.projects.map((project) => {
        const expanded = overrides[project.id] ?? project.id === selectedProjectId;
        const name = project.alias || getProjectName(project.path);
        const Chevron = expanded ? ChevronDown : ChevronRight;
        return (
          <div key={project.id} className="flex flex-col">
            <button
              type="button"
              aria-expanded={expanded}
              onClick={() =>
                setOverrides((prev) => ({ ...prev, [project.id]: !expanded }))
              }
              className="flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-left hover:bg-[var(--app-hover)]"
              title={project.path}
            >
              <Chevron className="h-3 w-3 shrink-0 text-[var(--app-text-tertiary)]" />
              <span className="shrink-0 text-xs font-semibold text-[var(--app-text-primary)]">
                {name}
              </span>
              <span className="min-w-0 truncate text-[10px] text-[var(--app-text-tertiary)]">
                {project.path}
              </span>
            </button>
            {expanded && (
              <div className="pl-1">
                <FileTree rootPath={project.path} compact={false} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
