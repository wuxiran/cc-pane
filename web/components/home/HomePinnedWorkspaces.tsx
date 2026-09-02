import { useMemo } from "react";
import { ArrowRight, FolderKanban, Pin } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { OpenTerminalOptions, Workspace } from "@/types";

interface HomePinnedWorkspacesProps {
  workspaces: Workspace[];
  onOpenTerminal: (options: OpenTerminalOptions) => void;
}

/** 熟手态的低噪入口：只展示用户明确置顶且仍可用的工作空间。 */
export default function HomePinnedWorkspaces({ workspaces, onOpenTerminal }: HomePinnedWorkspacesProps) {
  const { t } = useTranslation("home");
  const pinned = useMemo(
    () => workspaces.filter((workspace) => workspace.pinned && !workspace.hidden && !workspace.archivedAt).slice(0, 6),
    [workspaces],
  );

  return (
    <section data-testid="pinned-workspaces" className="min-w-0">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold" style={{ color: "var(--app-text-primary)" }}>
          {t("pinnedWorkspaces")}
        </h3>
        <Pin aria-hidden="true" className="size-3.5 shrink-0 text-[var(--app-text-tertiary)]" />
      </div>
      <div className="overflow-hidden rounded-xl border border-[var(--app-home-border)] bg-[var(--app-home-surface)]">
        {pinned.length === 0 ? (
          <div className="flex min-h-24 items-center justify-center px-4 py-5 text-center text-xs text-[var(--app-text-tertiary)]">
            {t("noPinnedWorkspaces")}
          </div>
        ) : (
          <div className="divide-y divide-[var(--app-home-row-border)]">
            {pinned.map((workspace) => {
              const project = workspace.projects.find((candidate) => !candidate.archivedAt);
              const disabled = !project;
              return (
                <button
                  key={workspace.id}
                  type="button"
                  disabled={disabled}
                  className="group flex min-h-12 w-full items-center gap-3 px-3 py-2.5 text-left transition-colors duration-[var(--dur-fast)] hover:bg-[var(--app-home-surface-hover)] disabled:cursor-not-allowed disabled:opacity-50"
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
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-[var(--app-active-bg)] text-[var(--app-accent)]">
                    <FolderKanban aria-hidden="true" className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium text-[var(--app-text-primary)]">
                      {workspace.alias || workspace.name}
                    </span>
                    <span className="block truncate text-[11px] text-[var(--app-text-tertiary)]">
                      {project?.alias || project?.path || t("workspaceNoProjects")}
                    </span>
                  </span>
                  <ArrowRight aria-hidden="true" className="size-3.5 shrink-0 text-[var(--app-text-tertiary)] transition-transform duration-[var(--dur-fast)] group-hover:translate-x-0.5 group-hover:text-[var(--app-accent)]" />
                </button>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

