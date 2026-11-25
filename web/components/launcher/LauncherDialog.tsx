// 全局启动器弹窗（App 级唯一挂载）。提交动作 = setPendingLaunch(buildPendingLaunch(draft))
// + closeLauncher；pendingLaunch 由 App 级 useOpenTerminal 统一消费——
// 禁止在本 Dialog 内挂 useOpenTerminal（会双消费）。
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, Loader2, Rocket } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toastErr } from "@/lib/feedback";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  useActivityBarStore,
  useDialogStore,
  useProvidersStore,
  useSettingsStore,
  useSshMachinesStore,
  useWorkspacesStore,
} from "@/stores";
import { prepareLocalSessionCwd } from "@/services/localLaunchService";
import { translateError } from "@/utils";
import LauncherProjectPicker from "./LauncherProjectPicker";
import LauncherCliRow from "./LauncherCliRow";
import LauncherScenarioRow from "./LauncherScenarioRow";
import LauncherChips from "./LauncherChips";
import LauncherInjectionRow from "./LauncherInjectionRow";
import LauncherWorktreeRow from "./LauncherWorktreeRow";
import LauncherLayoutRow from "./LauncherLayoutRow";
import LauncherAdvanced, { useAdvancedSummary } from "./LauncherAdvanced";
import { loadCliPrefs, saveCliPrefs } from "./launcherPrefs";
// 文件名带 View 后缀：Windows 大小写不敏感，避免与纯函数 launcherArgsPreview.ts 解析冲突
import LauncherArgsPreview from "./LauncherArgsPreviewView";
import {
  buildAdapterOptions,
  buildPendingLaunch,
  cliToolDraftPatch,
  coerceDefaultCliTool,
  createDefaultDraft,
  isDraftLocalEnvironment,
  resolveDraftProjectPath,
  YOLO_INHERENT_CLI_TOOLS,
  type LauncherDraft,
} from "./launcherModel";
import type { CliTool } from "@/types";

/** 切换 / 预选 CLI：带上该 CLI 记住的高级参数，再叠能力约束（Pi 家族清 YOLO 等）。 */
function cliSwitchPatch(cliTool: CliTool): Partial<LauncherDraft> {
  return { ...loadCliPrefs(cliTool), ...cliToolDraftPatch(cliTool) };
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-[length:var(--text-small)] font-medium text-[var(--app-text-secondary)]">{label}</div>
      {children}
    </div>
  );
}

export default function LauncherDialog() {
  const { t } = useTranslation("launcher");
  const open = useDialogStore((s) => s.launcherOpen);
  const context = useDialogStore((s) => s.launcherContext);
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  // 设置里的「默认 CLI 工具」；非法/缺省时返回 undefined，交给 createDefaultDraft 回落 claude。
  // 用 getState() 而非 selector：草稿只在弹窗打开时重建，此刻读到的才是最新值，
  // 且避免设置变更把用户正在编辑的草稿重置掉。
  // 返回 {} 而非 { cliTool: undefined }——后者会被 createDefaultDraft 展开覆盖掉硬编码回落。
  const defaultCliToolPartial = (): Partial<LauncherDraft> => {
    const tool = coerceDefaultCliTool(
      useSettingsStore.getState().settings?.general.defaultCliTool,
    );
    return tool ? { cliTool: tool } : {};
  };
  const contextCliToolPartial = (cliTool: string | undefined): Partial<LauncherDraft> => {
    const tool = coerceDefaultCliTool(cliTool);
    return tool ? { cliTool: tool } : {};
  };
  const [draft, setDraft] = useState<LauncherDraft>(() =>
    createDefaultDraft(defaultCliToolPartial()),
  );
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const launchLock = useRef(false);
  const launchGeneration = useRef(0);

  // 每次打开按入口上下文重置草稿（workspaceName / projectPath / targetLayoutId 预选）
  useEffect(() => {
    launchGeneration.current += 1;
    if (!open) return;
    const ctxWorkspace = context?.workspaceName
      ? workspaces.find((ws) => ws.name === context.workspaceName)
      : undefined;
    const ctxProject = ctxWorkspace
      ? (context?.projectPath
          ? ctxWorkspace.projects.find((project) => project.path === context.projectPath)
          : undefined)
        ?? ctxWorkspace.projects.find(
          (project) => project.id === useWorkspacesStore.getState().expandedProjectId,
        )
        ?? ctxWorkspace.projects[0]
      : undefined;
    const base = createDefaultDraft({
        // 默认设置在前：调用点后续显式指定的字段（含 cliTool）优先级更高
        ...defaultCliToolPartial(),
        ...contextCliToolPartial(context?.cliTool),
        source:
          ctxWorkspace && ctxProject
            ? { kind: "workspace", workspaceId: ctxWorkspace.id, projectId: ctxProject.id }
            : null,
        targetLayoutId: context?.targetLayoutId,
      });
    setDraft({ ...base, ...cliSwitchPatch(base.cliTool) });
    // 账号校验（「最近启动」带回的账号是否仍可选）要用供应商列表；已加载就不重复拉
    const providerStore = useProvidersStore.getState();
    if (!providerStore.providers?.length) providerStore.loadProviders().catch(() => undefined);
    setError(null);
    setSubmitting(false);
    // workspaces 变化不重置正在编辑的草稿
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, context]);

  function patch(partial: Partial<LauncherDraft>) {
    setDraft((current) => ({ ...current, ...partial }));
    setError(null);
  }

  // 布局自动推导用的工作空间名（来源不同取法不同）
  const resolvedWorkspaceName = useMemo(() => {
    const source = draft.source;
    if (source?.kind === "workspace") {
      return workspaces.find((ws) => ws.id === source.workspaceId)?.name;
    }
    if (source?.kind === "recent") return source.options.workspaceName;
    return undefined;
  }, [draft.source, workspaces]);

  const resolvedProjectPath = useMemo(
    () => resolveDraftProjectPath(draft, workspaces),
    [draft, workspaces],
  );
  const localEnvironment = useMemo(
    () => isDraftLocalEnvironment(draft, workspaces),
    [draft, workspaces],
  );
  const recentEnvironment = draft.source?.kind === "recent" ? draft.source.options : null;
  const selectedSource = draft.source;
  const sshProject = selectedSource?.kind === "workspace" && workspaces
    .find((workspace) => workspace.id === selectedSource.workspaceId)?.projects
    .find((project) => project.id === selectedSource.projectId)?.ssh;
  const resolvedEnvironment = localEnvironment ? "local"
    : recentEnvironment?.ssh || sshProject ? "ssh"
      : recentEnvironment?.wsl ? "wsl" : draft.environment;

  const advancedSummary = useAdvancedSummary(draft, resolvedEnvironment);

  async function handleLaunch() {
    if (launchLock.current) return;
    const { launch, issue } = buildPendingLaunch(draft, {
      workspaces,
      machines: useSshMachinesStore.getState().machines,
      providers: useProvidersStore.getState().providers,
    });
    if (!launch) {
      setError(
        issue?.code === "no_project"
          ? t("errorNoProject")
          : issue?.code === "provider_required"
            ? t("errorProviderRequired")
            : issue?.code === "pi_ssh_unsupported"
              ? t("errorPiSshUnsupported")
            : issue?.code === "omp_ssh_unsupported"
              ? t("errorOmpSshUnsupported")
            : issue?.code === "jcode_ssh_unsupported"
              ? t("errorJcodeSshUnsupported")
            : issue?.code === "kiro_ssh_unsupported"
              ? t("errorKiroSshUnsupported")
            : issue?.code === "fx_ssh_unsupported"
              ? t("errorFxSshUnsupported")
            : issue?.code === "muse_ssh_unsupported"
              ? t("errorMuseSshUnsupported")
            : t("errorResolveFailed", { code: issue?.code }),
      );
      return;
    }

    let finalLaunch = launch;
    const generation = launchGeneration.current;
    launchLock.current = true;
    setSubmitting(true);
    try {
      if (draft.worktree?.enabled && !localEnvironment) {
        throw new Error(t("worktreeUnavailableRemote"));
      }
      const path = await prepareLocalSessionCwd(launch.path, draft.worktree);
      if (generation !== launchGeneration.current) return;
      finalLaunch = { ...launch, path, ...(draft.worktree?.enabled ? { launchCwd: path } : {}) };
    } catch (e) {
      toastErr(t("worktreeCreateFailed", { message: translateError(e) }));
      return;
    } finally {
      launchLock.current = false;
      setSubmitting(false);
    }

    // 非 panes 视图先切回，让消费方落位可见
    const activity = useActivityBarStore.getState();
    if (activity.appViewMode !== "panes") {
      activity.setAppViewMode("panes");
    }
    saveCliPrefs(draft);
    useDialogStore.getState().setPendingLaunch(finalLaunch);
    useDialogStore.getState().closeLauncher();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) =>
        submitting ? undefined : next ? useDialogStore.getState().openLauncher(context ?? undefined) : useDialogStore.getState().closeLauncher()
      }
    >
      <DialogContent className="launcher-dialog rounded-3xl border-[var(--app-border)] bg-[var(--app-content)] p-5 sm:max-w-2xl sm:p-6">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base font-medium">
            <Rocket className="h-4 w-4" style={{ color: "var(--app-accent)" }} />
            {t("title")}
          </DialogTitle>
        </DialogHeader>

        {/* 默认只有三件事：在哪里 / 用什么 / 要做什么；其余收进「高级」 */}
        <fieldset disabled={submitting} className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto pr-1">
          <Field label={t("sectionWhere")}>
            <LauncherProjectPicker
              value={draft.source}
              autoSelectRecent={!context?.workspaceName}
              onChange={(source) => patch({ source, worktree: undefined })}
            />
          </Field>

          <Field label={t("sectionAgent")}>
            <LauncherCliRow
              value={draft.cliTool}
              onChange={(cliTool) => patch(cliSwitchPatch(cliTool))}
              yolo={draft.yolo === true}
              onYoloChange={(yolo) => patch({ yolo: yolo ? true : undefined })}
            />
          </Field>

          <Field label={t("sectionTask")}>
            <textarea
              rows={3}
              className="w-full resize-none rounded-xl border border-[var(--app-border)] bg-[var(--app-sidebar)] px-3 py-2.5 text-[length:var(--text-body)] leading-relaxed outline-none placeholder:text-[var(--app-text-tertiary)] focus:border-[var(--app-accent)]"
              placeholder={t("taskPlaceholder")}
              value={draft.initialPrompt}
              onChange={(event) => patch({ initialPrompt: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void handleLaunch();
                }
              }}
              aria-label={t("initialPrompt")}
            />
          </Field>

          <LauncherAdvanced
            summary={advancedSummary}
            environment={
              <LauncherWorktreeRow
                draft={draft}
                onChange={patch}
                projectPath={resolvedProjectPath}
                isLocal={localEnvironment}
                disabled={submitting}
                environment={resolvedEnvironment}
                environmentLocked={Boolean(sshProject)}
              />
            }
            scenario={<LauncherScenarioRow draft={draft} onChange={patch} />}
            options={
              <div className="rounded-xl border border-[var(--app-border)] bg-[var(--app-sidebar)] p-3 [&_textarea]:min-h-20 [&_textarea]:rounded-lg [&_textarea]:bg-[var(--app-content)]">
                <LauncherChips draft={draft} onChange={patch} />
              </div>
            }
            injection={<LauncherInjectionRow draft={draft} onChange={patch} projectPath={resolvedProjectPath} />}
            layout={
              <LauncherLayoutRow
                value={draft.targetLayoutId}
                onChange={(targetLayoutId) => patch({ targetLayoutId })}
                workspaceName={resolvedWorkspaceName}
              />
            }
            preview={
              <LauncherArgsPreview
                input={{
                  cliTool: draft.cliTool,
                  skipMcp: draft.skipMcp,
                  appendSystemPrompt: draft.appendSystemPrompt,
                  initialPrompt: draft.initialPrompt,
                  yolo: YOLO_INHERENT_CLI_TOOLS.has(draft.cliTool) ? undefined : draft.yolo,
                  adapterOptions: buildAdapterOptions(draft),
                }}
              />
            }
          />

          {error && (
            <div className="text-[length:var(--text-small)]" style={{ color: "var(--app-status-danger)" }}>
              {error}
            </div>
          )}
        </fieldset>

        <DialogFooter className="items-center border-t border-[var(--app-border)] pt-4">
          {/* 启动按钮为什么是灰的：直接写出来 */}
          {!draft.source && (
            <span className="text-[length:var(--text-small)] text-[var(--app-text-tertiary)] sm:mr-auto" data-testid="launcher-blocked-reason">
              {t("needProjectHint")}
            </span>
          )}
          <Button variant="outline" disabled={submitting} onClick={() => useDialogStore.getState().closeLauncher()}>
            {t("cancel")}
          </Button>
          <Button className="rounded-full px-5" onClick={() => void handleLaunch()} disabled={!draft.source || submitting}>
            {submitting && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            {submitting ? t("launching") : t("launch")}
            {!submitting && <ArrowUp className="ml-1.5 h-4 w-4" />}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
