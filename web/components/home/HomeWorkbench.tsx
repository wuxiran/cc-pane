// 首页「继续工作」：右侧栏，上面是按工作空间分组的活跃会话，下面是置顶工作空间 + 最近项目。
import { useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Pin } from "lucide-react";
import type { OpenTerminalOptions, Workspace } from "@/types";
import HomeActiveSessions from "./HomeActiveSessions";

interface HomeWorkbenchProps {
  workspaces: readonly Workspace[];
  /** 最近项目栏（加载中时是骨架）。 */
  recent: ReactNode;
  onOpenTerminal: (opts: OpenTerminalOptions) => void;
}

function PinnedChips({ workspaces, onOpenTerminal }: Pick<HomeWorkbenchProps, "workspaces" | "onOpenTerminal">) {
  const { t } = useTranslation("home");
  const pinned = useMemo(
    () => workspaces.filter((workspace) => workspace.pinned && !workspace.hidden && !workspace.archivedAt).slice(0, 6),
    [workspaces],
  );
  if (pinned.length === 0) return null;
  return (
    <div data-testid="pinned-workspaces" className="mb-3 flex flex-wrap items-center gap-1.5 px-2">
      <span className="mr-1 flex items-center gap-1 text-[length:var(--text-small)] text-[var(--app-text-tertiary)]">
        <Pin className="size-3" aria-hidden="true" />
        {t("workbench.pinned")}
      </span>
      {pinned.map((workspace) => {
        const project = workspace.projects.find((candidate) => !candidate.archivedAt);
        return (
          <button
            key={workspace.id}
            type="button"
            disabled={!project}
            title={project?.path ?? t("workspaceNoProjects")}
            className="h-7 max-w-44 truncate rounded-full border border-[var(--app-border)] px-3 text-[length:var(--text-small)] text-[var(--app-text-primary)] transition-colors duration-[var(--dur-fast)] hover:border-[var(--app-home-border-hover)] hover:bg-[var(--app-home-surface-hover)] disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => {
              if (!project) return;
              onOpenTerminal({
                path: project.path,
                workspaceName: workspace.name,
                workspacePath: workspace.path,
                launchProfileId: project.launchProfileId ?? workspace.launchProfileId,
                ssh: project.ssh,
                wsl: project.wslRemotePath
                  ? { remotePath: project.wslRemotePath, distro: workspace.wsl?.distro }
                  : undefined,
              });
            }}
          >
            {workspace.alias || workspace.name}
          </button>
        );
      })}
    </div>
  );
}

export default function HomeWorkbench({ workspaces, recent, onOpenTerminal }: HomeWorkbenchProps) {
  const { t } = useTranslation("home");
  return (
    <section data-testid="home-workbench" aria-label={t("workbench.title")}>
      <h2 className="mb-3 px-1 text-[length:var(--text-title)] font-semibold text-[var(--app-text-primary)]">{t("workbench.title")}</h2>
      <div className="space-y-3">
        <div className="min-w-0 rounded-2xl border border-[var(--app-home-border)] bg-[var(--app-home-surface)] p-3">
          <HomeActiveSessions />
        </div>
        <div className="min-w-0 rounded-2xl border border-[var(--app-home-border)] bg-[var(--app-home-surface)] p-3">
          <PinnedChips workspaces={workspaces} onOpenTerminal={onOpenTerminal} />
          {recent}
        </div>
      </div>
    </section>
  );
}
