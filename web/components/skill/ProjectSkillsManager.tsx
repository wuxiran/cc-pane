// 项目「Skill 管理」标签根组件：两段——目录型 Agent Skills（跨 CLI）与
// Claude 专用的 `.claude/commands` Slash 命令（沿用原 SkillManager）。
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { SegmentedTabs } from "@/components/ui/segmented";
import ProjectSkillsPanel from "./ProjectSkillsPanel";
import SkillManager from "./SkillManager";

type View = "skills" | "commands";

interface ProjectSkillsManagerProps {
  projectPath: string;
}

export default function ProjectSkillsManager({ projectPath }: ProjectSkillsManagerProps) {
  const { t } = useTranslation("projectSkills");
  const [view, setView] = useState<View>("skills");

  return (
    <div className="flex h-full flex-col" data-testid="project-skills-manager">
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
          <ProjectSkillsPanel projectPath={projectPath} />
        ) : (
          <SkillManager projectPath={projectPath} />
        )}
      </div>
    </div>
  );
}
