import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { openPath } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";
import {
  ChevronRight,
  Files,
  Folder,
  FolderOpen,
  FolderSearch,
  GitBranch,
  Globe,
  Settings2,
  Terminal,
  Trash2,
} from "lucide-react";
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useProvidersStore, useDialogStore, useSshMachinesStore } from "@/stores";
import { hooksService, type HookStatus } from "@/services";
import { useCliTools } from "@/hooks/useCliTools";
import {
  detectAppPlatform,
  getWorkspaceDefaultEnvironment,
  getWorkspaceLaunchIssueKey,
  getWorkspaceLaunchIssueValues,
  hasWorkspaceWslPath,
  resolveWorkspaceLaunchOptions,
} from "@/utils";
import type { OpenTerminalOptions, Workspace, WorkspaceLaunchEnvironment } from "@/types";
import { getCompatibleCliTool } from "@/types/provider";
import AddSshProjectDialog from "./AddSshProjectDialog";

interface WorkspaceItemProps {
  ws: Workspace;
  expanded: boolean;
  children: React.ReactNode;
  onExpand: (wsId: string) => void;
  onOpenTerminal: (opts: OpenTerminalOptions) => void;
  onRename: (ws: Workspace) => void;
  onDelete: (ws: Workspace) => void;
  onSetAlias: (ws: Workspace) => void;
  onImportProject: (ws: Workspace) => void;
  onScanImport: (ws: Workspace) => void;
  onGitClone: (ws: Workspace) => void;
  onSetPath: (ws: Workspace) => void;
  onClearPath: (ws: Workspace) => void;
  onSetProvider: (ws: Workspace, providerId: string | null) => void;
  onSetDefaultEnvironment: (ws: Workspace, environment: WorkspaceLaunchEnvironment) => void;
  onOpenInFileBrowser?: (path: string) => void;
}

export default function WorkspaceItem({
  ws,
  expanded,
  children,
  onExpand,
  onOpenTerminal,
  onRename,
  onDelete,
  onSetAlias,
  onImportProject,
  onScanImport,
  onGitClone,
  onSetPath,
  onClearPath,
  onSetProvider,
  onSetDefaultEnvironment,
  onOpenInFileBrowser,
}: WorkspaceItemProps) {
  const { t } = useTranslation(["sidebar", "common"]);
  const providerList = useProvidersStore((s) => s.providers);
  const sshMachines = useSshMachinesStore((s) => s.machines);
  const { tools: cliTools } = useCliTools();
  const [hookStatuses, setHookStatuses] = useState<HookStatus[]>([]);
  const [sshDialogOpen, setSshDialogOpen] = useState(false);

  const displayName = ws.alias || ws.name;
  const rootProject = ws.projects.find((project) => !project.ssh);
  const rootPath = ws.path || rootProject?.path;
  const showWslBadge = hasWorkspaceWslPath(ws);
  const boundProvider = ws.providerId
    ? providerList.find((provider) => provider.id === ws.providerId)
    : undefined;
  const isWindows = detectAppPlatform() === "windows";

  const formatLaunchIssue = useCallback((
    issue: NonNullable<ReturnType<typeof resolveWorkspaceLaunchOptions>["issue"]>,
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

  const openWorkspace = useCallback((cliTool?: OpenTerminalOptions["cliTool"], providerId?: string) => {
    const { options, issue } = resolveWorkspaceLaunchOptions({
      workspace: ws,
      cliTool,
      providerId,
      machines: sshMachines,
    });
    if (!options || issue) {
      const currentEnvironment = getWorkspaceDefaultEnvironment(ws);
      toast.error(
        formatLaunchIssue(issue ?? {
          environment: currentEnvironment,
          code: "local_path_missing",
        }),
      );
      return;
    }
    onOpenTerminal(options);
  }, [formatLaunchIssue, onOpenTerminal, sshMachines, ws]);

  const fetchHookStatuses = useCallback(async () => {
    if (!rootPath) return;
    try {
      const statuses = await hooksService.getStatus(rootPath);
      setHookStatuses(statuses);
    } catch {
      setHookStatuses([]);
    }
  }, [rootPath]);

  const handleToggleHook = useCallback(async (hook: HookStatus) => {
    if (!rootPath) return;
    try {
      if (hook.enabled) {
        await hooksService.disableHook(rootPath, hook.name);
      } else {
        await hooksService.enableHook(rootPath, hook.name);
      }
      await fetchHookStatuses();
    } catch (error) {
      toast.error(t("hookOperationFailed", { error }));
    }
  }, [fetchHookStatuses, rootPath, t]);

  const handleRevealFolder = useCallback(async () => {
    if (!rootPath) return;
    try {
      await openPath(rootPath);
    } catch (error) {
      toast.error(t("openFolderFailed", { error }));
    }
  }, [rootPath, t]);

  function getHookLabel(hook: HookStatus): string {
    const labels: Record<string, string> = {
      "session-inject": t("hookSessionInject"),
      "plan-archive": t("hookPlanArchive"),
    };
    return labels[hook.name] || hook.label;
  }

  return (
    <div>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            className={`w-full group flex items-center justify-between px-3 py-2.5 mb-1 rounded-xl transition-all duration-300 ${
              expanded
                ? "border border-[var(--app-border)] text-[var(--app-accent)]"
                : "border border-transparent text-[var(--app-text-secondary)] hover:bg-[var(--app-hover)] hover:text-[var(--app-text-primary)]"
            }`}
            style={expanded ? { background: "var(--app-hover)" } : undefined}
            onClick={() => onExpand(ws.id)}
          >
            <div className="flex items-center gap-2">
              <ChevronRight className={`w-3.5 h-3.5 transition-transform ${expanded ? "rotate-90" : ""}`} />
              <span className="text-sm font-medium tracking-wide">{displayName}</span>
              {showWslBadge ? (
                <span className="text-[9px] px-1.5 py-0.5 rounded-full font-medium bg-amber-100 text-amber-700 border border-amber-200 dark:bg-amber-500/20 dark:text-amber-300 dark:border-amber-500/30">
                  WSL
                </span>
              ) : null}
              {boundProvider ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="text-[9px] px-1.5 py-0.5 rounded-full font-medium border bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-500/20 dark:text-slate-300 dark:border-slate-500/30">
                      {boundProvider.name}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="top">Provider: {boundProvider.name}</TooltipContent>
                </Tooltip>
              ) : null}
            </div>
            <span
              className="text-xs px-2 py-0.5 rounded-full text-[var(--app-text-secondary)]"
              style={{ background: "var(--app-hover)" }}
            >
              {ws.projects.length}
            </span>
          </button>
        </ContextMenuTrigger>

        <ContextMenuContent className="w-48">
          <ContextMenuItem onClick={() => openWorkspace()}>
            <Terminal /> {t("openTerminal")}
          </ContextMenuItem>

          {cliTools.map((tool) => {
            if (tool.id === "codex") {
              return (
                <ContextMenuItem key={tool.id} onClick={() => openWorkspace(tool.id)}>
                  <Terminal /> {tool.displayName}
                </ContextMenuItem>
              );
            }

            const compatibleProviders = providerList.filter(
              (provider) => getCompatibleCliTool(provider.providerType) === tool.id,
            );
            if (compatibleProviders.length === 0) {
              return (
                <ContextMenuItem key={tool.id} onClick={() => openWorkspace(tool.id)}>
                  <Terminal /> {tool.displayName}
                </ContextMenuItem>
              );
            }

            return (
              <ContextMenuSub key={tool.id}>
                <ContextMenuSubTrigger>
                  <Terminal /> {tool.displayName}
                </ContextMenuSubTrigger>
                <ContextMenuSubContent className="w-48">
                  <ContextMenuItem onClick={() => openWorkspace(tool.id)}>
                    {`（${t("default", { ns: "common", defaultValue: "默认" })}）`}
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  {compatibleProviders.map((provider) => (
                    <ContextMenuItem
                      key={provider.id}
                      onClick={() => openWorkspace(tool.id, provider.id)}
                    >
                      {provider.name}
                    </ContextMenuItem>
                  ))}
                </ContextMenuSubContent>
              </ContextMenuSub>
            );
          })}

          {isWindows ? (
            <>
              <ContextMenuSeparator />
              <ContextMenuCheckboxItem
                checked={getWorkspaceDefaultEnvironment(ws) === "wsl"}
                onClick={() => onSetDefaultEnvironment(
                  ws,
                  getWorkspaceDefaultEnvironment(ws) === "wsl" ? "local" : "wsl",
                )}
              >
                {t("defaultOpenInWsl")}
              </ContextMenuCheckboxItem>
            </>
          ) : null}

          <ContextMenuSeparator />

          <ContextMenuItem disabled={!rootPath} onClick={handleRevealFolder}>
            <FolderOpen /> {t("openFolder")}
          </ContextMenuItem>
          <ContextMenuItem
            disabled={!rootPath}
            onClick={() => rootPath && onOpenInFileBrowser?.(rootPath)}
          >
            <Files /> {t("openInFileBrowser")}
          </ContextMenuItem>

          <ContextMenuSeparator />

          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <Folder /> {t("importProject")}
            </ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuItem onClick={() => onImportProject(ws)}>
                {t("importFromDir")}
              </ContextMenuItem>
              <ContextMenuItem onClick={() => onScanImport(ws)}>
                <FolderSearch /> {t("importFromDir")}
              </ContextMenuItem>
              <ContextMenuItem onClick={() => onGitClone(ws)}>
                <GitBranch /> {t("cloneFromGit")}
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem onClick={() => setSshDialogOpen(true)}>
                <Globe /> {t("addSshProject")}
              </ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuSub>

          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <Settings2 /> {t("settings", { ns: "common" })}
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className="w-52">
              <ContextMenuSub>
                <ContextMenuSubTrigger>Provider</ContextMenuSubTrigger>
                <ContextMenuSubContent className="w-44">
                  <ContextMenuRadioGroup value={ws.providerId ?? ""}>
                    <ContextMenuRadioItem value="" onClick={() => onSetProvider(ws, null)}>
                      {t("noProvider")}
                    </ContextMenuRadioItem>
                    {providerList.length > 0 ? <ContextMenuSeparator /> : null}
                    {providerList.map((provider) => (
                      <ContextMenuRadioItem
                        key={provider.id}
                        value={provider.id}
                        onClick={() => onSetProvider(ws, provider.id)}
                      >
                        {provider.name}
                      </ContextMenuRadioItem>
                    ))}
                  </ContextMenuRadioGroup>
                </ContextMenuSubContent>
              </ContextMenuSub>

              <ContextMenuItem onClick={() => onSetPath(ws)}>
                {t("setWorkspacePath")}
              </ContextMenuItem>
              {ws.path ? (
                <ContextMenuItem onClick={() => onClearPath(ws)}>
                  {t("clearWorkspacePath")}
                </ContextMenuItem>
              ) : null}

              <ContextMenuSeparator />

              <ContextMenuItem onClick={() => onSetAlias(ws)}>
                {t("setAlias")}
              </ContextMenuItem>
              <ContextMenuItem onClick={() => onRename(ws)}>
                {t("renameWorkspace")}
              </ContextMenuItem>

              <ContextMenuSeparator />

              <ContextMenuSub>
                <ContextMenuSubTrigger onPointerEnter={() => fetchHookStatuses()}>
                  {t("hooks")}
                </ContextMenuSubTrigger>
                <ContextMenuSubContent>
                  {hookStatuses.map((hook) => (
                    <ContextMenuCheckboxItem
                      key={hook.name}
                      checked={hook.enabled}
                      onClick={() => handleToggleHook(hook)}
                    >
                      {getHookLabel(hook)}
                    </ContextMenuCheckboxItem>
                  ))}
                  {hookStatuses.length === 0 ? (
                    <ContextMenuItem disabled>Loading...</ContextMenuItem>
                  ) : null}
                </ContextMenuSubContent>
              </ContextMenuSub>
            </ContextMenuSubContent>
          </ContextMenuSub>

          <ContextMenuSeparator />

          <ContextMenuItem variant="destructive" onClick={() => onDelete(ws)}>
            <Trash2 /> {t("deleteWorkspace")}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {expanded ? children : null}

      <AddSshProjectDialog
        open={sshDialogOpen}
        onOpenChange={setSshDialogOpen}
        workspaceName={ws.name}
      />
    </div>
  );
}
