// 空态直达：列最近启动记录（项目 + 上次的 CLI/打开方式），单击按原方式重开；
// 行尾 ⌄ 菜单：「仅打开终端」置顶，其余为该项目历史上真实用过的打开方式
//（按 CLI×运行环境去重，含 WSL/SSH 标注），没用过的 CLI 兜底给通用项。
// 启动统一走 useDialogStore.pendingLaunch 全局通道（App 级 useOpenTerminal 消费），
// 不在 Panel 内挂 useOpenTerminal——那会导致 pendingLaunch 双消费。
import { useEffect, useState } from "react";
import { ChevronDown, Rocket } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useDialogStore, usePanesStore, useSshMachinesStore, useWorkspacesStore } from "@/stores";
import { historyService, type LaunchRecord } from "@/services";
import { buildLaunchRecordTerminalOptions, formatRelativeTime } from "@/utils";
import { getLayoutWorkspaceBinding } from "@/utils/layoutWorkspace";
import WorkspaceEmptyActions from "./WorkspaceEmptyActions";
import {
  CliIcon,
  ICON_TILE_CLASS,
  LIST_ROW_CLASS,
  RuntimeBadge,
  SECTION_HEADING_CLASS,
  type EmptyStateDensity,
} from "./emptyStateShared";
import type { CliTool, Panel as PanelType } from "@/types";

const MAX_RECENT = 5;
const MAX_METHODS = 4;
const HISTORY_FETCH = 60;

// 按项目路径去重（保留最新一条）
export function pickRecentLaunches(records: LaunchRecord[], max = MAX_RECENT): LaunchRecord[] {
  const seen = new Set<string>();
  const result: LaunchRecord[] = [];
  for (const record of records) {
    const key = record.projectPath.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(record);
    if (result.length >= max) break;
  }
  return result;
}

// 该项目历史上用过的打开方式：按 CLI×运行环境 去重（不含纯终端——菜单里已有置顶项）
export function pickProjectMethods(
  records: LaunchRecord[],
  projectPath: string,
  max = MAX_METHODS,
): LaunchRecord[] {
  const target = projectPath.toLowerCase();
  const seen = new Set<string>();
  const result: LaunchRecord[] = [];
  for (const record of records) {
    if (record.projectPath.toLowerCase() !== target) continue;
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

export default function PanelEmptyActions({
  pane,
  density = "full",
}: {
  pane?: PanelType;
  density?: EmptyStateDensity;
} = {}) {
  const { t } = useTranslation("panes");
  const [allRecords, setAllRecords] = useState<LaunchRecord[]>([]);
  const currentLayoutId = usePanesStore((s) => s.currentLayoutId);
  const layouts = usePanesStore((s) => s.layouts);
  const liveRootPane = usePanesStore((s) => s.rootPane);
  const workspaces = useWorkspacesStore((s) => s.workspaces);

  useEffect(() => {
    let disposed = false;
    const load = () =>
      historyService
        .list(HISTORY_FETCH)
        .then((list) => {
          if (!disposed) setAllRecords(list);
        })
        .catch(() => {
          /* 历史不可用时空态保持极简，不报错 */
        });
    load();
    window.addEventListener("cc-panes:history-updated", load);
    return () => {
      disposed = true;
      window.removeEventListener("cc-panes:history-updated", load);
    };
  }, []);

  // 当前布局有工作空间绑定（manual/derived）且工作空间存在 → 换成绑定空态大按钮组
  const currentLayout = layouts.find((layout) => layout.id === currentLayoutId);
  const binding = currentLayout && currentLayout.kind !== "starred"
    ? getLayoutWorkspaceBinding({
        workspaceName: currentLayout.workspaceName,
        // 当前布局的活树在 store 工作副本上（layout.rootPane 可能是旧引用）
        rootPane: liveRootPane,
      })
    : null;
  const boundWorkspace = binding
    ? workspaces.find((workspace) => workspace.name === binding.workspaceName)
    : undefined;

  if (boundWorkspace) {
    return (
      <WorkspaceEmptyActions
        workspace={boundWorkspace}
        records={allRecords}
        pane={pane}
        density={density}
      />
    );
  }

  // 窄窗格里列太多条会顶出容器，跟着密度收
  const records = pickRecentLaunches(allRecords, density === "full" ? MAX_RECENT : 3);

  function launch(record: LaunchRecord, cliToolOverride?: CliTool) {
    // 复用启动历史的还原逻辑（含 WSL distro / SSH 机器解析）；
    // pendingLaunch 通道不支持 resume，这里始终开全新会话（不带 resumeId）。
    const options = buildLaunchRecordTerminalOptions(
      record,
      useWorkspacesStore.getState().workspaces,
      useSshMachinesStore.getState().machines,
    );
    useDialogStore.getState().setPendingLaunch({
      path: options.path,
      workspaceName: options.workspaceName,
      workspacePath: options.workspacePath,
      providerId: options.providerId ?? "",
      providerSelection: options.providerSelection ?? "inherit",
      launchProfileId: options.launchProfileId,
      cliTool: cliToolOverride ?? (options.cliTool as CliTool | undefined),
      ssh: options.ssh,
      wsl: options.wsl,
      machineName: options.machineName,
    });
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

  const compact = density !== "full";

  const customLaunchButton = (
    <button
      type="button"
      className="flex items-center gap-1.5 self-start rounded-md px-2.5 py-1.5 text-xs text-[var(--app-text-tertiary)] transition-colors duration-[var(--dur-fast)] hover:bg-[var(--app-hover)] hover:text-[var(--app-text-primary)]"
      onClick={() =>
        useDialogStore.getState().openLauncher({
          workspaceName: binding?.workspaceName,
          targetLayoutId: currentLayoutId,
        })
      }
    >
      <Rocket className="size-3.5" aria-hidden="true" />
      {t("customLaunch", { ns: "launcher" })}
    </button>
  );

  return (
    <div className="flex w-full min-w-0 flex-col gap-7">
      {density !== "mini" && (
        <header className="min-w-0">
          <h1 className={`truncate font-semibold text-[var(--app-text-primary)] ${compact ? "text-base" : "text-xl"}`}>
            {t("ready")}
          </h1>
          <p className="mt-1 text-xs leading-relaxed text-[var(--app-text-tertiary)]">{t("selectProject")}</p>
        </header>
      )}

      {records.length > 0 && (
        <section aria-labelledby="panel-empty-recent-heading">
          <h2 id="panel-empty-recent-heading" className={SECTION_HEADING_CLASS}>{t("recentLaunches")}</h2>
          <div className="flex flex-col gap-0.5">
            {records.map((record) => {
              const methods = pickProjectMethods(allRecords, record.projectPath);
              const historyClis = new Set(methods.map((m) => m.cliTool));
              return (
                <div key={record.id} className="group relative flex min-w-0 items-center rounded-lg transition-colors duration-[var(--dur-fast)] hover:bg-[var(--app-hover)]">
                  <button
                    type="button"
                    className={`${LIST_ROW_CLASS} flex-1 hover:bg-transparent`}
                    title={record.projectPath}
                    aria-label={t("recentLaunchAria", { name: record.projectName })}
                    onClick={() => launch(record)}
                  >
                    <span className={`${ICON_TILE_CLASS} size-8`}>
                      <CliIcon cliTool={record.cliTool} className="size-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate text-sm text-[var(--app-text-primary)]">{record.projectName}</span>
                        <RuntimeBadge runtimeKind={record.runtimeKind} />
                      </span>
                      {/* 路径最先被挤爆，窄窗格里不显示 */}
                      {!compact && (
                        <span className="block truncate font-mono text-xs text-[var(--app-text-tertiary)]">{record.projectPath}</span>
                      )}
                    </span>
                    {!compact && (
                      <span className="shrink-0 text-xs tabular-nums text-[var(--app-text-tertiary)]">
                        {formatRelativeTime(record.launchedAt)}
                      </span>
                    )}
                  </button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        aria-label={t("recentLaunchChoose")}
                        className="mr-1.5 flex size-7 shrink-0 items-center justify-center rounded-md text-[var(--app-text-tertiary)] transition-colors duration-[var(--dur-fast)] hover:bg-[var(--app-active-bg)] hover:text-[var(--app-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]"
                      >
                        <ChevronDown className="size-3.5" aria-hidden="true" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="min-w-[200px]">
                      {/* 终端置顶 */}
                      <DropdownMenuItem
                        className="flex items-center gap-2 text-[length:var(--text-row)]"
                        onSelect={() => launch(record, "none")}
                      >
                        <CliIcon cliTool="none" className="size-3.5" />
                        {t("recentLaunchTerminalOnly")}
                      </DropdownMenuItem>
                      {(methods.length > 0 || !historyClis.has("claude") || !historyClis.has("codex")) && (
                        <DropdownMenuSeparator />
                      )}
                      {/* 该项目历史上用过的打开方式（按原记录完整还原环境） */}
                      {methods.map((method) => (
                        <DropdownMenuItem
                          key={`${method.cliTool}|${method.runtimeKind}`}
                          className="flex items-center gap-2 text-[length:var(--text-row)]"
                          onSelect={() => launch(method)}
                        >
                          <CliIcon cliTool={method.cliTool} className="size-3.5" />
                          <span className="flex-1">{methodLabel(method)}</span>
                          <span className="text-[length:var(--text-micro)] text-[var(--app-text-tertiary)]">
                            {formatRelativeTime(method.launchedAt)}
                          </span>
                        </DropdownMenuItem>
                      ))}
                      {/* 历史里没用过的 CLI 兜底 */}
                      {(["claude", "codex"] as const).filter((cli) => !historyClis.has(cli)).map((cli) => (
                        <DropdownMenuItem
                          key={cli}
                          className="flex items-center gap-2 text-[length:var(--text-row)]"
                          onSelect={() => launch(record, cli)}
                        >
                          <CliIcon cliTool={cli} className="size-3.5" />
                          {cli === "claude" ? t("recentLaunchWithClaude") : t("recentLaunchWithCodex")}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {customLaunchButton}
    </div>
  );
}
