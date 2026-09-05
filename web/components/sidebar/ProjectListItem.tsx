import { useCallback, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  Folder, FolderX, Trash2, Pencil, Clock, Globe,
  FolderOpen, Terminal, GitBranch, Copy, Files, FileText, MonitorSmartphone,
} from "lucide-react";
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger,
  ContextMenuSeparator, ContextMenuSub, ContextMenuSubTrigger, ContextMenuSubContent,
} from "@/components/ui/context-menu";
import AgentChatMenuItem from "./AgentChatMenuItem";
import ArchiveMenuItem from "./ArchiveMenuItem";
import { useDialogStore, useSshMachinesStore, useWorkspacesStore } from "@/stores";
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
import type {
  Workspace, WorkspaceProject, OpenTerminalOptions, SpecEntry, SshConnectionInfo,
  WorkspaceLaunchEnvironment, PathStatusKind,
} from "@/types";
import {
  buildSidebarCliLaunchItems,
  getDefaultSidebarFavoriteLaunchActionIds,
  groupSidebarCliLaunchItems,
} from "./launchMenu";
import { useSettingsStore } from "@/stores/useSettingsStore";

export interface ProjectListItemProps {
  project: WorkspaceProject;
  workspace: Workspace;
  gitBranch?: string | null;
  /** 路径存在性判定；`missing` 时降级展示并裁剪必然失败的菜单项 */
  pathStatus?: PathStatusKind;
  /** worktree 子节点的分支名，比 gitBranches 缓存更准 */
  worktreeBranch?: string;
  /** 分组父行的展开箭头等前置元素 */
  leading?: ReactNode;
  /** 父行的计数徽章等后置元素 */
  trailing?: ReactNode;
  /** 已安装或显式配置的 CLI；undefined 表示环境探测尚未完成。 */
  availableCliToolIds?: ReadonlySet<string>;
  onOpenTerminal: (opts: OpenTerminalOptions) => void;
  onRemoveProject: (ws: Workspace, project: WorkspaceProject) => void;
  onSetProjectAlias: (ws: Workspace, project: WorkspaceProject) => void;
  onMigrateProject: (ws: Workspace, project: WorkspaceProject) => void;
  onOpenWorktreeManager: (project: WorkspaceProject, ws: Workspace) => void;
  onOpenInFileBrowser?: (path: string) => void;
}

function getSshDisplayName(ssh: SshConnectionInfo): string {
  const host = ssh.user ? `${ssh.user}@${ssh.host}` : ssh.host;
  return `${host}:${ssh.remotePath}`;
}

export function getRelativePath(projectPath: string, wsPath?: string | null): string {
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

// 形状与 sidebarEntityBadgeClass 对齐（10px / rounded-full），侧栏三套徽章统一。
// shrink 语义单独挂在 BASE 上：分支徽章需要 shrink，而 flex-shrink 的胜负由生成的
// 样式表顺序决定、不看 class 串顺序，这里又是纯字符串拼接（不过 tailwind-merge），
// 所以只能拆开写，不能靠后缀覆盖。
const PROJECT_BADGE_SHAPE =
  "rounded-full px-1.5 py-0.5 text-[10px] font-medium leading-none border";
const PROJECT_BADGE_BASE = `shrink-0 ${PROJECT_BADGE_SHAPE}`;

// 分支徽章是行内唯一可收缩项：宽度不够时它先截断，把空间让给项目名。
const BRANCH_BADGE_CLASS = `min-w-0 shrink truncate ${PROJECT_BADGE_SHAPE} `
  + "bg-[color-mix(in_srgb,var(--app-accent)_12%,transparent)] "
  + "text-[var(--app-accent)] "
  + "border-[color-mix(in_srgb,var(--app-accent)_25%,transparent)]";

// 身份色徽章（local 中性 / wsl / ssh），亮暗随 token 自动切换
export function projectBadgeClassName(kind: "local" | "wsl" | "ssh"): string {
  switch (kind) {
    case "local":
      return `${PROJECT_BADGE_BASE} bg-[color-mix(in_srgb,var(--app-text-primary)_8%,transparent)] text-[var(--app-text-secondary)] border-[var(--app-border)]`;
    case "wsl":
      return `${PROJECT_BADGE_BASE} bg-[color-mix(in_srgb,var(--app-identity-wsl)_14%,transparent)] text-[var(--app-identity-wsl)] border-[color-mix(in_srgb,var(--app-identity-wsl)_30%,transparent)]`;
    case "ssh":
      return `${PROJECT_BADGE_BASE} bg-[color-mix(in_srgb,var(--app-identity-ssh)_14%,transparent)] text-[var(--app-identity-ssh)] border-[color-mix(in_srgb,var(--app-identity-ssh)_30%,transparent)]`;
  }
}

const MISSING_BADGE_CLASS = `${PROJECT_BADGE_BASE} bg-[var(--app-status-danger-bg)] text-[var(--app-status-danger)] border-[color-mix(in_srgb,var(--app-status-danger)_30%,transparent)]`;

export default function ProjectListItem({
  project, workspace, gitBranch, pathStatus, worktreeBranch, leading, trailing,
  onOpenTerminal, onRemoveProject, onSetProjectAlias,
  onMigrateProject, onOpenWorktreeManager, onOpenInFileBrowser,
  availableCliToolIds,
}: ProjectListItemProps) {
  const { t } = useTranslation(["sidebar", "common", "spec"]);
  const sshMachines = useSshMachinesStore((s) => s.machines);
  const setProjectArchived = useWorkspacesStore((s) => s.setProjectArchived);
  const rawFavoriteLaunchIds = useSettingsStore((s) => s.settings?.general.launchFavorites);
  const onOpenHistory = useDialogStore((s) => s.openLocalHistory);
  const onOpenTodo = useDialogStore((s) => s.openTodo);
  const [specs, setSpecs] = useState<SpecEntry[]>([]);
  const isWindows = detectAppPlatform() === "windows";
  const isSsh = !!project.ssh;
  const isMissing = pathStatus === "missing";
  const defaultEnvironment = getWorkspaceDefaultEnvironment(workspace);

  const handleLoadSpecs = useCallback(async (projectPath: string) => {
    try {
      setSpecs(await specService.list(projectPath));
    } catch {
      setSpecs([]);
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
        path_platform_mismatch: "The saved path belongs to another operating system: {{path}}",
        wsl_unsupported: "WSL is only available on Windows.",
        wsl_path_missing: "WSL launch requires a remote path.",
        wsl_local_path_missing: "WSL launch requires a local anchor path or a WSL project.",
        ssh_machine_missing: "SSH launch requires a selected machine.",
        ssh_machine_not_found: "The saved SSH machine could not be found: {{machineId}}",
        ssh_path_missing: "SSH launch requires a remote path.",
      }[issue.code],
    });
  }, [t]);

  const projectKind = getWorkspaceProjectKind(project);
  const canLaunchWsl = isWindows
    && !resolveWorkspaceProjectLaunchOptions({
      workspace, project, machines: sshMachines, environment: "wsl",
    }).issue;
  const canLaunchSsh = !resolveWorkspaceProjectLaunchOptions({
    workspace, project, machines: sshMachines, environment: "ssh",
  }).issue;
  const cliLaunchItems = buildSidebarCliLaunchItems(
    t, canLaunchWsl, canLaunchSsh, availableCliToolIds,
  );
  // 常用项平铺，其余折叠进"更多启动方式"（issue #36：避免 20+ 项平铺）
  const groupedCliLaunchItems = groupSidebarCliLaunchItems(
    cliLaunchItems,
    rawFavoriteLaunchIds ?? getDefaultSidebarFavoriteLaunchActionIds(),
  );
  const displayName = project.alias || (isSsh ? getSshDisplayName(project.ssh!) : getProjectName(project.path));
  const branchLabel = worktreeBranch || gitBranch;

  const launchProject = (
    cliTool?: OpenTerminalOptions["cliTool"],
    environment?: WorkspaceLaunchEnvironment,
  ) => {
    const { options, issue } = resolveWorkspaceProjectLaunchOptions({
      workspace, project, cliTool, environment, machines: sshMachines,
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

  // 双击/键盘激活共用：SSH 项目=连接（launchProject），本地项目=打开文件浏览器
  const activateProject = () => {
    if (isSsh) {
      launchProject();
    } else {
      onOpenInFileBrowser?.(project.path);
    }
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className="rounded-xl border border-transparent px-2 py-1.5 transition-colors duration-[var(--dur-fast)] text-[var(--app-text-secondary)] hover:border-[var(--app-border)] hover:bg-[var(--app-hover)] hover:text-[var(--app-text-primary)]"
        >
          <div
            role="button"
            tabIndex={0}
            className="flex cursor-pointer items-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]"
            onDoubleClick={activateProject}
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget) return;
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                activateProject();
              }
            }}
          >
            {leading}
            {isMissing
              ? <FolderX size={14} className="shrink-0" style={{ color: "var(--app-status-danger)" }} />
              : isSsh
                ? <Globe size={14} className="shrink-0" style={{ color: "var(--app-accent)" }} />
                : <Folder size={14} className="shrink-0" style={{ color: "var(--app-accent)" }} />
            }
            {/* min-w 保底：窄侧栏下名称不再被徽章挤成 "cc…" */}
            <span
              className={`flex-1 min-w-[4rem] text-[13px] truncate ${isMissing ? "line-through text-[var(--app-text-tertiary)]" : ""}`}
              title={isMissing ? project.path : undefined}
            >
              {displayName}
            </span>
            {isMissing ? (
              <span className={MISSING_BADGE_CLASS}>{t("explorer.gitPathNotFound")}</span>
            ) : (
              <>
                {!isSsh && branchLabel && (
                  <span className={BRANCH_BADGE_CLASS}>{branchLabel}</span>
                )}
                <span className={projectBadgeClassName(projectKind)}>
                  {projectKind.toUpperCase()}
                </span>
              </>
            )}
            {trailing}
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
        <AgentChatMenuItem path={project.path} />
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
            {/* 路径已不存在时，下列入口必然失败，直接不展示 */}
            {!isMissing && (
              <>
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
                    {specs.length === 0 ? (
                      <ContextMenuItem disabled>{t("noSpecs")}</ContextMenuItem>
                    ) : (
                      specs.map((spec) => (
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
          </>
        )}
        <ContextMenuItem onClick={() => onSetProjectAlias(workspace, project)}>
          <Pencil /> {t("setAlias")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ArchiveMenuItem
          target="project"
          archivedAt={project.archivedAt}
          onToggle={(next) =>
            void setProjectArchived(workspace.name, project.id, next)
          }
        />
        <ContextMenuItem variant="destructive" onClick={() => onRemoveProject(workspace, project)}>
          <Trash2 /> {t("removeProject")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
