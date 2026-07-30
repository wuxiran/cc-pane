// 绑定工作空间布局的空态大按钮组：仅终端 / Claude / Codex 固定三个 +
// 该工作空间启动历史里的常用组合（CLI×运行环境去重）。
// 启动统一走 resolveWorkspaceProjectLaunchOptions + useDialogStore.pendingLaunch
// 全局通道（App 级 useOpenTerminal 消费）——禁止在 Panel 内挂 useOpenTerminal，
// 会导致 pendingLaunch 双消费。
import { useMemo } from "react";
import { History, Rocket } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useDialogStore, usePanesStore, useSshMachinesStore, useWorkspacesStore } from "@/stores";
import type { LaunchRecord } from "@/services";
import { buildLaunchRecordTerminalOptions, formatRelativeTime } from "@/utils";
import { projectPathsEquivalent } from "@/utils/projectIdentity";
import { resolveWorkspaceProjectLaunchOptions } from "@/utils/workspaceLaunch";
import { CliIcon, iconTileStyle, type EmptyStateDensity } from "./emptyStateShared";
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
  const { t } = useTranslation("panes");
  const expandedProjectId = useWorkspacesStore((s) => s.expandedProjectId);
  const machines = useSshMachinesStore((s) => s.machines);
  const setPendingLaunch = useDialogStore((s) => s.setPendingLaunch);

  // 目标项目：本窗格上下文 > 该工作空间当前选中项 > 第一个项目
  const targetProject =
    pickPaneContextProject(workspace, pane)
    ?? workspace.projects.find((project) => project.id === expandedProjectId)
    ?? workspace.projects[0];

  const methods = useMemo(
    () => pickWorkspaceMethods(records, workspace.name),
    [records, workspace.name],
  );

  if (!targetProject) return null;

  const projectLabel =
    targetProject.alias || targetProject.path.split(/[/\\]/).pop() || targetProject.path;

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

  function methodLabel(record: LaunchRecord): string {
    const base =
      record.cliTool === "codex"
        ? t("recentLaunchWithCodex")
        : record.cliTool === "claude" || !record.cliTool
          ? t("recentLaunchWithClaude")
          : t("recentLaunchWithTool", { tool: record.cliTool });
    const runtime = record.runtimeKind ?? "local";
    return runtime === "local" ? base : `${base} · ${runtime.toUpperCase()}`;
  }

  const fixedActions: Array<{ cliTool: CliTool; label: string }> = [
    { cliTool: "none", label: t("workspaceEmptyTerminal") },
    { cliTool: "claude", label: "Claude Code" },
    { cliTool: "codex", label: "Codex" },
  ];

  const compact = density !== "full";
  const mini = density === "mini";
  // 窄窗格里 4 条常用方式两列排会挤爆，收成 2 条单列
  const shownMethods = compact ? methods.slice(0, 2) : methods;

  return (
    <div
      data-testid="workspace-empty-actions"
      data-density={density}
      className={
        mini
          ? "relative mt-3 flex w-full flex-col gap-1.5 px-2"
          : compact
            ? "relative mt-4 flex w-full flex-col gap-2 px-3"
            : "relative mt-8 flex w-full max-w-xl flex-col gap-3 px-6"
      }
    >
      {!mini && (
        <div className="flex flex-col gap-0.5">
          {!compact && (
            <div
              className="text-[11px] font-semibold uppercase tracking-[0.09em]"
              style={{ color: "var(--app-text-tertiary)" }}
            >
              {t("workspaceEmptyTitle", { name: workspace.alias || workspace.name })}
            </div>
          )}
          <div className="truncate text-[11.5px]" style={{ color: "var(--app-text-tertiary)" }}>
            {t("workspaceEmptyProjectHint", { name: projectLabel })}
          </div>
        </div>
      )}

      {/* full：三卡格子；窄档塌成命令行式单列（图标 / 标签），格子在窄容器里必挤爆 */}
      <div className={compact ? "flex flex-col gap-1" : "grid grid-cols-3 gap-2"}>
        {fixedActions.map((action) => (
          <button
            key={action.cliTool}
            type="button"
            title={mini ? action.label : undefined}
            className={
              compact
                ? "flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors duration-[var(--dur-fast)] hover:bg-[var(--app-hover)]"
                : "flex flex-col items-center gap-2 rounded-xl border px-3 py-4 transition-colors duration-[var(--dur-fast)] hover:bg-[var(--app-hover)] hover:border-[var(--app-accent)]"
            }
            style={
              compact
                ? undefined
                : { borderColor: "var(--app-border)", background: "var(--app-hover)" }
            }
            onClick={() => launchFixed(action.cliTool)}
          >
            <span
              className={`flex flex-shrink-0 items-center justify-center rounded-lg ${
                compact ? "h-6 w-6" : "h-10 w-10 rounded-xl"
              }`}
              style={iconTileStyle(action.cliTool)}
            >
              <CliIcon cliTool={action.cliTool} className={compact ? "h-3.5 w-3.5" : "h-[18px] w-[18px]"} />
            </span>
            {!mini && (
              <span
                className={`truncate font-semibold ${compact ? "flex-1 text-left text-[12px]" : "text-[12.5px]"}`}
                style={{ color: "var(--app-text-primary)" }}
              >
                {action.label}
              </span>
            )}
          </button>
        ))}
      </div>

      {shownMethods.length > 0 && (
        <>
          {!mini && (
            <div
              className="mt-1 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.09em]"
              style={{ color: "var(--app-text-tertiary)" }}
            >
              <History className="h-3.5 w-3.5" />
              {t("workspaceEmptyFrequent")}
            </div>
          )}
          <div className={compact ? "flex flex-col gap-1" : "grid grid-cols-2 gap-2"}>
            {shownMethods.map((method) => (
              <button
                key={`${method.cliTool}|${method.runtimeKind ?? "local"}`}
                type="button"
                title={mini ? methodLabel(method) : undefined}
                className={
                  compact
                    ? "flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors duration-[var(--dur-fast)] hover:bg-[var(--app-hover)]"
                    : "flex items-center gap-2.5 rounded-xl border px-3 py-2.5 transition-colors duration-[var(--dur-fast)] hover:bg-[var(--app-hover)] hover:border-[var(--app-accent)]"
                }
                style={
                  compact
                    ? undefined
                    : { borderColor: "var(--app-border)", background: "var(--app-hover)" }
                }
                onClick={() => launchMethod(method)}
              >
                <span
                  className={`flex flex-shrink-0 items-center justify-center rounded-lg ${
                    compact ? "h-6 w-6" : "h-8 w-8"
                  }`}
                  style={iconTileStyle(method.cliTool)}
                >
                  <CliIcon cliTool={method.cliTool} className={compact ? "h-3.5 w-3.5" : "h-4 w-4"} />
                </span>
                {!mini && (
                  <span className="min-w-0 flex-1 text-left">
                    <span
                      className="block truncate text-[12px] font-semibold"
                      style={{ color: "var(--app-text-primary)" }}
                    >
                      {methodLabel(method)}
                    </span>
                    {/* 时间戳是次要信息，窄档先砍 */}
                    {!compact && (
                      <span
                        className="block truncate text-[10.5px] tabular-nums"
                        style={{ color: "var(--app-text-tertiary)" }}
                      >
                        {formatRelativeTime(method.launchedAt)}
                      </span>
                    )}
                  </span>
                )}
              </button>
            ))}
          </div>
        </>
      )}

      <button
        type="button"
        className="mt-1 flex items-center gap-1.5 self-start text-[11.5px] transition-colors duration-[var(--dur-fast)] hover:text-[var(--app-accent)]"
        style={{ color: "var(--app-text-tertiary)" }}
        title={mini ? t("customLaunch", { ns: "launcher" }) : undefined}
        onClick={() =>
          useDialogStore.getState().openLauncher({
            workspaceName: workspace.name,
            targetLayoutId: usePanesStore.getState().currentLayoutId,
          })
        }
      >
        <Rocket className="h-3.5 w-3.5" />
        {!mini && t("customLaunch", { ns: "launcher" })}
      </button>
    </div>
  );
}
