// 空态直达：列最近启动记录（项目 + 上次的 CLI/打开方式），单击按原方式重开；
// 行尾 ⌄ 菜单：「仅打开终端」置顶，其余为该项目历史上真实用过的打开方式
//（按 CLI×运行环境去重，含 WSL/SSH 标注），没用过的 CLI 兜底给通用项。
// 启动统一走 useDialogStore.pendingLaunch 全局通道（App 级 useOpenTerminal 消费），
// 不在 Panel 内挂 useOpenTerminal——那会导致 pendingLaunch 双消费。
import { useEffect, useState } from "react";
import { Bot, ChevronDown, Clock, Play, Rocket, Sparkles, Terminal } from "lucide-react";
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
import type { CliTool } from "@/types";

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

export default function PanelEmptyActions() {
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
    return <WorkspaceEmptyActions workspace={boundWorkspace} records={allRecords} />;
  }

  const records = pickRecentLaunches(allRecords);

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

  const customLaunchButton = (
    <button
      type="button"
      className="mt-1 flex items-center gap-1.5 self-start text-[11.5px] transition-colors duration-[var(--dur-fast)] hover:text-[var(--app-accent)]"
      style={{ color: "var(--app-text-tertiary)" }}
      onClick={() =>
        useDialogStore.getState().openLauncher({
          workspaceName: binding?.workspaceName,
          targetLayoutId: currentLayoutId,
        })
      }
    >
      <Rocket className="h-3.5 w-3.5" />
      {t("customLaunch", { ns: "launcher" })}
    </button>
  );

  if (records.length === 0) {
    return (
      <div className="relative mt-8 flex w-full max-w-xl flex-col gap-2 px-6">
        {customLaunchButton}
      </div>
    );
  }

  return (
    <div className="relative mt-8 flex w-full max-w-xl flex-col gap-2 px-6">
      <div
        className="mb-1.5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.09em]"
        style={{ color: "var(--app-text-tertiary)" }}
      >
        <Clock className="h-3.5 w-3.5" />
        {t("recentLaunches")}
      </div>
      {records.map((record) => {
        const methods = pickProjectMethods(allRecords, record.projectPath);
        const historyClis = new Set(methods.map((m) => m.cliTool));
        return (
          <div
            key={record.id}
            className="group flex cursor-pointer items-center gap-3.5 rounded-xl border px-4 py-3 transition-colors duration-[var(--dur-fast)] hover:bg-[var(--app-hover)] hover:border-[var(--app-accent)]"
            style={{ borderColor: "var(--app-border)", background: "var(--app-hover)" }}
            onClick={() => launch(record)}
            role="button"
            aria-label={t("recentLaunchAria", { name: record.projectName })}
          >
            <span
              className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl"
              style={iconTileStyle(record.cliTool)}
            >
              <CliIcon cliTool={record.cliTool} className="h-[18px] w-[18px]" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span
                  className="truncate text-[14px] font-semibold"
                  style={{ color: "var(--app-text-primary)" }}
                >
                  {record.projectName}
                </span>
                {record.runtimeKind === "wsl" && (
                  <span
                    className="flex-shrink-0 rounded px-1.5 py-px text-[9.5px] font-semibold"
                    style={{ background: "color-mix(in srgb, var(--app-identity-wsl) 16%, transparent)", color: "var(--app-identity-wsl)" }}
                  >
                    WSL
                  </span>
                )}
                {record.runtimeKind === "ssh" && (
                  <span
                    className="flex-shrink-0 rounded px-1.5 py-px text-[9.5px] font-semibold"
                    style={{ background: "color-mix(in srgb, var(--app-identity-ssh) 16%, transparent)", color: "var(--app-identity-ssh)" }}
                  >
                    SSH
                  </span>
                )}
              </div>
              <div
                className="mt-0.5 truncate text-[11.5px]"
                style={{ color: "var(--app-text-tertiary)", fontFamily: "var(--font-mono, monospace)" }}
              >
                {record.projectPath}
              </div>
            </div>
            <span className="flex-shrink-0 text-[11.5px] tabular-nums" style={{ color: "var(--app-text-tertiary)" }}>
              {formatRelativeTime(record.launchedAt)}
            </span>
            {/* 显式 split button：主按钮「▷ 启动」（=整行点击语义）+ 紧贴「⌄」打开方式菜单 */}
            <div
              className="flex flex-shrink-0 items-stretch"
              onClick={(event) => event.stopPropagation()}
            >
              <button
                type="button"
                className="flex items-center gap-1.5 rounded-l-md px-2.5 py-1.5 text-[11.5px] font-semibold transition-opacity duration-[var(--dur-fast)] hover:opacity-90"
                style={{ background: "var(--app-accent)", color: "var(--primary-foreground)" }}
                onClick={() => launch(record)}
              >
                <Play className="h-3 w-3" fill="currentColor" />
                {t("launchNow")}
              </button>
              <div
                aria-hidden
                style={{
                  width: 1,
                  background: "color-mix(in srgb, var(--primary-foreground) 25%, var(--app-accent))",
                }}
              />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label={t("recentLaunchChoose")}
                    className="flex items-center rounded-r-md px-1.5 transition-opacity duration-[var(--dur-fast)] hover:opacity-90"
                    style={{ background: "var(--app-accent)", color: "var(--primary-foreground)" }}
                  >
                    <ChevronDown className="h-3.5 w-3.5" />
                  </button>
                </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[200px]">
                {/* 终端置顶 */}
                <DropdownMenuItem
                  className="flex items-center gap-2 text-[12.5px]"
                  onSelect={() => launch(record, "none")}
                >
                  <Terminal className="h-3.5 w-3.5" style={{ color: "var(--app-text-tertiary)" }} />
                  {t("recentLaunchTerminalOnly")}
                </DropdownMenuItem>
                {(methods.length > 0 || !historyClis.has("claude") || !historyClis.has("codex")) && (
                  <DropdownMenuSeparator />
                )}
                {/* 该项目历史上用过的打开方式（按原记录完整还原环境） */}
                {methods.map((method) => (
                  <DropdownMenuItem
                    key={`${method.cliTool}|${method.runtimeKind}`}
                    className="flex items-center gap-2 text-[12.5px]"
                    onSelect={() => launch(method)}
                  >
                    <CliIcon
                      cliTool={method.cliTool}
                      className="h-3.5 w-3.5"
                    />
                    <span className="flex-1">{methodLabel(method)}</span>
                    <span className="text-[10.5px]" style={{ color: "var(--app-text-tertiary)" }}>
                      {formatRelativeTime(method.launchedAt)}
                    </span>
                  </DropdownMenuItem>
                ))}
                {/* 历史里没用过的 CLI 兜底 */}
                {!historyClis.has("claude") && (
                  <DropdownMenuItem
                    className="flex items-center gap-2 text-[12.5px]"
                    onSelect={() => launch(record, "claude")}
                  >
                    <Sparkles className="h-3.5 w-3.5" style={{ color: "var(--app-accent)" }} />
                    {t("recentLaunchWithClaude")}
                  </DropdownMenuItem>
                )}
                {!historyClis.has("codex") && (
                  <DropdownMenuItem
                    className="flex items-center gap-2 text-[12.5px]"
                    onSelect={() => launch(record, "codex")}
                  >
                    <Bot className="h-3.5 w-3.5" style={{ color: "var(--app-status-success)" }} />
                    {t("recentLaunchWithCodex")}
                  </DropdownMenuItem>
                )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        );
      })}
    </div>
  );
}
