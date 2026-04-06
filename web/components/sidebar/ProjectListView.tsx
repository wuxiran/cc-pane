import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { openPath } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";
import {
  Folder, Trash2, Plus, Pencil, Clock, Globe,
  FolderOpen, Terminal, GitBranch, Copy, Files, FileText, MonitorSmartphone,
} from "lucide-react";
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger,
  ContextMenuSeparator, ContextMenuSub, ContextMenuSubTrigger, ContextMenuSubContent,
} from "@/components/ui/context-menu";
import { useProvidersStore, useDialogStore, useSshMachinesStore } from "@/stores";
import { specService } from "@/services/specService";
import { useCliTools } from "@/hooks/useCliTools";
import {
  detectAppPlatform,
  getWorkspaceLaunchIssueKey,
  getWorkspaceLaunchIssueValues,
  getWorkspaceDefaultEnvironment,
  getProjectName,
  getWorkspaceProjectKind,
  resolveWorkspaceProjectLaunchOptions,
} from "@/utils";
import type { Workspace, WorkspaceProject, OpenTerminalOptions, SpecEntry, SshConnectionInfo } from "@/types";
import { getCompatibleCliTool } from "@/types/provider";

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

function projectBadgeClassName(kind: "local" | "wsl" | "ssh"): string {
  switch (kind) {
    case "local":
      return "text-[9px] px-1.5 py-0.5 rounded-full font-medium bg-slate-100 text-slate-700 border border-slate-200 dark:bg-slate-500/20 dark:text-slate-300 dark:border-slate-500/30";
    case "wsl":
      return "text-[9px] px-1.5 py-0.5 rounded-full font-medium bg-amber-100 text-amber-700 border border-amber-200 dark:bg-amber-500/20 dark:text-amber-300 dark:border-amber-500/30";
    case "ssh":
      return "text-[9px] px-1.5 py-0.5 rounded-full font-medium bg-cyan-100 text-cyan-700 border border-cyan-200 dark:bg-cyan-500/20 dark:text-cyan-300 dark:border-cyan-500/30";
  }
}


export default function ProjectListView({
  projects, ws, gitBranches,
  onOpenTerminal, onRemoveProject, onSetProjectAlias,
  onImportProject, onMigrateProject, onOpenWorktreeManager, onOpenInFileBrowser,
}: ProjectListViewProps) {
  const { t } = useTranslation(["sidebar", "common", "spec"]);
  const providerList = useProvidersStore((s) => s.providers);
  const sshMachines = useSshMachinesStore((s) => s.machines);
  const { tools: cliTools } = useCliTools();
  const onOpenHistory = useDialogStore((s) => s.openLocalHistory);
  const onOpenTodo = useDialogStore((s) => s.openTodo);
  const [projectSpecs, setProjectSpecs] = useState<Record<string, SpecEntry[]>>({});
  const isWindows = detectAppPlatform() === "windows";
  const defaultEnvironment = getWorkspaceDefaultEnvironment(ws);

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
      await openPath(specPath);
    } catch (e) {
      toast.error(String(e));
    }
  }, []);

  const handleRevealFolder = useCallback(async (path: string) => {
    try {
      await openPath(path);
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
    <div className="pl-4 pr-1 pb-2 flex flex-col gap-0.5">
      {projects.map((project) => {
        const isSsh = !!project.ssh;
        const projectKind = getWorkspaceProjectKind(project);
        const displayName = project.alias || (isSsh ? getSshDisplayName(project.ssh!) : getProjectName(project.path));
        const launchProject = (
          cliTool?: OpenTerminalOptions["cliTool"],
          providerId?: string,
          environment?: typeof defaultEnvironment,
        ) => {
          const { options, issue } = resolveWorkspaceProjectLaunchOptions({
            workspace: ws,
            project,
            cliTool,
            providerId,
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
                className="flex items-center gap-1.5 px-2 py-1.5 cursor-pointer rounded-lg transition-all text-[var(--app-text-secondary)] hover:bg-[var(--app-hover)] hover:text-[var(--app-text-primary)]"
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
            </ContextMenuTrigger>
            <ContextMenuContent className="w-48">
              <ContextMenuItem onClick={() => launchProject()}>
                <Terminal /> {t("openTerminal")}
              </ContextMenuItem>
              {/* CLI 工具（动态渲染） */}
              {cliTools.map((tool) => {
                const compatibleProviders = providerList.filter(
                  (provider) => getCompatibleCliTool(provider.providerType) === tool.id,
                );

                return tool.id !== "codex" && compatibleProviders.length > 0 ? (
                  <ContextMenuSub key={tool.id}>
                    <ContextMenuSubTrigger>
                      <Terminal /> {tool.displayName}
                    </ContextMenuSubTrigger>
                    <ContextMenuSubContent className="w-48">
                      <ContextMenuItem onClick={() => launchProject(tool.id)}>
                        {`（${t("default", { ns: "common", defaultValue: "默认" })}）`}
                      </ContextMenuItem>
                      {compatibleProviders.length > 0 && <ContextMenuSeparator />}
                      {compatibleProviders.map((p) => (
                        <ContextMenuItem
                          key={p.id}
                          onClick={() => launchProject(tool.id, p.id)}
                        >
                          {p.name}
                        </ContextMenuItem>
                      ))}
                    </ContextMenuSubContent>
                  </ContextMenuSub>
                ) : (
                  <ContextMenuItem key={tool.id} onClick={() => launchProject(tool.id)}>
                    <Terminal /> {tool.displayName}
                  </ContextMenuItem>
                );
              })}
              {/* 本地项目专有菜单项 */}
              {!isSsh && (
                <>
                  <ContextMenuItem onClick={() => handleRevealFolder(project.path)}>
                    <FolderOpen /> {t("openFolder")}
                  </ContextMenuItem>
                  <ContextMenuSub>
                    <ContextMenuSubTrigger>
                      <Copy /> {t("copyPath")}
                    </ContextMenuSubTrigger>
                    <ContextMenuSubContent>
                      <ContextMenuItem onClick={() => handleCopyPath(project.path)}>
                        {t("absolutePath")}
                      </ContextMenuItem>
                      <ContextMenuItem onClick={() => handleCopyPath(getRelativePath(project.path, ws.path))}>
                        {t("relativePath")}
                      </ContextMenuItem>
                    </ContextMenuSubContent>
                  </ContextMenuSub>
                  <ContextMenuSeparator />
                  <ContextMenuItem onClick={() => onOpenHistory(project.path)}>
                    <Clock /> {t("fileHistory")}
                  </ContextMenuItem>
                  <ContextMenuItem onClick={() => onOpenWorktreeManager(project, ws)}>
                    <GitBranch /> {t("worktreeManager")}
                  </ContextMenuItem>
                  {isWindows && (
                    <ContextMenuItem onClick={() => onMigrateProject(ws, project)}>
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
                                ? "bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-300"
                                : spec.status === "archived"
                                ? "bg-gray-100 text-gray-500 dark:bg-gray-500/20 dark:text-gray-400"
                                : "bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-300"
                            }`}>
                              {spec.status}
                            </span>
                          </ContextMenuItem>
                        ))
                      )}
                    </ContextMenuSubContent>
                  </ContextMenuSub>
                </>
              )}
              <ContextMenuSeparator />
              <ContextMenuItem onClick={() => onSetProjectAlias(ws, project)}>
                <Pencil /> {t("setAlias")}
              </ContextMenuItem>
              <ContextMenuItem variant="destructive" onClick={() => onRemoveProject(ws, project)}>
                <Trash2 /> {t("removeProject")}
              </ContextMenuItem>
              {!isSsh && onOpenInFileBrowser && (
                <>
                  <ContextMenuSeparator />
                  <ContextMenuItem onClick={() => onOpenInFileBrowser(project.path)}>
                    <Files /> {t("openInFileBrowser")}
                  </ContextMenuItem>
                </>
              )}
            </ContextMenuContent>
          </ContextMenu>
        </div>
        );
      })}

      {/* 导入项目按钮 */}
      <div
        className="flex items-center justify-center gap-1 p-1.5 mt-1 text-[11px] rounded-lg cursor-pointer transition-all border border-dashed group border-[var(--app-border)] text-[var(--app-text-tertiary)] hover:border-[var(--app-accent)] hover:text-[var(--app-accent)] hover:bg-[var(--app-active-bg)]"
        onClick={() => onImportProject(ws)}
      >
        <Plus size={12} className="transition-transform group-hover:rotate-90" />
        <span>{t("importProject")}</span>
      </div>
    </div>
  );
}
