// 全局启动器弹窗（App 级唯一挂载）。提交动作 = setPendingLaunch(buildPendingLaunch(draft))
// + closeLauncher；pendingLaunch 由 App 级 useOpenTerminal 统一消费——
// 禁止在本 Dialog 内挂 useOpenTerminal（会双消费）。
import { useEffect, useMemo, useState } from "react";
import { Loader2, Rocket } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
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
  useSshMachinesStore,
  useWorkspacesStore,
} from "@/stores";
import { worktreeService } from "@/services";
import { translateError } from "@/utils";
import LauncherProjectPicker from "./LauncherProjectPicker";
import LauncherCliRow from "./LauncherCliRow";
import LauncherEnvRow from "./LauncherEnvRow";
import LauncherScenarioRow from "./LauncherScenarioRow";
import LauncherChips from "./LauncherChips";
import LauncherInjectionRow from "./LauncherInjectionRow";
import LauncherProviderRow from "./LauncherProviderRow";
import LauncherWorktreeRow from "./LauncherWorktreeRow";
import LauncherLayoutRow from "./LauncherLayoutRow";
// 文件名带 View 后缀：Windows 大小写不敏感，避免与纯函数 launcherArgsPreview.ts 解析冲突
import LauncherArgsPreview from "./LauncherArgsPreviewView";
import {
  buildAdapterOptions,
  buildPendingLaunch,
  createDefaultDraft,
  defaultWorktreeBranch,
  isDraftLocalEnvironment,
  resolveDraftProjectPath,
  worktreeNameFromBranch,
  type LauncherDraft,
} from "./launcherModel";

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div
        className="text-[10.5px] font-semibold uppercase tracking-[0.09em]"
        style={{ color: "var(--app-text-tertiary)" }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}

export default function LauncherDialog() {
  const { t } = useTranslation("launcher");
  const open = useDialogStore((s) => s.launcherOpen);
  const context = useDialogStore((s) => s.launcherContext);
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const [draft, setDraft] = useState<LauncherDraft>(() => createDefaultDraft());
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // 每次打开按入口上下文重置草稿（workspaceName / projectPath / targetLayoutId 预选）
  useEffect(() => {
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
    setDraft(
      createDefaultDraft({
        source:
          ctxWorkspace && ctxProject
            ? { kind: "workspace", workspaceId: ctxWorkspace.id, projectId: ctxProject.id }
            : null,
        targetLayoutId: context?.targetLayoutId,
      }),
    );
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

  async function handleLaunch() {
    if (submitting) return;
    const { launch, issue } = buildPendingLaunch(draft, {
      workspaces,
      machines: useSshMachinesStore.getState().machines,
    });
    if (!launch) {
      setError(
        issue?.code === "no_project" ? t("errorNoProject") : t("errorResolveFailed", { code: issue?.code }),
      );
      return;
    }

    let finalLaunch = launch;
    // worktree 开启：先建 worktree，用返回路径替换启动路径；
    // workspaceName/workspacePath 不变 → 布局绑定推导仍命中原工作空间。
    if (draft.worktree?.enabled && localEnvironment) {
      const branch = draft.worktree.branch.trim() || defaultWorktreeBranch();
      setSubmitting(true);
      try {
        const worktreePath = await worktreeService.add(
          launch.path,
          worktreeNameFromBranch(branch),
          branch,
        );
        finalLaunch = { ...launch, path: worktreePath };
      } catch (e) {
        toast.error(t("worktreeCreateFailed", { message: translateError(e) }));
        setSubmitting(false);
        return;
      }
      setSubmitting(false);
    }

    // 非 panes 视图先切回，让消费方落位可见
    const activity = useActivityBarStore.getState();
    if (activity.appViewMode !== "panes") {
      activity.setAppViewMode("panes");
    }
    useDialogStore.getState().setPendingLaunch(finalLaunch);
    useDialogStore.getState().closeLauncher();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) =>
        next ? useDialogStore.getState().openLauncher(context ?? undefined) : useDialogStore.getState().closeLauncher()
      }
    >
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Rocket className="h-4 w-4" style={{ color: "var(--app-accent)" }} />
            {t("title")}
          </DialogTitle>
        </DialogHeader>

        <div className="flex max-h-[65vh] flex-col gap-4 overflow-y-auto pr-1">
          <Section label={t("sectionProject")}>
            <LauncherProjectPicker
              value={draft.source}
              onChange={(source) => patch({ source })}
            />
          </Section>

          <Section label={t("sectionCli")}>
            <LauncherCliRow value={draft.cliTool} onChange={(cliTool) => patch({ cliTool })} />
          </Section>

          <Section label={t("sectionEnvironment")}>
            <LauncherEnvRow
              value={draft.source?.kind === "manual" ? "local" : draft.environment}
              onChange={(environment) => patch({ environment })}
              disabled={draft.source?.kind === "manual"}
            />
          </Section>

          <Section label={t("sectionScenario")}>
            <LauncherScenarioRow draft={draft} onChange={patch} />
          </Section>

          <Section label={t("sectionOptions")}>
            <LauncherChips draft={draft} onChange={patch} />
          </Section>

          <Section label={t("sectionInjection")}>
            <LauncherInjectionRow
              draft={draft}
              onChange={patch}
              projectPath={resolvedProjectPath}
            />
          </Section>

          <Section label={t("sectionProvider")}>
            <LauncherProviderRow draft={draft} onChange={patch} />
          </Section>

          <Section label={t("sectionWorktree")}>
            <LauncherWorktreeRow
              draft={draft}
              onChange={patch}
              projectPath={resolvedProjectPath}
              isLocal={localEnvironment}
            />
          </Section>

          <Section label={t("sectionLayout")}>
            <LauncherLayoutRow
              value={draft.targetLayoutId}
              onChange={(targetLayoutId) => patch({ targetLayoutId })}
              workspaceName={resolvedWorkspaceName}
            />
          </Section>

          <LauncherArgsPreview
            input={{
              cliTool: draft.cliTool,
              skipMcp: draft.skipMcp,
              appendSystemPrompt: draft.appendSystemPrompt,
              initialPrompt: draft.initialPrompt,
              yolo: draft.yolo,
              adapterOptions: buildAdapterOptions(draft),
            }}
          />

          {error && (
            <div className="text-[11.5px]" style={{ color: "var(--app-status-error, #e5484d)" }}>
              {error}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => useDialogStore.getState().closeLauncher()}>
            {t("cancel")}
          </Button>
          <Button onClick={() => void handleLaunch()} disabled={!draft.source || submitting}>
            {submitting && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            {submitting ? t("launching") : t("launch")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
