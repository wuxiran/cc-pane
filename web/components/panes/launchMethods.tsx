// 「按指定方式打开项目」的共享逻辑与菜单项：空态最近启动卡片的 ⌄ 菜单、侧栏任务视图的
// 「新任务 ⌄」与卡片右键「在此项目新开」共用一份，加 CLI 时各入口自动同步。
//
// 菜单内容：「仅打开终端」置顶，其余为该项目历史上真实用过的打开方式（按 CLI×运行环境去重，
// 按原记录完整还原 WSL/SSH 环境），没用过的 Claude / Codex 兜底给通用项。
// 启动统一走 useDialogStore.pendingLaunch 全局通道（App 级 useOpenTerminal 消费），
// 调用方不要自己挂 useOpenTerminal——那会导致 pendingLaunch 双消费。
import type { ComponentType, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useDialogStore, useSshMachinesStore, useWorkspacesStore } from "@/stores";
import type { LaunchRecord } from "@/services";
import { buildLaunchRecordTerminalOptions, formatRelativeTime } from "@/utils";
import { CliIcon } from "./emptyStateShared";
import type { CliTool } from "@/types";

export const MAX_RECENT_LAUNCHES = 5;
const MAX_METHODS = 4;

// 按项目路径去重（保留最新一条）
export function pickRecentLaunches(records: LaunchRecord[], max = MAX_RECENT_LAUNCHES): LaunchRecord[] {
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

/** 该项目最近一条启动记录（大小写不敏感匹配路径）；没有则 null。 */
export function latestLaunchFor(records: LaunchRecord[], projectPath: string): LaunchRecord | null {
  const target = projectPath.toLowerCase();
  return records.find((record) => record.projectPath.toLowerCase() === target) ?? null;
}

/**
 * 按启动记录重开（复用启动历史的还原逻辑，含 WSL distro / SSH 机器解析）。
 * pendingLaunch 通道不支持 resume，这里始终开全新会话（不带 resumeId）。
 */
export function launchFromRecord(record: LaunchRecord, cliToolOverride?: CliTool): void {
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

/** DropdownMenuItem / ContextMenuItem 的公共形状 */
export type LaunchMenuItemComponent = ComponentType<{
  className?: string;
  onSelect?: (event: Event) => void;
  children?: ReactNode;
}>;

interface LaunchMethodItemsProps {
  /** 作为「仅终端 / Claude / Codex」兜底项基底的记录（通常是该项目最新一条） */
  record: LaunchRecord;
  /** 全部启动历史（从中挑该项目用过的方式） */
  records: LaunchRecord[];
  Item: LaunchMenuItemComponent;
  Separator: ComponentType;
}

/** 打开方式菜单项（不含菜单容器，放进 DropdownMenuContent / ContextMenuSubContent 都行）。 */
export function LaunchMethodItems({ record, records, Item, Separator }: LaunchMethodItemsProps) {
  const { t } = useTranslation("panes");
  const methods = pickProjectMethods(records, record.projectPath);
  const historyClis = new Set(methods.map((m) => m.cliTool));

  const methodLabel = (method: LaunchRecord): string => {
    const base =
      method.cliTool === "codex"
        ? t("recentLaunchWithCodex")
        : method.cliTool === "claude" || !method.cliTool
          ? t("recentLaunchWithClaude")
          : t("recentLaunchWithTool", { tool: method.cliTool });
    const runtime = method.runtimeKind ?? "local";
    return runtime === "local" ? base : `${base} · ${runtime.toUpperCase()}`;
  };

  return (
    <>
      {/* 终端置顶 */}
      <Item className="flex items-center gap-2 text-[length:var(--text-row)]" onSelect={() => launchFromRecord(record, "none")}>
        <CliIcon cliTool="none" className="h-3.5 w-3.5" />
        {t("recentLaunchTerminalOnly")}
      </Item>
      {(methods.length > 0 || !historyClis.has("claude") || !historyClis.has("codex")) && <Separator />}
      {/* 该项目历史上用过的打开方式（按原记录完整还原环境） */}
      {methods.map((method) => (
        <Item
          key={`${method.cliTool}|${method.runtimeKind}`}
          className="flex items-center gap-2 text-[length:var(--text-row)]"
          onSelect={() => launchFromRecord(method)}
        >
          <CliIcon cliTool={method.cliTool} className="h-3.5 w-3.5" />
          <span className="flex-1">{methodLabel(method)}</span>
          <span className="text-[length:var(--text-micro)]" style={{ color: "var(--app-text-tertiary)" }}>
            {formatRelativeTime(method.launchedAt)}
          </span>
        </Item>
      ))}
      {/* 历史里没用过的 CLI 兜底 */}
      {!historyClis.has("claude") && (
        <Item className="flex items-center gap-2 text-[length:var(--text-row)]" onSelect={() => launchFromRecord(record, "claude")}>
          <CliIcon cliTool="claude" className="h-3.5 w-3.5" />
          {t("recentLaunchWithClaude")}
        </Item>
      )}
      {!historyClis.has("codex") && (
        <Item className="flex items-center gap-2 text-[length:var(--text-row)]" onSelect={() => launchFromRecord(record, "codex")}>
          <CliIcon cliTool="codex" className="h-3.5 w-3.5" />
          {t("recentLaunchWithCodex")}
        </Item>
      )}
    </>
  );
}
