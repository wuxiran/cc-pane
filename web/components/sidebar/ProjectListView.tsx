import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  Folder, Trash2, Plus, Pencil, Clock, Globe,
  FolderOpen, Terminal, GitBranch, Copy, Files, FileText, MonitorSmartphone,
} from "lucide-react";
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger,
  ContextMenuSeparator, ContextMenuSub, ContextMenuSubTrigger, ContextMenuSubContent,
} from "@/components/ui/context-menu";
import { useDialogStore, useSshMachinesStore } from "@/stores";
import { specService } from "@/services/specService";
import { providerService } from "@/services/providerService";
import { isTauriRuntime } from "@/services/runtime";
import {
  detectAppPlatform,
  getWorkspaceLaunchIssueKey,
  getWorkspaceLaunchIssueValues,
  getWorkspaceDefaultEnvironment,
  getProjectName,
  getWorkspaceProjectKind,
  resolveWorkspaceProjectLaunchOptions,
} from "@/utils";
import type { Workspace, WorkspaceProject, OpenTerminalOptions, SpecEntry, SshConnectionInfo, WorkspaceLaunchEnvironment } from "@/types";
import {
  buildSidebarCliLaunchItems,
  getDefaultSidebarFavoriteLaunchActionIds,
  groupSidebarCliLaunchItems,
} from "./launchMenu";
import { useSettingsStore } from "@/stores/useSettingsStore";

interface ProjectListViewProps {
  projects: WorkspaceProject[];
  ws: Workspace;
  gitBranches: Record<string, string | null>;
  onOpenTerminal: (opts: OpenTerminalOptions) => void;
  onRemoveProject: (ws: Workspace, project: WorkspaceProject) => void;
  onSetProjectAlias: (ws: Workspace, project: WorkspaceProject) => void;
  onImportProject: (ws: Workspace) => void;
  onMigrateProject: (ws: Workspace, project: WorkspaceProject) => void;
  onOpenWorktreeManager: (project: WorkspaceProject, ws: Workspace) => void;
  onOpenInFileBrowser?: (path: string) => void;
}

function isRenderableWorkspaceProject(project: unknown): project is WorkspaceProject {
  return typeof project === "object"
    && project !== null
    && typeof (project as WorkspaceProject).id === "string"
    && typeof (project as WorkspaceProject).path === "string"
    && (project as WorkspaceProject).path.trim() !== "";
}

function normalizeProjects(projects: WorkspaceProject[]): WorkspaceProject[] {
  if (!Array.isArray(projects)) return [];
  const renderableProjects = projects.filter(isRenderableWorkspaceProject);
  return renderableProjects.length === projects.length ? projects : renderableProjects;
}

function getSshDisplayName(ssh: SshConnectionInfo): string {
  const host = ssh.user ? `${ssh.user}@${ssh.host}` : ssh.host;
  return `${host}:${ssh.remotePath}`;
}

function getRelativePath(projectPath: string, wsPath?: string | null): string {
  const normalize = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  if (wsPath) {
    const normBase = normalize(wsPath);
    const normFull = normalize(projectPath);
    if (normFull.startsWith(normBase + "/")) {
      return normFull.slice(normBase.length + 1);
    }
  }
  const parts = projectPath.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.pop() || projectPath;
}

const PROJECT_BADGE_BASE = "text-[9px] px-1.5 py-0.5 rounded-full font-medium border";

// 身份色徽章（local 中性 / wsl / ssh），亮暗随 token 自动切换
function projectBadgeClassName(kind: "local" | "wsl" | "ssh"): string {
  switch (kind) {
    case "local":
      return `${PROJECT_BADGE_BASE} bg-[color-mix(in_srgb,var(--app-text-primary)_8%,transparent)] text-[var(--app-text-secondary)] border-[var(--app-border)]`;
    case "wsl":
      return `${PROJECT_BADGE_BASE} bg-[color-mix(in_srgb,var(--app-identity-wsl)_14%,transparent)] text-[var(--app-identity-wsl)] border-[color-mix(in_srgb,var(--app-identity-wsl)_30%,transparent)]`;
    case "ssh":
      return `${PROJECT_BADGE_BASE} bg-[color-mix(in_srgb,var(--app-identity-ssh)_14%,transparent)] text-[var(--app-identity-ssh)] border-[color-mix(in_srgb,var(--app-identity-ssh)_30%,transparent)]`;
  }
}


export default function ProjectListView({
  projects, ws, gitBranches,
  onOpenTerminal, onRemoveProject, onSetProjectAlias,
  onImportProject, onMigrateProject, onOpenWorktreeManager, onOpenInFileBrowser,
}: ProjectListViewProps) {
  const { t } = useTranslation(["sidebar", "common", "spec"]);
  const sshMachines = useSshMachinesStore((s) => s.machines);
  const rawFavoriteLaunchIds = useSettingsStore((s) => s.settings?.general.launchFavorites);
  const onOpenHistory = useDialogStore((s) => s.openLocalHistory);
  const onOpenTodo = useDialogStore((s) => s.openTodo);
  const [projectSpecs, setProjectSpecs] = useState<Record<string, SpecEntry[]>>({});
  const isWindows = detectAppPlatform() === "windows";
  const safeProjects = normalizeProjects(projects);
  const invalidProjectCount = Array.isArray(projects)
    ? projects.length - safeProjects.length
    : 0;
  const workspace = safeProjects === projects ? ws : { ...ws, projects: safeProjects };
  const defaultEnvironment = getWorkspaceDefaultEnvironment(workspace);

  const handleLoadSpecs = useCallback(async (projectPath: string) => {
    try {
      const specs = await specService.list(projectPath);
      setProjectSpecs((prev) => ({ ...prev, [projectPath]: specs }));
    } catch {
      setProjectSpecs((prev) => ({ ...prev, [projectPath]: [] }));
    }
  }, []);

  const handleNewSpec = useCallback(async (projectPath: string) => {
    const title = window.prompt(t("specTitlePlaceholder", { ns: "spec" }));
    if (!title?.trim()) return;
    try {
      await specService.create({ projectPath, title: title.trim() });
      toast.success(t("specCreated", { ns: "spec" }));
      // 打开关联的 Todo（在 Todo 面板中显示）
      onOpenTodo("project", projectPath);
    } catch (e) {
      toast.error(String(e));
    }
  }, [t, onOpenTodo]);

  const handleOpenSpec = useCallback(async (projectPath: string, spec: SpecEntry) => {
    try {
      const specPath = `${projectPath}/.ccpanes/specs/${spec.fileName}`;
      if (!isTauriRuntime()) {
        await navigator.clipboard.writeText(specPath);
        toast.info(t("copiedToClipboard"));
        return;
      }
      await providerService.openPathInExplorer(specPath);
    } catch (e) {
      toast.error(String(e));
    }
  }, [t]);

  const handleRevealFolder = useCallback(async (path: string) => {
    if (!isTauriRuntime()) {
      await navigator.clipboard.writeText(path).catch(() => {});
      toast.info(t("copiedToClipboard"));
      return;
    }
    try {
      await providerService.openPathInExplorer(path);
    } catch (e) {
      toast.error(t("openFolderFailed", { error: e }));
    }
  }, [t]);

  const handleCopyPath = useCallback(async (path: string) => {
    try {
      await navigator.clipboard.writeText(path);
      toast.success(t("copiedToClipboard"));
    } catch (e) {
      toast.error(t("copyFailed", { error: e }));
    }
  }, [t]);

  const formatLaunchIssue = useCallback((
    issue: NonNullable<ReturnType<typeof resolveWorkspaceProjectLaunchOptions>["issue"]>,
  ) => {
    return t(getWorkspaceLaunchIssueKey(issue), {
      ...getWorkspaceLaunchIssueValues(issue),
      defaultValue: {
        local_path_missing: "Local launch requires a workspace path or a local project.",
        wsl_unsupported: "WSL is only available on Windows.",
        wsl_path_missing: "WSL launch requires a remote path.",
        wsl_local_path_missing: "WSL launch requires a local anchor path or a WSL project.",
        ssh_machine_missing: "SSH launch requires a selected machine.",
        ssh_machine_not_found: "The saved SSH machine could not be found: {{machineId}}",
        ssh_path_missing: "SSH launch requires a remote path.",
      }[issue.code],
    });
  }, [t]);

  return (
    <div className="flex flex-col gap-1 px-3 pb-3 pt-2">
      {invalidProjectCount > 0 ? (
        <div className="rounded-lg border border-[var(--app-status-warning-border)] bg-[var(--app-status-warning-bg)] px-3 py-2 text-[11px] text-[var(--app-status-warning)]">
          {t("invalidProjectsSkipped", {
            count: invalidProjectCount,
            defaultValue: `已隐藏 ${invalidProjectCount} 个异常项目`,
          })}
        </div>
      ) : null}
      {safeProjects.map((project) => {
        const isSsh = !!project.ssh;
        const projectKind = getWorkspaceProjectKind(project);
        const canLaunchWsl = isWindows
          && !resolveWorkspaceProjectLaunchOptions({
            workspace,
            project,
            machines: sshMachines,
            environment: "wsl",
          }).issue;
        const canLaunchSsh = !resolveWorkspaceProjectLaunchOptions({
          workspace,
          project,
          machines: sshMachines,
          environment: "ssh",
        }).issue;
        const cliLaunchItems = buildSidebarCliLaunchItems(t, canLaunchWsl, canLaunchSsh);
        // 常用项平铺，其余折叠进"更多启动方式"（issue #36：避免 20+ 项平铺）
        const groupedCliLaunchItems = groupSidebarCliLaunchItems(
          cliLaunchItems,
          rawFavoriteLaunchIds ?? getDefaultSidebarFavoriteLaunchActionIds(),
        );
        const displayName = project.alias || (isSsh ? getSshDisplayName(project.ssh!) : getProjectName(project.path));
        const launchProject = (
          cliTool?: OpenTerminalOptions["cliTool"],
          environment?: WorkspaceLaunchEnvironment,
        ) => {
          const { options, issue } = resolveWorkspaceProjectLaunchOptions({
            workspace,
            project,
            cliTool,
            environment,
            machines: sshMachines,
          });
          if (!options || issue) {
            toast.error(
              formatLaunchIssue(issue ?? {
                environment: environment ?? defaultEnvironment,
                code: "local_path_missing",
              }),
            );
            return;
          }
          onOpenTerminal(options);
        };
        return (
        <div key={project.id}>
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <div
                className="rounded-xl border border-transparent px-3 py-2 transition-colors duration-[var(--dur-fast)] text-[var(--app-text-secondary)] hover:border-[var(--app-border)] hover:bg-[var(--app-hover)] hover:text-[var(--app-text-primary)]"
              >
                <div
                  className="flex cursor-pointer items-center gap-2"
                  onDoubleClick={() => isSsh ? launchProject() : onOpenInFileBrowser?.(project.path)}
                >
                  {isSsh
                    ? <Globe size={14} className="shrink-0" style={{ color: "var(--app-accent)" }} />
                    : <Folder size={14} className="shrink-0" style={{ color: "var(--app-accent)" }} />
                  }
                  <span className="flex-1 text-xs truncate">{displayName}</span>
                  {!isSsh && gitBranches[project.path] && (
                    <span className="text-[10px] px-1 rounded shrink-0" style={{ color: "var(--app-accent)", background: "var(--app-active-bg)" }}>
                      {gitBranches[project.path]}
                    </span>
                  )}
                  <span className={projectBadgeClassName(projectKind)}>
                    {projectKind.toUpperCase()}
                  </span>
                </div>
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent className="w-56">
              <ContextMenuItem onClick={() => launchProject()}>
                <Terminal /> {t("openTerminal")}
              </ContextMenuItem>
              <ContextMenuSub>
                <ContextMenuSubTrigger>
                  <Terminal /> {t("workspaceEnv.launchThisTime", { defaultValue: "本次选择环境" })}
                </ContextMenuSubTrigger>
                <ContextMenuSubContent className="w-48">
                  <ContextMenuItem onClick={() => launchProject(undefined, "local")}>
                    <Terminal /> {t("workspaceEnv.local", { defaultValue: "本机" })}
                  </ContextMenuItem>
                  <ContextMenuItem onClick={() => launchProject(undefined, "wsl")}>
                    <Terminal /> {t("workspaceEnv.wsl", { defaultValue: "WSL" })}
                  </ContextMenuItem>
                  <ContextMenuItem onClick={() => launchProject(undefined, "ssh")}>
                    <Terminal /> {t("workspaceEnv.ssh", { defaultValue: "SSH" })}
                  </ContextMenuItem>
                </ContextMenuSubContent>
              </ContextMenuSub>
              {groupedCliLaunchItems.primary.map((item) => (
                <ContextMenuItem
                  key={item.key}
                  onClick={() => launchProject(item.cliTool, item.environment)}
                >
                  <Terminal /> {item.label}
                </ContextMenuItem>
              ))}
              {groupedCliLaunchItems.more.length > 0 && (
                <ContextMenuSub>
                  <ContextMenuSubTrigger>
                    <Terminal /> {t("moreLaunchActions", { defaultValue: "更多启动方式" })}
                  </ContextMenuSubTrigger>
                  <ContextMenuSubContent className="w-56">
                    {groupedCliLaunchItems.more.map((item) => (
                      <ContextMenuItem
                        key={item.key}
                        onClick={() => launchProject(item.cliTool, item.environment)}
                      >
                        <Terminal /> {item.label}
                      </ContextMenuItem>
                    ))}
                  </ContextMenuSubContent>
                </ContextMenuSub>
              )}
              <ContextMenuSeparator />
              {/* 本地项目专有菜单项 */}
              {!isSsh && (
                <>
                  <ContextMenuItem onClick={() => handleRevealFolder(project.path)}>
                    <FolderOpen /> {t("openFolder")}
                  </ContextMenuItem>
                  {onOpenInFileBrowser && (
                    <ContextMenuItem onClick={() => onOpenInFileBrowser(project.path)}>
                      <Files /> {t("openInFileBrowser")}
                    </ContextMenuItem>
                  )}
                  <ContextMenuSub>
                    <ContextMenuSubTrigger>
                      <Copy /> {t("copyPath")}
                    </ContextMenuSubTrigger>
                    <ContextMenuSubContent>
                      <ContextMenuItem onClick={() => handleCopyPath(project.path)}>
                        {t("absolutePath")}
                      </ContextMenuItem>
                      <ContextMenuItem onClick={() => handleCopyPath(getRelativePath(project.path, workspace.path))}>
                        {t("relativePath")}
                      </ContextMenuItem>
                    </ContextMenuSubContent>
                  </ContextMenuSub>
                  <ContextMenuSeparator />
                  <ContextMenuItem onClick={() => onOpenHistory(project.path)}>
                    <Clock /> {t("fileHistory")}
                  </ContextMenuItem>
                  <ContextMenuItem onClick={() => onOpenWorktreeManager(project, workspace)}>
                    <GitBranch /> {t("worktreeManager")}
                  </ContextMenuItem>
                  {isWindows && (
                    <ContextMenuItem onClick={() => onMigrateProject(workspace, project)}>
                      <MonitorSmartphone /> Migrate To WSL
                    </ContextMenuItem>
                  )}
                  <ContextMenuSeparator />
                  {/* Spec */}
                  <ContextMenuItem onClick={() => handleNewSpec(project.path)}>
                    <FileText /> {t("newSpec")}
                  </ContextMenuItem>
                  <ContextMenuSub>
                    <ContextMenuSubTrigger onPointerEnter={() => handleLoadSpecs(project.path)}>
                      <FileText /> {t("viewSpecs")}
                    </ContextMenuSubTrigger>
                    <ContextMenuSubContent className="w-52">
                      {(projectSpecs[project.path] || []).length === 0 ? (
                        <ContextMenuItem disabled>{t("noSpecs")}</ContextMenuItem>
                      ) : (
                        (projectSpecs[project.path] || []).map((spec) => (
                          <ContextMenuItem key={spec.id} onClick={() => handleOpenSpec(project.path, spec)}>
                            <span className="flex-1 truncate">{spec.title}</span>
                            <span className={`text-[9px] ml-2 px-1 py-0.5 rounded ${
                              spec.status === "active"
                                ? "bg-[var(--app-status-success-bg)] text-[var(--app-status-success)]"
                                : spec.status === "archived"
                                ? "bg-[var(--app-hover)] text-[var(--app-text-tertiary)]"
                                : "bg-[color-mix(in_srgb,var(--app-accent)_12%,transparent)] text-[var(--app-accent)]"
                            }`}>
                              {spec.status}
                            </span>
                          </ContextMenuItem>
                        ))
                      )}
                    </ContextMenuSubContent>
                  </ContextMenuSub>
                  <ContextMenuSeparator />
                </>
              )}
              <ContextMenuItem onClick={() => onSetProjectAlias(workspace, project)}>
                <Pencil /> {t("setAlias")}
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem variant="destructive" onClick={() => onRemoveProject(workspace, project)}>
                <Trash2 /> {t("removeProject")}
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        </div>
        );
      })}

      {/* 导入项目按钮 */}
      <div
        className="flex items-center justify-center gap-1 p-1.5 mt-1 text-[11px] rounded-lg cursor-pointer transition-colors duration-[var(--dur-fast)] border border-dashed group border-[var(--app-border)] text-[var(--app-text-tertiary)] hover:border-[var(--app-accent)] hover:text-[var(--app-accent)] hover:bg-[var(--app-active-bg)]"
        onClick={() => onImportProject(workspace)}
      >
        <Plus size={12} className="transition-transform group-hover:rotate-90" />
        <span>{t("importProject")}</span>
      </div>
    </div>
  );
}
