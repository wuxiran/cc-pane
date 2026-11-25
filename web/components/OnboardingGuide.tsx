// 首启三步向导（单栏）：环境与模式 → 项目 → 并排启动。
// 顶部横排步骤导航（完成✓/当前实心/未来空心，可点击回退已到过的步）。
// 项目步一次点击完成「扫描目录 + 建工作空间 + 导入」，工作空间名默认取目录名；已有项目直接确认。
// launchPair 成功后弹窗 aha-stand-back 退让 2.6s 让用户看到身后双终端，随后引导自动完成并关闭
// （reduced-motion 直接完成）。Esc/关闭/跳过引导收敛同一 complete()（docs/46 §6.1），
// ONBOARDING_MULTI_LAUNCH_KEY 写入点不变。步骤级子组件在 onboarding/onboardingSteps.tsx。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { ArrowLeft, ArrowRight, MessageSquareText } from "lucide-react";
import { Button } from "@/components/ui/button";
import GuidedDialog from "@/components/onboarding/GuidedDialog";
import EnvironmentPreflightCard from "@/components/onboarding/EnvironmentPreflightCard";
import AgentConciergeEntry from "@/components/onboarding/AgentConciergeEntry";
import {
  baseName,
  ParallelStep,
  PresetChips,
  scannedPaths,
  STEP_KEYS,
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
import { isTauriRuntime } from "@/services/runtime";
import * as workspaceService from "@/services/workspaceService";
import { resolveWorkspaceProjectLaunchOptions } from "@/utils/workspaceLaunch";
import type {
  CliTool,
  EnvironmentInfo,
  OpenTerminalOptions,
  Workspace,
  WorkspaceProject,
} from "@/types";

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
    <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-[var(--app-border)] pt-4 text-xs text-[var(--app-text-tertiary)]">
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
      {props.step === 1 && (
        <Button type="button" variant="ghost" size="sm" disabled={props.busy} onClick={props.onSkipStep}>
          {t("actions.skipStep")}
        </Button>
      )}
      <Button type="button" size="sm" disabled={props.primaryDisabled || props.busy} onClick={props.onPrimary}>
        {props.primaryLabel}
        {props.step < 2 && <ArrowRight className="size-4" aria-hidden="true" />}
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
  const [importMode, setImportMode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ahaActive, setAhaActive] = useState(false);
  const [flowError, setFlowError] = useState<string | null>(null);
  const ahaTimer = useRef<number | null>(null);
  const target = useMemo(
    () => findLaunchTarget(workspaces, workspaceId, projectId),
    [workspaces, workspaceId, projectId],
  );
  const cliPair = useMemo(() => selectCliPair(environment), [environment]);
  const importing = !target || importMode;

  const goTo = useCallback((next: StepIndex) => {
    setStep(next);
    setFlowError(null);
    setMaxVisited((prev) => (next > prev ? next : prev));
  }, []);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setStep(0);
    setMaxVisited(0);
    setImportMode(false);
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

  const pickFolder = useCallback(async () => {
    try {
      const selected = await openDialog({ directory: true, multiple: false, title: t("workspace.pick") });
      if (typeof selected === "string") setRootPath(selected);
    } catch {
      // 用户取消或对话框不可用：保持手输
    }
  }, [t]);

  // 一次完成：扫描 → 建工作空间（名称默认取目录名）→ 导入全部仓库
  const importProject = useCallback(async () => {
    const path = rootPath.trim();
    if (!path) return;
    setBusy(true);
    setFlowError(null);
    try {
      let repos;
      try {
        repos = await workspaceService.scanDirectory(path);
      } catch {
        setFlowError(t("workspace.scanFailed"));
        return;
      }
      const paths = scannedPaths(repos);
      if (paths.length === 0) {
        setFlowError(t("workspace.noneFound"));
        return;
      }
      const name = workspaceName.trim() || baseName(path);
      const workspace = await useWorkspacesStore.getState().create(name, path);
      let firstProject: WorkspaceProject | null = null;
      for (const projectPath of paths) {
        const imported = await useWorkspacesStore.getState().addProject(workspace.name, projectPath);
        firstProject ??= imported;
      }
      useWorkspacesStore.getState().expandWorkspace(workspace.id);
      useWorkspacesStore.getState().expandProject(firstProject?.id ?? null);
      setImportMode(false);
      goTo(2);
    } catch {
      setFlowError(t("workspace.importFailed"));
    } finally {
      setBusy(false);
    }
  }, [goTo, rootPath, t, workspaceName]);

  const launchPair = useCallback(() => {
    if (!target || !cliPair) return;
    const machines = useSshMachinesStore.getState().machines;
    const resolve = (cliTool: CliTool) => resolveWorkspaceProjectLaunchOptions({
      workspace: target.workspace,
      project: target.project,
      cliTool,
      providerId: target.workspace.providerId,
      providerSelection: "inherit",
      machines,
    });
    const first = resolve(cliPair[0]);
    const second = resolve(cliPair[1]);
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
    // aha 退让：弹窗淡出 2.6s 让用户看到身后双终端，然后引导完成；reduced-motion 直接完成
    const reduced = typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      void complete();
      return;
    }
    setAhaActive(true);
    ahaTimer.current = window.setTimeout(() => {
      setAhaActive(false);
      void complete();
    }, 2600);
  }, [cliPair, complete, onOpenTerminal, t, target]);

  const primary = () => {
    setFlowError(null);
    if (step === 0) {
      useModulePrefsStore.getState().applyPreset(preset);
      goTo(1);
    } else if (step === 1) {
      if (importing) void importProject();
      else goTo(2);
    } else {
      launchPair();
    }
  };

  const primaryLabel = step === 0
    ? t("actions.continueSetup")
    : step === 1
      ? importing ? t("workspace.import") : t("actions.continueSetup")
      : t("actions.launchPair");
  const primaryDisabled = checking
    || ahaActive
    || (step === 1 && importing && !rootPath.trim())
    || (step === 2 && (!target || !cliPair));

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
          importMode={importMode}
          workspaceName={workspaceName}
          rootPath={rootPath}
          error={flowError}
          onWorkspaceNameChange={setWorkspaceName}
          onRootPathChange={setRootPath}
          onPickFolder={isTauriRuntime() ? () => void pickFolder() : undefined}
          onImportOther={() => setImportMode(true)}
        />
      )
      : <ParallelStep target={target} pair={cliPair} />;

  return (
    <GuidedDialog
      open={open}
      onOpenChange={(nextOpen) => { if (!nextOpen && !busy) void complete(); }}
      className={ahaActive ? "aha-stand-back" : undefined}
      nav={<StepNav step={step} maxVisited={maxVisited} onNavigate={goTo} />}
      title={t(`steps.${STEP_KEYS[step]}.title` as never)}
      description={t(`steps.${STEP_KEYS[step]}.description` as never)}
      footer={(
        <GuideFooter
          step={step}
          primaryLabel={primaryLabel}
          primaryDisabled={primaryDisabled}
          busy={busy}
          onBack={() => goTo((step - 1) as StepIndex)}
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
      {step === 0 && <AgentHint environment={environment} onOpenTerminal={onOpenTerminal} />}
    </GuidedDialog>
  );
}
