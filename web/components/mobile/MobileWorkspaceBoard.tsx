import { useTranslation } from "react-i18next";
import type { ReactNode } from "react";
import { ChevronRight, FolderGit2, FolderOpen, MoreHorizontal, Pin, Terminal } from "lucide-react";
import HomePinnedWorkspaces from "@/components/home/HomePinnedWorkspaces";
import { EmptyState } from "@/components/ui/EmptyState";
import type { OpenTerminalOptions, Workspace, WorkspaceProject } from "@/types";
import { getProjectName } from "@/utils/path";
import type { OpenedWorkspaceProject } from "./types";

interface MobileWorkspaceBoardProps {
  openedProject: OpenedWorkspaceProject | null;
  loading: boolean;
  connected: boolean;
  workspaces: Workspace[];
  onOpenActions: (workspace: Workspace) => void;
  onOpenProject: (workspace: Workspace, project: WorkspaceProject) => void;
}

/** 移动端工作空间列表：置顶快捷区直接复用主 UI 的 HomePinnedWorkspaces 卡片。 */
export default function MobileWorkspaceBoard({
  openedProject,
  loading,
  connected,
  workspaces,
  onOpenActions,
  onOpenProject,
}: MobileWorkspaceBoardProps) {
  const { t } = useTranslation("mobile");
  const hasPinned = workspaces.some(
    (workspace) => workspace.pinned && !workspace.hidden && !workspace.archivedAt,
  );

  // 适配层：HomePinnedWorkspaces 以 OpenTerminalOptions 回调（主 UI 签名），
  // 移动端路由层只认 (workspace, project)，这里按 name + path 回查映射。
  const handlePinnedOpenTerminal = (opts: OpenTerminalOptions) => {
    const workspace = workspaces.find((candidate) => candidate.name === opts.workspaceName);
    const project = workspace?.projects.find((candidate) => candidate.path === opts.path);
    if (workspace && project) onOpenProject(workspace, project);
  };

  return (
    <div className="space-y-3">
      {hasPinned && (
        <HomePinnedWorkspaces workspaces={workspaces} onOpenTerminal={handlePinnedOpenTerminal} />
      )}

      <div className="flex items-center justify-between">
        <h2 className="text-[15px] font-semibold text-[var(--app-text-primary)]">{t("views.workspaces")}</h2>
        <span className="text-[12px] text-[var(--app-text-tertiary)]">
          {loading ? t("status.loading") : connected ? t("status.connected") : t("status.disconnected")}
        </span>
      </div>

      {workspaces.map((workspace) => {
        const visibleProjects = workspace.projects;
        return (
          <section key={workspace.id} className="rounded-md border border-[var(--app-home-border)] bg-[var(--app-home-surface)] p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2">
                  <div className="grid h-9 w-9 flex-none place-items-center rounded-md bg-[var(--app-active-bg)] text-[var(--app-accent)]">
                    <FolderOpen className="h-4 w-4" />
                  </div>
                  <div className="min-w-0">
                    <h3 className="truncate text-[14px] font-semibold text-[var(--app-text-primary)]">{workspace.alias ?? workspace.name}</h3>
                    <p className="mt-0.5 truncate text-[12px] text-[var(--app-text-tertiary)]">{workspace.path ?? workspace.name}</p>
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {workspace.pinned && <Pill icon={<Pin className="h-3 w-3" />} label={t("workspace.pinned")} />}
                  {workspace.hidden && <Pill icon={<FolderGit2 className="h-3 w-3" />} label={t("workspace.hidden")} />}
                  <Pill icon={<FolderGit2 className="h-3 w-3" />} label={t("workspace.projectCount", { count: visibleProjects.length })} />
                </div>
              </div>
              <div className="flex flex-none items-center gap-1">
                <button
                  type="button"
                  onClick={() => onOpenActions(workspace)}
                  className="grid h-9 w-9 place-items-center rounded-md border border-[var(--app-border)] text-[var(--app-text-secondary)]"
                  aria-label={t("workspace.openActionsMenu")}
                >
                  <MoreHorizontal className="h-4 w-4" />
                </button>
              </div>
            </div>

            <div className="mt-3 space-y-2">
              {visibleProjects.map((project) => {
                const projectName = project.alias ?? getProjectName(project.path);
                const selected = openedProject?.projectPath === project.path;
                return (
                  <button
                    key={project.id}
                    type="button"
                    onClick={() => onOpenProject(workspace, project)}
                    className={`w-full rounded-md border p-2 text-left transition active:scale-[0.99] ${
                      selected
                        ? "border-[color-mix(in_srgb,var(--app-accent)_40%,transparent)] bg-[color-mix(in_srgb,var(--app-accent)_10%,transparent)]"
                        : "border-[var(--app-home-border)] bg-[var(--app-home-surface)] hover:bg-[var(--app-home-surface-hover)]"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <Terminal className="h-4 w-4 flex-none text-[var(--app-text-tertiary)]" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px] font-semibold text-[var(--app-text-primary)]">{projectName}</div>
                        <div className="mt-0.5 truncate text-[11px] text-[var(--app-text-tertiary)]">{project.path}</div>
                      </div>
                      <ChevronRight className="h-4 w-4 flex-none text-[var(--app-text-tertiary)]" />
                    </div>
                    <div className="mt-2 flex items-center justify-between gap-2 border-t border-[var(--app-home-row-border)] pt-2 text-[11px] text-[var(--app-text-tertiary)]">
                      <span className="truncate">{t("workspace.tapToOpen")}</span>
                      {project.launchProfileId && <span className="flex-none">{t("workspace.hasLaunchProfile")}</span>}
                    </div>
                  </button>
                );
              })}
            </div>
          </section>
        );
      })}

      {workspaces.length === 0 && (
        <div className="rounded-md border border-[var(--app-home-border)] bg-[var(--app-home-surface)]">
          <EmptyState icon={FolderGit2} title={t("workspace.empty")} />
        </div>
      )}
    </div>
  );
}

function Pill({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-full bg-[var(--app-hover)] px-2 py-1 text-[var(--app-text-secondary)]">
      {icon}
      <span className="truncate">{label}</span>
    </span>
  );
}
