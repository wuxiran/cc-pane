// 「Skill 管理」标签根组件。
// 项目作用域两段：目录型 Agent Skills（跨 CLI）| Claude 专用 `.claude/commands` Slash 命令。
// 工作空间作用域只有 Agent Skills（工作空间没有 slash 命令这一层）。
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { SegmentedTabs } from "@/components/ui/segmented";
import type { SkillScope } from "@/types";
import ProjectSkillsPanel from "./ProjectSkillsPanel";
import SkillManager from "./SkillManager";

type View = "skills" | "commands";

interface ProjectSkillsManagerProps {
  /** 项目路径；与 workspaceName 二选一（tab 兼容字段） */
  projectPath: string;
  workspaceName?: string;
}

export default function ProjectSkillsManager({ projectPath, workspaceName }: ProjectSkillsManagerProps) {
  const { t } = useTranslation("projectSkills");
  const [view, setView] = useState<View>("skills");
  const scope: SkillScope = workspaceName && !projectPath
    ? { kind: "workspace", workspaceName }
    : { kind: "project", projectPath };

  if (scope.kind === "workspace") {
    return (
      <div className="h-full" data-testid="project-skills-manager" data-scope="workspace">
        <ProjectSkillsPanel scope={scope} />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col" data-testid="project-skills-manager" data-scope="project">
      <div className="flex shrink-0 items-center border-b border-border px-3 py-1.5">
        <SegmentedTabs<View>
          size="sm"
          value={view}
          onValueChange={setView}
          aria-label={t("title")}
          items={[
            { value: "skills", label: t("tabAgentSkills") },
            { value: "commands", label: t("tabSlashCommands") },
          ]}
        />
      </div>
      <div className="min-h-0 flex-1">
        {view === "skills" ? (
          <ProjectSkillsPanel scope={scope} />
        ) : (
          <SkillManager projectPath={projectPath} />
        )}
      </div>
    </div>
  );
}
