// 绑定工作空间布局的空态大按钮组：仅终端 / Claude / Codex 固定三个 +
// 该工作空间启动历史里的常用组合（CLI×运行环境去重）。
// 启动统一走 resolveWorkspaceProjectLaunchOptions + useDialogStore.pendingLaunch
// 全局通道（App 级 useOpenTerminal 消费）——禁止在 Panel 内挂 useOpenTerminal，
// 会导致 pendingLaunch 双消费。
import { useMemo } from "react";
import { Bot, History, Rocket, Sparkles, Terminal } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useDialogStore, usePanesStore, useSshMachinesStore, useWorkspacesStore } from "@/stores";
import type { LaunchRecord } from "@/services";
import { buildLaunchRecordTerminalOptions, formatRelativeTime } from "@/utils";
import { resolveWorkspaceProjectLaunchOptions } from "@/utils/workspaceLaunch";
import type { CliTool, OpenTerminalOptions, Workspace } from "@/types";

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

function CliIcon({ cliTool, className }: { cliTool?: string; className?: string }) {
  if (cliTool === "codex") return <Bot className={className} />;
  if (cliTool === "none" || !cliTool) return <Terminal className={className} />;
  return <Sparkles className={className} />;
}

function iconTileStyle(cliTool?: string): React.CSSProperties {
  if (cliTool === "codex") {
    return {
      background: "color-mix(in srgb, var(--app-status-success) 13%, transparent)",
      color: "var(--app-status-success)",
    };
  }
  if (cliTool === "none" || !cliTool) {
    return { background: "var(--app-hover)", color: "var(--app-text-tertiary)" };
  }
  return {
    background: "color-mix(in srgb, var(--app-accent) 13%, transparent)",
    color: "var(--app-accent)",
  };
}

export default function WorkspaceEmptyActions({
  workspace,
  records,
}: {
  workspace: Workspace;
  records: LaunchRecord[];
}) {
  const { t } = useTranslation("panes");
  const expandedProjectId = useWorkspacesStore((s) => s.expandedProjectId);
  const machines = useSshMachinesStore((s) => s.machines);
  const setPendingLaunch = useDialogStore((s) => s.setPendingLaunch);

  // 目标项目：该工作空间当前选中项，否则第一个项目
  const targetProject =
    workspace.projects.find((project) => project.id === expandedProjectId)
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

  return (
    <div className="relative mt-8 flex w-full max-w-xl flex-col gap-3 px-6">
      <div className="flex flex-col gap-0.5">
        <div
          className="text-[11px] font-semibold uppercase tracking-[0.09em]"
          style={{ color: "var(--app-text-tertiary)" }}
        >
          {t("workspaceEmptyTitle", { name: workspace.alias || workspace.name })}
        </div>
        <div className="text-[11.5px]" style={{ color: "var(--app-text-tertiary)" }}>
          {t("workspaceEmptyProjectHint", { name: projectLabel })}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2">
        {fixedActions.map((action) => (
          <button
            key={action.cliTool}
            type="button"
            className="flex flex-col items-center gap-2 rounded-xl border px-3 py-4 transition-colors duration-[var(--dur-fast)] hover:bg-[var(--app-hover)] hover:border-[var(--app-accent)]"
            style={{ borderColor: "var(--app-border)", background: "var(--app-hover)" }}
            onClick={() => launchFixed(action.cliTool)}
          >
            <span
              className="flex h-10 w-10 items-center justify-center rounded-xl"
              style={iconTileStyle(action.cliTool)}
            >
              <CliIcon cliTool={action.cliTool} className="h-[18px] w-[18px]" />
            </span>
            <span
              className="text-[12.5px] font-semibold"
              style={{ color: "var(--app-text-primary)" }}
            >
              {action.label}
            </span>
          </button>
        ))}
      </div>

      {methods.length > 0 && (
        <>
          <div
            className="mt-1 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.09em]"
            style={{ color: "var(--app-text-tertiary)" }}
          >
            <History className="h-3.5 w-3.5" />
            {t("workspaceEmptyFrequent")}
          </div>
          <div className="grid grid-cols-2 gap-2">
            {methods.map((method) => (
              <button
                key={`${method.cliTool}|${method.runtimeKind ?? "local"}`}
                type="button"
                className="flex items-center gap-2.5 rounded-xl border px-3 py-2.5 transition-colors duration-[var(--dur-fast)] hover:bg-[var(--app-hover)] hover:border-[var(--app-accent)]"
                style={{ borderColor: "var(--app-border)", background: "var(--app-hover)" }}
                onClick={() => launchMethod(method)}
              >
                <span
                  className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg"
                  style={iconTileStyle(method.cliTool)}
                >
                  <CliIcon cliTool={method.cliTool} className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1 text-left">
                  <span
                    className="block truncate text-[12px] font-semibold"
                    style={{ color: "var(--app-text-primary)" }}
                  >
                    {methodLabel(method)}
                  </span>
                  <span
                    className="block truncate text-[10.5px] tabular-nums"
                    style={{ color: "var(--app-text-tertiary)" }}
                  >
                    {formatRelativeTime(method.launchedAt)}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </>
      )}

      <button
        type="button"
        className="mt-1 flex items-center gap-1.5 self-start text-[11.5px] transition-colors duration-[var(--dur-fast)] hover:text-[var(--app-accent)]"
        style={{ color: "var(--app-text-tertiary)" }}
        onClick={() =>
          useDialogStore.getState().openLauncher({
            workspaceName: workspace.name,
            targetLayoutId: usePanesStore.getState().currentLayoutId,
          })
        }
      >
        <Rocket className="h-3.5 w-3.5" />
        {t("customLaunch", { ns: "launcher" })}
      </button>
    </div>
  );
}
