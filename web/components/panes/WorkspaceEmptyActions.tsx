// 绑定工作空间布局的空态：项目标题 + 「开始」胶囊（与新标签页同一组件）+
// 该工作空间启动历史里**胶囊覆盖不到**的打开方式（WSL / SSH / 运行配置 / 指定供应商）。
// 启动统一走 resolveWorkspaceProjectLaunchOptions + useDialogStore.pendingLaunch
// 全局通道（App 级 useOpenTerminal 消费）——禁止在 Panel 内挂 useOpenTerminal，
// 会导致 pendingLaunch 双消费。
import { useMemo } from "react";
import "@/i18n/newTabPageResources";
import { useTranslation } from "react-i18next";
import { toast } from "@/components/ui/toast";
import { useDialogStore, usePanesStore, useSshMachinesStore, useWorkspacesStore } from "@/stores";
import type { LaunchRecord } from "@/services";
import { buildLaunchRecordTerminalOptions, formatRelativeTime } from "@/utils";
import { projectPathsEquivalent } from "@/utils/projectIdentity";
import { resolveWorkspaceProjectLaunchOptions } from "@/utils/workspaceLaunch";
import NewTabStartSection from "./NewTabStartSection";
import { SIDEBAR_LAUNCH_CLI_TOOLS } from "@/components/sidebar/launchMenu";
import {
  CliIcon,
  ICON_TILE_CLASS,
  LIST_ROW_CLASS,
  RuntimeBadge,
  SECTION_HEADING_CLASS,
  type EmptyStateDensity,
} from "./emptyStateShared";
import type { CliTool, OpenTerminalOptions, Panel as PanelType, Workspace } from "@/types";

const MAX_METHODS = 4;

/** 该工作空间历史上用过的打开方式：按 workspaceName 过滤、CLI×运行环境去重（不含纯终端） */
export function pickWorkspaceMethods(
  records: LaunchRecord[],
  workspaceName: string,
  max = MAX_METHODS,
): LaunchRecord[] {
  const seen = new Set<string>();
  const result: LaunchRecord[] = [];
  for (const record of records) {
    if (record.workspaceName !== workspaceName) continue;
    const cli = record.cliTool ?? "none";
    if (cli === "none") continue;
    const key = `${cli}|${record.runtimeKind ?? "local"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(record);
    if (result.length >= max) break;
  }
  return result;
}

/** 本地、无运行配置、无指定供应商的记录和「开始」里的胶囊等价，不必再列一遍。 */
export function isDistinctLaunchMethod(record: LaunchRecord): boolean {
  return (record.runtimeKind ?? "local") !== "local"
    || Boolean(record.launchProfileId)
    || Boolean(record.providerId)
    || Boolean(record.providerAccountId);
}

/**
 * 本窗格里其它标签指向的项目——分屏出来的空窗格通常紧挨着一个正在干活的标签，
 * 那个标签的项目远比侧边栏的全局选中项贴近用户意图。
 * 路径比较必须过 projectPathsEquivalent：注册路径可能存成 `/mnt/d/x` 或
 * `\\wsl.localhost\...`，字符串直接比会把同一个项目判成两个。
 */
export function pickPaneContextProject(
  workspace: Workspace,
  pane?: PanelType,
): Workspace["projects"][number] | undefined {
  if (!pane) return undefined;
  for (const tab of pane.tabs) {
    if (tab.contentType !== "terminal" || !tab.projectPath) continue;
    const hit = workspace.projects.find((project) =>
      projectPathsEquivalent(project.path, tab.projectPath),
    );
    if (hit) return hit;
  }
  return undefined;
}

export default function WorkspaceEmptyActions({
  workspace,
  records,
  pane,
  density = "full",
}: {
  workspace: Workspace;
  records: LaunchRecord[];
  pane?: PanelType;
  density?: EmptyStateDensity;
}) {
  const { t } = useTranslation(["panes", "sidebar"]);
  const expandedProjectId = useWorkspacesStore((s) => s.expandedProjectId);
  const machines = useSshMachinesStore((s) => s.machines);
  const setPendingLaunch = useDialogStore((s) => s.setPendingLaunch);

  // 目标项目：本窗格上下文 > 该工作空间当前选中项 > 第一个项目
  const targetProject =
    pickPaneContextProject(workspace, pane)
    ?? workspace.projects.find((project) => project.id === expandedProjectId)
    ?? workspace.projects[0];

  const methods = useMemo(
    () => pickWorkspaceMethods(records, workspace.name).filter(isDistinctLaunchMethod),
    [records, workspace.name],
  );

  if (!targetProject) return null;

  const projectLabel =
    targetProject.alias || targetProject.path.split(/[/\\]/).pop() || targetProject.path;
  const workspaceLabel = workspace.alias || workspace.name;

  function dispatch(options: OpenTerminalOptions | null) {
    if (!options) {
      toast.error(t("workspaceEmptyLaunchFailed"));
      return;
    }
    setPendingLaunch({
      path: options.path,
      workspaceName: options.workspaceName,
      workspacePath: options.workspacePath,
      providerId: options.providerId ?? "",
      providerSelection: options.providerSelection ?? "inherit",
      launchProfileId: options.launchProfileId,
      cliTool: options.cliTool,
      ssh: options.ssh,
      wsl: options.wsl,
      machineName: options.machineName,
    });
  }

  function launchFixed(cliTool: CliTool) {
    const { options } = resolveWorkspaceProjectLaunchOptions({
      workspace,
      project: targetProject,
      cliTool,
      machines,
    });
    dispatch(options);
  }

  function launchMethod(record: LaunchRecord) {
    // 复用启动历史的环境还原（WSL distro / SSH 机器）；空态始终开全新会话，不 resume
    const options = buildLaunchRecordTerminalOptions(
      record,
      useWorkspacesStore.getState().workspaces,
      machines,
    );
    dispatch({ ...options, resumeId: undefined });
  }

  function cliLabel(cliTool?: string): string {
    const known = SIDEBAR_LAUNCH_CLI_TOOLS.find((tool) => tool.id === cliTool);
    return known ? t(known.labelKey as never, { ns: "sidebar" }) : (cliTool ?? "");
  }

  const compact = density !== "full";
  // 窄窗格里只留两条，免得把胶囊顶出视野
  const shownMethods = compact ? methods.slice(0, 2) : methods;

  return (
    <div data-testid="workspace-empty-actions" data-density={density} className="flex w-full min-w-0 flex-col gap-7">
      {density !== "mini" && (
        <header className="min-w-0">
          <h1
            className={`truncate font-semibold text-[var(--app-text-primary)] ${compact ? "text-base" : "text-xl"}`}
            title={targetProject.path}
          >
            {projectLabel}
          </h1>
          <p className="mt-1 truncate text-xs text-[var(--app-text-tertiary)]" title={targetProject.path}>
            {workspaceLabel} · {targetProject.path}
          </p>
        </header>
      )}

      <NewTabStartSection
        onLaunchCli={(cliTool) => launchFixed(cliTool as CliTool)}
        onTerminal={() => launchFixed("none")}
        onAgentChat={() =>
          usePanesStore.getState().openAgentChat(targetProject.path, pane ? { paneId: pane.id } : undefined)
        }
        onMore={() =>
          useDialogStore.getState().openLauncher({
            workspaceName: workspace.name,
            projectPath: targetProject.path,
            targetLayoutId: usePanesStore.getState().currentLayoutId,
          })
        }
      />

      {shownMethods.length > 0 && (
        <section aria-labelledby="workspace-empty-recent-heading">
          <h2 id="workspace-empty-recent-heading" className={SECTION_HEADING_CLASS}>
            {t("workspaceEmptyFrequent")}
          </h2>
          <div className={compact ? "flex flex-col gap-1" : "grid grid-cols-2 gap-1"}>
            {shownMethods.map((method) => (
              <button
                key={`${method.cliTool}|${method.runtimeKind ?? "local"}`}
                type="button"
                className={LIST_ROW_CLASS}
                onClick={() => launchMethod(method)}
              >
                <span className={`${ICON_TILE_CLASS} size-8`}>
                  <CliIcon cliTool={method.cliTool} className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate text-sm text-[var(--app-text-primary)]">{cliLabel(method.cliTool)}</span>
                    <RuntimeBadge runtimeKind={method.runtimeKind} />
                  </span>
                  <span className="block truncate text-xs tabular-nums text-[var(--app-text-tertiary)]">
                    {formatRelativeTime(method.launchedAt)}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
