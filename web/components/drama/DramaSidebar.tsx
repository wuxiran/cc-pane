// 短剧制作台左栏：项目列表 + 选中项目的分集列表（从 DramaStudio 拆出，行数棘轮）。
import { Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import type { DramaEpisode, DramaProject } from "@/types/drama";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export interface DramaSidebarProps {
  projects: DramaProject[];
  selectedDramaId: string | null;
  onSelectProject: (id: string) => void;
  onCreateProject: () => void;
  episodes: DramaEpisode[];
  selectedEpisodeId: string | null;
  onSelectEpisode: (id: string) => void;
  onCreateEpisode: () => void;
}

const ROW_CLASS = "mx-2 mb-1 rounded px-2 py-1.5 text-left text-xs transition-colors hover:bg-[var(--app-hover)]";

export default function DramaSidebar({
  projects, selectedDramaId, onSelectProject, onCreateProject,
  episodes, selectedEpisodeId, onSelectEpisode, onCreateEpisode,
}: DramaSidebarProps) {
  const { t } = useTranslation("drama");
  return (
    <aside className="flex w-64 shrink-0 flex-col overflow-y-auto border-r border-[var(--app-border)]" style={{ background: "var(--app-sidebar-bg)" }}>
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-[length:var(--text-caption)] font-semibold" style={{ color: "var(--app-text-secondary)" }}>{t("dramaProjects")}</span>
        <Tooltip><TooltipTrigger asChild><Button type="button" variant="ghost" size="icon-sm" aria-label={t("dramaNewProject")} onClick={onCreateProject}>
          <Plus aria-hidden="true" />
        </Button></TooltipTrigger><TooltipContent>{t("dramaNewProject")}</TooltipContent></Tooltip>
      </div>
      {projects.map((project) => (
        <button
          key={project.id}
          type="button"
          className={ROW_CLASS}
          style={{ background: project.id === selectedDramaId ? "var(--app-hover)" : undefined, color: "var(--app-text-primary)" }}
          onClick={() => onSelectProject(project.id)}
        >
          <span className="block truncate font-medium">{project.title}</span>
        </button>
      ))}
      {selectedDramaId ? (
        <>
          <div className="mt-2 flex items-center justify-between border-t border-[var(--app-border)] px-3 py-2">
            <span className="text-[length:var(--text-caption)] font-semibold" style={{ color: "var(--app-text-secondary)" }}>{t("dramaEpisodes")}</span>
            <Tooltip><TooltipTrigger asChild><Button type="button" variant="ghost" size="icon-sm" aria-label={t("dramaNewEpisode")} onClick={onCreateEpisode}>
              <Plus aria-hidden="true" />
            </Button></TooltipTrigger><TooltipContent>{t("dramaNewEpisode")}</TooltipContent></Tooltip>
          </div>
          {episodes.map((episode) => (
            <button
              key={episode.id}
              type="button"
              className={ROW_CLASS}
              style={{ background: episode.id === selectedEpisodeId ? "var(--app-hover)" : undefined, color: "var(--app-text-primary)" }}
              onClick={() => onSelectEpisode(episode.id)}
            >
              <span className="block truncate">{t("dramaEpisodeLabel", { number: episode.ordinal + 1 })} · {episode.title}</span>
            </button>
          ))}
        </>
      ) : null}
    </aside>
  );
}
