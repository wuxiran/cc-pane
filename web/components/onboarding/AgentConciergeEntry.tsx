import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Bot, FolderInput, Loader2, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import EnvironmentPreflightCard from "./EnvironmentPreflightCard";
import conciergePrompt from "@/resources/prompts/ccpanes-concierge.md?raw";
import { terminalService } from "@/services";
import {
  useActivityBarStore,
  useDialogStore,
  useSettingsStore,
  useSshMachinesStore,
  useWorkspacesStore,
} from "@/stores";
import {
  resolveWorkspaceLaunchOptions,
  resolveWorkspaceProjectLaunchOptions,
} from "@/utils/workspaceLaunch";
import type {
  CliTool,
  EnvironmentInfo,
  OpenTerminalOptions,
  Workspace,
  WorkspaceProject,
} from "@/types";
import { cn } from "@/lib/utils";

export const CONCIERGE_SYSTEM_PROMPT = conciergePrompt.trim();

interface AgentConciergeEntryProps {
  environment?: EnvironmentInfo | null;
  onOpenTerminal?: (options: OpenTerminalOptions) => void;
  compact?: boolean;
  className?: string;
}

interface ConciergeTarget {
  workspace: Workspace;
  project?: WorkspaceProject;
}

function findTarget(
  workspaces: readonly Workspace[],
  workspaceId: string | null,
  projectId: string | null,
): ConciergeTarget | null {
  const selectedWorkspace = workspaces.find((item) => item.id === workspaceId);
  const selectedProject = selectedWorkspace?.projects.find((item) => item.id === projectId);
  if (selectedWorkspace && selectedProject) return { workspace: selectedWorkspace, project: selectedProject };
  if (selectedWorkspace && (selectedWorkspace.path || selectedWorkspace.projects[0])) {
    return { workspace: selectedWorkspace, project: selectedWorkspace.projects[0] };
  }
  const workspace = workspaces.find((item) => item.path || item.projects.length > 0);
  if (!workspace) return null;
  return { workspace, project: workspace.projects[0] };
}

function selectTool(environment: EnvironmentInfo | null): CliTool | null {
  const supported = environment?.cliTools.filter(
    (tool) => tool.installed && (tool.id === "claude" || tool.id === "codex"),
  ) ?? [];
  const preferred = useSettingsStore.getState().settings?.general.defaultCliTool;
  return supported.find((tool) => tool.id === preferred)?.id ?? supported[0]?.id ?? null;
}

function buildLaunch(target: ConciergeTarget, cliTool: CliTool): OpenTerminalOptions | null {
  const machines = useSshMachinesStore.getState().machines;
  const common = {
    workspace: target.workspace,
    cliTool,
    providerId: target.workspace.providerId,
    providerSelection: "inherit" as const,
    machines,
  };
  const result = target.project
    ? resolveWorkspaceProjectLaunchOptions({ ...common, project: target.project })
    : resolveWorkspaceLaunchOptions(common);
  if (!result.options) return null;
  return {
    ...result.options,
    skipMcp: false,
    appendSystemPrompt: CONCIERGE_SYSTEM_PROMPT,
  };
}

export default function AgentConciergeEntry({
  environment: providedEnvironment,
  onOpenTerminal,
  compact = false,
  className,
}: AgentConciergeEntryProps) {
  const { t } = useTranslation("onboarding");
  const workspaces = useWorkspacesStore((state) => state.workspaces);
  const workspaceId = useWorkspacesStore((state) => state.expandedWorkspaceId);
  const projectId = useWorkspacesStore((state) => state.expandedProjectId);
  const [environment, setEnvironment] = useState<EnvironmentInfo | null>(providedEnvironment ?? null);
  const [checking, setChecking] = useState(providedEnvironment == null);
  const [expandedRepair, setExpandedRepair] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const target = useMemo(
    () => findTarget(workspaces, workspaceId, projectId),
    [projectId, workspaceId, workspaces],
  );
  const cliTool = selectTool(environment);

  useEffect(() => {
    if (providedEnvironment !== undefined) {
      setEnvironment(providedEnvironment);
      setChecking(providedEnvironment === null);
      return;
    }
    let cancelled = false;
    setChecking(true);
    terminalService.checkEnvironment()
      .then((result) => { if (!cancelled) setEnvironment(result); })
      .catch(() => { if (!cancelled) setError(t("environment.checkFailed")); })
      .finally(() => { if (!cancelled) setChecking(false); });
    return () => { cancelled = true; };
  }, [providedEnvironment, t]);

  const launch = () => {
    if (!target || !cliTool) return;
    const options = buildLaunch(target, cliTool);
    if (!options) {
      setError(t("concierge.launchFailed"));
      return;
    }
    setError(null);
    useActivityBarStore.getState().setAppViewMode("panes");
    if (onOpenTerminal) {
      onOpenTerminal(options);
    } else {
      useDialogStore.getState().setPendingLaunch({
        ...options,
        providerId: options.providerId ?? "",
      });
    }
  };

  if (checking) {
    return (
      <Button type="button" variant="outline" size="sm" className={cn("gap-1.5", className)} disabled>
        <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
        {t("concierge.detecting")}
      </Button>
    );
  }

  if (!cliTool) {
    return (
      <div className={cn("space-y-3", className)}>
        <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={() => setExpandedRepair((value) => !value)}>
          <Wrench className="size-3.5" aria-hidden="true" />
          {t("concierge.repair")}
        </Button>
        {expandedRepair && (
          <EnvironmentPreflightCard environment={environment} checking={false} error={error} />
        )}
      </div>
    );
  }

  if (!target) {
    return (
      <div className={cn("flex items-center gap-2", className)}>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() => useActivityBarStore.getState().toggleView("explorer")}
        >
          <FolderInput className="size-3.5" aria-hidden="true" />
          {t("concierge.importFirst")}
        </Button>
      </div>
    );
  }

  return (
    <div className={cn("space-y-2", className)}>
      <Button
        type="button"
        variant={compact ? "outline" : "default"}
        size="sm"
        className="gap-1.5"
        onClick={launch}
      >
        <Bot className="size-3.5" aria-hidden="true" />
        {t("concierge.action")}
      </Button>
      {error && <p className="text-xs text-[var(--app-status-danger)]">{error}</p>}
    </div>
  );
}
