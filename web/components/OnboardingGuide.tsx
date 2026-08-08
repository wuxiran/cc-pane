// 首启四步向导：环境与模式（preflight+模式双选并入一步）→ 建工作空间 → 并排启动 → 就绪。
// 左栏顶部步骤导航（完成✓/当前实心/未来空心，可点击回退已到过的步）；
// launchPair 成功后弹窗 aha-stand-back 退让 2.6s 让用户看到身后双终端（reduced-motion 直接跳就绪步）。
// Esc/关闭/跳过全部收敛同一 complete()（docs/46 §6.1），ONBOARDING_MULTI_LAUNCH_KEY 写入点不变。
// 步骤级子组件在 onboarding/onboardingSteps.tsx。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, ArrowRight, MessageSquareText } from "lucide-react";
import { Button } from "@/components/ui/button";
import GuidedDialog from "@/components/onboarding/GuidedDialog";
import EnvironmentPreflightCard from "@/components/onboarding/EnvironmentPreflightCard";
import OnboardingVisual from "@/components/onboarding/OnboardingVisual";
import AgentConciergeEntry from "@/components/onboarding/AgentConciergeEntry";
import {
  FinishStep,
  ParallelStep,
  PresetChips,
  scannedPaths,
  StepNav,
  WorkspaceStep,
} from "@/components/onboarding/onboardingSteps";
import type { LaunchTarget, Preset, StepIndex } from "@/components/onboarding/onboardingSteps";
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

export { ONBOARDING_MULTI_LAUNCH_KEY } from "@/components/onboarding/setupGuideProgress";

interface OnboardingGuideProps {
  onOpenTerminal: (options: OpenTerminalOptions) => void;
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

interface GuideFooterProps {
  step: StepIndex;
  primaryLabel: string;
  primaryDisabled: boolean;
  busy: boolean;
  onBack: () => void;
  onSkipStep: () => void;
  onSkipAll: () => void;
  onPrimary: () => void;
}

function GuideFooter(props: GuideFooterProps) {
  const { t } = useTranslation("onboarding");
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
      {props.step < 3 && (
        <Button type="button" variant="outline" size="sm" disabled={props.busy} onClick={props.onSkipStep}>
          {t("actions.skipStep")}
        </Button>
      )}
      <Button type="button" size="sm" disabled={props.primaryDisabled || props.busy} onClick={props.onPrimary}>
        {props.primaryLabel}
        {props.step < 3 && <ArrowRight className="size-4" aria-hidden="true" />}
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
  const [maxVisited, setMaxVisited] = useState<StepIndex>(0);
  const [preset, setPreset] = useState<Preset>("full");
  const [environment, setEnvironment] = useState<EnvironmentInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [environmentError, setEnvironmentError] = useState<string | null>(null);
  const [workspaceName, setWorkspaceName] = useState("");
  const [rootPath, setRootPath] = useState("");
  const [repos, setRepos] = useState<ScannedRepo[]>([]);
  const [busy, setBusy] = useState(false);
  const [ahaActive, setAhaActive] = useState(false);
  const [flowError, setFlowError] = useState<string | null>(null);
  const ahaTimer = useRef<number | null>(null);
  const target = useMemo(
    () => findLaunchTarget(workspaces, workspaceId, projectId),
    [workspaces, workspaceId, projectId],
  );
  const cliPair = useMemo(() => selectCliPair(environment), [environment]);

  const goTo = useCallback((next: StepIndex) => {
    setStep(next);
    setMaxVisited((prev) => (next > prev ? next : prev));
  }, []);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setStep(0);
    setMaxVisited(0);
    setFlowError(null);
    setEnvironmentError(null);
    setChecking(true);
    terminalService.checkEnvironment()
      .then((result) => { if (!cancelled) setEnvironment(result); })
      .catch(() => { if (!cancelled) setEnvironmentError(t("environment.checkFailed")); })
      .finally(() => { if (!cancelled) setChecking(false); });
    return () => { cancelled = true; };
  }, [open, t]);

  useEffect(() => () => {
    if (ahaTimer.current != null) window.clearTimeout(ahaTimer.current);
  }, []);

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
      goTo(2);
    } catch {
      setFlowError(t("workspace.importFailed"));
    } finally {
      setBusy(false);
    }
  }, [goTo, repos, rootPath, t, workspaceName]);

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
    // aha 退让：弹窗淡出 2.6s 让用户看到身后双终端；reduced-motion 直接进就绪步
    const reduced = typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      goTo(3);
      return;
    }
    setAhaActive(true);
    ahaTimer.current = window.setTimeout(() => {
      setAhaActive(false);
      goTo(3);
    }, 2600);
  }, [cliPair, goTo, onOpenTerminal, t, target]);

  const primary = () => {
    setFlowError(null);
    if (step === 0) {
      useModulePrefsStore.getState().applyPreset(preset);
      goTo(1);
    } else if (step === 1) {
      // 主按钮跟随输入态：有扫描结果→创建并导入；无结果但有路径→扫描；有项目→直接继续
      if (repos.length > 0 && workspaceName.trim()) void createAndImport();
      else if (!target && rootPath.trim()) void scan();
      else if (target) goTo(2);
    } else if (step === 2) {
      launchPair();
    } else {
      void complete();
    }
  };

  // step 1 主按钮三态（消灭"主按钮常灰、前进键藏在结果条里"）
  const workspacePrimaryLabel = step !== 1
    ? t(`actions.${(["continueSetup", "", "launchPair", "finish"] as const)[step]}` as never)
    : repos.length > 0
      ? t("workspace.createAndImport")
      : target
        ? t("actions.useCurrentProject")
        : t("workspace.scan");
  const primaryDisabled = checking
    || (step === 1 && (
      repos.length > 0
        ? !workspaceName.trim() || busy
        : target
          ? false
          : !rootPath.trim() || busy
    ))
    || (step === 2 && (!target || !cliPair));

  const stepKeys = ["environment", "workspace", "parallel", "finish"] as const;
  const content = step === 0
    ? (
      <>
        <EnvironmentPreflightCard environment={environment} checking={checking} error={environmentError} />
        <PresetChips value={preset} onChange={setPreset} />
      </>
    )
    : step === 1
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
        />
      )
      : step === 2
        ? <ParallelStep target={target} pair={cliPair} />
        : <FinishStep />;

  return (
    <GuidedDialog
      open={open}
      onOpenChange={(nextOpen) => { if (!nextOpen && !busy) void complete(); }}
      className={ahaActive ? "aha-stand-back" : undefined}
      nav={<StepNav step={step} maxVisited={maxVisited} onNavigate={goTo} />}
      title={t(`steps.${stepKeys[step]}.title` as never)}
      description={t(`steps.${stepKeys[step]}.description` as never)}
      visual={<OnboardingVisual step={step} />}
      footer={(
        <GuideFooter
          step={step}
          primaryLabel={workspacePrimaryLabel}
          primaryDisabled={primaryDisabled}
          busy={busy}
          onBack={() => setStep((step - 1) as StepIndex)}
          onSkipStep={() => goTo((step + 1) as StepIndex)}
          onSkipAll={() => void complete()}
          onPrimary={primary}
        />
      )}
    >
      {content}
      {flowError && step !== 1 && (
        <p className="mt-4 text-xs text-[var(--app-status-danger)]">{flowError}</p>
      )}
      <AgentHint environment={environment} onOpenTerminal={onOpenTerminal} />
    </GuidedDialog>
  );
}
