import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, ArrowRight, Check, FolderSearch, MessageSquareText, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import GuidedDialog from "@/components/onboarding/GuidedDialog";
import EnvironmentPreflightCard from "@/components/onboarding/EnvironmentPreflightCard";
import OnboardingVisual from "@/components/onboarding/OnboardingVisual";
import AgentConciergeEntry from "@/components/onboarding/AgentConciergeEntry";
import {
  notifySetupGuideProgress,
  ONBOARDING_MULTI_LAUNCH_KEY,
} from "@/components/onboarding/setupGuideProgress";
import {
  useActivityBarStore,
  useDialogStore,
  useModulePrefsStore,
  usePanesStore,
  useSettingsStore,
  useSshMachinesStore,
  useWorkspacesStore,
} from "@/stores";
import { terminalService } from "@/services";
import * as workspaceService from "@/services/workspaceService";
import { resolveWorkspaceProjectLaunchOptions } from "@/utils/workspaceLaunch";
import type {
  CliTool,
  EnvironmentInfo,
  OpenTerminalOptions,
  Workspace,
  WorkspaceProject,
} from "@/types";
import type { ScannedRepo } from "@/services/workspaceService";

type StepIndex = 0 | 1 | 2 | 3 | 4;
type Preset = "full" | "minimal";

export { ONBOARDING_MULTI_LAUNCH_KEY } from "@/components/onboarding/setupGuideProgress";

interface OnboardingGuideProps {
  onOpenTerminal: (options: OpenTerminalOptions) => void;
}

interface LaunchTarget {
  workspace: Workspace;
  project: WorkspaceProject;
}

function findLaunchTarget(
  workspaces: readonly Workspace[],
  workspaceId: string | null,
  projectId: string | null,
): LaunchTarget | null {
  const selectedWorkspace = workspaces.find((item) => item.id === workspaceId);
  const selectedProject = selectedWorkspace?.projects.find((item) => item.id === projectId);
  if (selectedWorkspace && selectedProject) {
    return { workspace: selectedWorkspace, project: selectedProject };
  }
  for (const workspace of workspaces) {
    const project = workspace.projects[0];
    if (project) return { workspace, project };
  }
  return null;
}

function selectCliPair(environment: EnvironmentInfo | null): [CliTool, CliTool] | null {
  const available = environment?.cliTools.filter((tool) => tool.installed) ?? [];
  const ordered = [
    ...available.filter((tool) => tool.id === "claude" || tool.id === "codex"),
    ...available.filter((tool) => tool.id !== "claude" && tool.id !== "codex"),
  ];
  if (ordered.length === 0) return null;
  return [ordered[0].id, (ordered[1] ?? ordered[0]).id];
}

function scannedPaths(repos: readonly ScannedRepo[]): string[] {
  return repos.flatMap((repo) => [repo.mainPath, ...repo.worktrees.map((worktree) => worktree.path)]);
}

function AgentHint({
  environment,
  onOpenTerminal,
}: {
  environment: EnvironmentInfo | null;
  onOpenTerminal: (options: OpenTerminalOptions) => void;
}) {
  const { t } = useTranslation("onboarding");
  return (
    <div className="mt-5 flex flex-wrap items-center gap-2 text-xs text-[var(--app-text-tertiary)]">
      <span className="flex items-center gap-2">
        <MessageSquareText className="size-3.5 shrink-0" aria-hidden="true" />
        {t("agentHint")}
      </span>
      <AgentConciergeEntry environment={environment} onOpenTerminal={onOpenTerminal} compact />
    </div>
  );
}

function PresetStep({ value, onChange }: { value: Preset; onChange: (preset: Preset) => void }) {
  const { t } = useTranslation("onboarding");
  return (
    <div role="radiogroup" aria-label={t("preset.groupLabel")} className="space-y-3">
      {(["full", "minimal"] as const).map((preset) => {
        const selected = value === preset;
        return (
          <button
            key={preset}
            type="button"
            role="radio"
            aria-checked={selected}
            className="flex w-full items-start gap-3 rounded-lg border px-4 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]"
            style={{
              borderColor: selected ? "var(--app-accent)" : "var(--app-border)",
              background: selected ? "var(--app-active-bg)" : "var(--app-panel-bg)",
            }}
            onClick={() => onChange(preset)}
          >
            <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border border-[var(--app-border)]">
              {selected && <Check className="size-3.5 text-[var(--app-accent)]" aria-hidden="true" />}
            </span>
            <span>
              <span className="block text-sm font-semibold text-[var(--app-text-primary)]">
                {t(`preset.${preset}.title` as never)}
              </span>
              <span className="mt-1 block text-xs leading-5 text-[var(--app-text-secondary)]">
                {t(`preset.${preset}.description` as never)}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

interface WorkspaceStepProps {
  target: LaunchTarget | null;
  workspaceName: string;
  rootPath: string;
  repos: readonly ScannedRepo[];
  busy: boolean;
  error: string | null;
  onWorkspaceNameChange: (value: string) => void;
  onRootPathChange: (value: string) => void;
  onScan: () => void;
  onImport: () => void;
}

function WorkspaceStep(props: WorkspaceStepProps) {
  const { t } = useTranslation("onboarding");
  return (
    <div className="space-y-4">
      <div className="space-y-2 text-xs leading-5 text-[var(--app-text-secondary)]">
        <p>{t("workspace.principleGather")}</p>
        <p>{t("workspace.principleMaterials")}</p>
        <p>{t("workspace.principlePortable")}</p>
      </div>
      {props.target && (
        <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-panel-bg)] px-3 py-2 text-xs text-[var(--app-text-secondary)]">
          {t("workspace.currentProject", {
            workspace: props.target.workspace.alias || props.target.workspace.name,
            project: props.target.project.alias || props.target.project.path,
          })}
        </div>
      )}
      <div className="space-y-3">
        <Input
          aria-label={t("workspace.nameLabel")}
          placeholder={t("workspace.namePlaceholder")}
          value={props.workspaceName}
          onChange={(event) => props.onWorkspaceNameChange(event.target.value)}
        />
        <div className="flex gap-2">
          <Input
            aria-label={t("workspace.pathLabel")}
            placeholder={t("workspace.pathPlaceholder")}
            value={props.rootPath}
            onChange={(event) => props.onRootPathChange(event.target.value)}
          />
          <Button
            type="button"
            variant="outline"
            className="shrink-0 gap-1.5"
            disabled={props.busy || !props.rootPath.trim()}
            onClick={props.onScan}
          >
            <FolderSearch className="size-4" aria-hidden="true" />
            {t("workspace.scan")}
          </Button>
        </div>
      </div>
      {props.repos.length > 0 && (
        <div className="flex items-center justify-between rounded-lg border border-[var(--app-border)] bg-[var(--app-panel-bg)] px-3 py-2">
          <span className="text-xs text-[var(--app-text-secondary)]">
            {t("workspace.found", { count: scannedPaths(props.repos).length })}
          </span>
          <Button
            type="button"
            size="sm"
            disabled={props.busy || !props.workspaceName.trim()}
            onClick={props.onImport}
          >
            {t("workspace.createAndImport")}
          </Button>
        </div>
      )}
      {props.error && <p className="text-xs text-[var(--app-status-danger)]">{props.error}</p>}
    </div>
  );
}

function ParallelStep({ target, pair }: { target: LaunchTarget | null; pair: [CliTool, CliTool] | null }) {
  const { t } = useTranslation("onboarding");
  if (!pair) return <p className="text-sm text-[var(--app-status-warning)]">{t("parallel.noCli")}</p>;
  if (!target) return <p className="text-sm text-[var(--app-status-warning)]">{t("parallel.noProject")}</p>;
  return (
    <div className="space-y-4">
      <p className="text-sm leading-6 text-[var(--app-text-secondary)]">
        {t("parallel.description", { project: target.project.alias || target.project.path })}
      </p>
      <div className="flex items-center gap-2">
        {pair.map((tool, index) => (
          <span key={`${tool}-${index}`} className="rounded-md border border-[var(--app-border)] bg-[var(--app-panel-bg)] px-3 py-1.5 text-xs font-medium text-[var(--app-text-primary)]">
            {tool}
          </span>
        ))}
      </div>
    </div>
  );
}

function FinishStep() {
  const { t } = useTranslation("onboarding");
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <Sparkles className="mt-0.5 size-5 shrink-0 text-[var(--app-accent)]" aria-hidden="true" />
        <p className="text-sm leading-6 text-[var(--app-text-secondary)]">{t("finish.description")}</p>
      </div>
      <ul className="space-y-2 text-xs text-[var(--app-text-secondary)]">
        <li>{t("finish.explorer")}</li>
        <li>{t("finish.rightDock")}</li>
        <li>{t("finish.skills")}</li>
      </ul>
    </div>
  );
}

interface GuideFooterProps {
  step: StepIndex;
  primaryDisabled: boolean;
  busy: boolean;
  onBack: () => void;
  onSkipStep: () => void;
  onSkipAll: () => void;
  onPrimary: () => void;
}

function GuideFooter(props: GuideFooterProps) {
  const { t } = useTranslation("onboarding");
  const primaryKeys = ["choosePreset", "continue", "useCurrentProject", "launchPair", "finish"] as const;
  return (
    <div className="flex w-full flex-wrap items-center gap-2">
      <Button type="button" variant="ghost" size="sm" disabled={props.busy} onClick={props.onSkipAll}>
        {t("actions.skipAll")}
      </Button>
      <span className="min-w-2 flex-1" />
      {props.step > 0 && (
        <Button type="button" variant="ghost" size="sm" disabled={props.busy} onClick={props.onBack}>
          <ArrowLeft className="size-4" aria-hidden="true" />
          {t("actions.back")}
        </Button>
      )}
      {props.step < 4 && (
        <Button type="button" variant="outline" size="sm" disabled={props.busy} onClick={props.onSkipStep}>
          {t("actions.skipStep")}
        </Button>
      )}
      <Button type="button" size="sm" disabled={props.primaryDisabled || props.busy} onClick={props.onPrimary}>
        {t(`actions.${primaryKeys[props.step]}` as never)}
        {props.step < 4 && <ArrowRight className="size-4" aria-hidden="true" />}
      </Button>
    </div>
  );
}

export default function OnboardingGuide({ onOpenTerminal }: OnboardingGuideProps) {
  const { t } = useTranslation("onboarding");
  const open = useDialogStore((state) => state.onboardingOpen);
  const workspaces = useWorkspacesStore((state) => state.workspaces);
  const workspaceId = useWorkspacesStore((state) => state.expandedWorkspaceId);
  const projectId = useWorkspacesStore((state) => state.expandedProjectId);
  const [step, setStep] = useState<StepIndex>(0);
  const [preset, setPreset] = useState<Preset>("full");
  const [environment, setEnvironment] = useState<EnvironmentInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [environmentError, setEnvironmentError] = useState<string | null>(null);
  const [workspaceName, setWorkspaceName] = useState("");
  const [rootPath, setRootPath] = useState("");
  const [repos, setRepos] = useState<ScannedRepo[]>([]);
  const [busy, setBusy] = useState(false);
  const [flowError, setFlowError] = useState<string | null>(null);
  const target = useMemo(
    () => findLaunchTarget(workspaces, workspaceId, projectId),
    [workspaces, workspaceId, projectId],
  );
  const cliPair = useMemo(() => selectCliPair(environment), [environment]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setStep(0);
    setFlowError(null);
    setEnvironmentError(null);
    setChecking(true);
    terminalService.checkEnvironment()
      .then((result) => { if (!cancelled) setEnvironment(result); })
      .catch(() => { if (!cancelled) setEnvironmentError(t("environment.checkFailed")); })
      .finally(() => { if (!cancelled) setChecking(false); });
    return () => { cancelled = true; };
  }, [open, t]);

  const complete = useCallback(async () => {
    const settings = useSettingsStore.getState().settings;
    if (!settings) {
      setFlowError(t("errors.settingsUnavailable"));
      return;
    }
    setBusy(true);
    try {
      await useSettingsStore.getState().saveSettings({
        ...settings,
        general: { ...settings.general, onboardingCompleted: true },
      });
      useDialogStore.getState().closeOnboarding();
    } catch {
      setFlowError(t("errors.saveFailed"));
    } finally {
      setBusy(false);
    }
  }, [t]);

  const scan = useCallback(async () => {
    setBusy(true);
    setFlowError(null);
    try {
      const result = await workspaceService.scanDirectory(rootPath.trim());
      setRepos(result);
      if (result.length === 0) setFlowError(t("workspace.noneFound"));
    } catch {
      setFlowError(t("workspace.scanFailed"));
    } finally {
      setBusy(false);
    }
  }, [rootPath, t]);

  const createAndImport = useCallback(async () => {
    setBusy(true);
    setFlowError(null);
    try {
      const workspace = await useWorkspacesStore.getState().create(workspaceName.trim(), rootPath.trim());
      let firstProject: WorkspaceProject | null = null;
      for (const path of scannedPaths(repos)) {
        const imported = await useWorkspacesStore.getState().addProject(workspace.name, path);
        firstProject ??= imported;
      }
      useWorkspacesStore.getState().expandWorkspace(workspace.id);
      useWorkspacesStore.getState().expandProject(firstProject?.id ?? null);
      setStep(3);
    } catch {
      setFlowError(t("workspace.importFailed"));
    } finally {
      setBusy(false);
    }
  }, [repos, rootPath, t, workspaceName]);

  const launchPair = useCallback(() => {
    if (!target || !cliPair) return;
    const machines = useSshMachinesStore.getState().machines;
    const first = resolveWorkspaceProjectLaunchOptions({
      workspace: target.workspace,
      project: target.project,
      cliTool: cliPair[0],
      providerId: target.workspace.providerId,
      providerSelection: "inherit",
      machines,
    });
    const second = resolveWorkspaceProjectLaunchOptions({
      workspace: target.workspace,
      project: target.project,
      cliTool: cliPair[1],
      providerId: target.workspace.providerId,
      providerSelection: "inherit",
      machines,
    });
    if (!first.options || !second.options) {
      setFlowError(t("parallel.launchFailed"));
      return;
    }
    useActivityBarStore.getState().setAppViewMode("panes");
    onOpenTerminal(first.options);
    const paneId = usePanesStore.getState().activePane()?.id;
    if (paneId) usePanesStore.getState().splitRight(paneId);
    onOpenTerminal(second.options);
    localStorage.setItem(ONBOARDING_MULTI_LAUNCH_KEY, "true");
    notifySetupGuideProgress();
    setStep(4);
  }, [cliPair, onOpenTerminal, t, target]);

  const primary = () => {
    setFlowError(null);
    if (step === 0) setStep(1);
    else if (step === 1) {
      useModulePrefsStore.getState().applyPreset(preset);
      setStep(2);
    } else if (step === 2 && target) setStep(3);
    else if (step === 3) launchPair();
    else if (step === 4) void complete();
  };

  const primaryDisabled = checking
    || (step === 2 && !target)
    || (step === 3 && (!target || !cliPair));
  const stepKeys = ["environment", "preset", "workspace", "parallel", "finish"] as const;
  const content = step === 0
    ? <EnvironmentPreflightCard environment={environment} checking={checking} error={environmentError} />
    : step === 1
      ? <PresetStep value={preset} onChange={setPreset} />
      : step === 2
        ? (
          <WorkspaceStep
            target={target}
            workspaceName={workspaceName}
            rootPath={rootPath}
            repos={repos}
            busy={busy}
            error={flowError}
            onWorkspaceNameChange={setWorkspaceName}
            onRootPathChange={(value) => { setRootPath(value); setRepos([]); }}
            onScan={() => void scan()}
            onImport={() => void createAndImport()}
          />
        )
        : step === 3
          ? <ParallelStep target={target} pair={cliPair} />
          : <FinishStep />;

  return (
    <GuidedDialog
      open={open}
      onOpenChange={(nextOpen) => { if (!nextOpen && !busy) void complete(); }}
      title={t(`steps.${stepKeys[step]}.title` as never)}
      description={t(`steps.${stepKeys[step]}.description` as never)}
      visual={<OnboardingVisual step={step} />}
      footer={(
        <GuideFooter
          step={step}
          primaryDisabled={primaryDisabled}
          busy={busy}
          onBack={() => setStep((step - 1) as StepIndex)}
          onSkipStep={() => setStep((step + 1) as StepIndex)}
          onSkipAll={() => void complete()}
          onPrimary={primary}
        />
      )}
    >
      <p className="mb-4 text-[11px] font-semibold text-[var(--app-accent)]">
        {t("progress", { current: step + 1, total: 5 })}
      </p>
      {content}
      {flowError && step !== 2 && (
        <p className="mt-4 text-xs text-[var(--app-status-danger)]">{flowError}</p>
      )}
      <AgentHint environment={environment} onOpenTerminal={onOpenTerminal} />
    </GuidedDialog>
  );
}
