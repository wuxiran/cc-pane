// 工作空间树「终端模式」的展开体：该工作空间下运行中的终端列表。
// 左=tab 标题，右=状态点+状态词（色+文字冗余，docs/46 §9）；点击聚焦对应 tab。
import { useTranslation } from "react-i18next";
import { TerminalSquare } from "lucide-react";
import StatusIndicator from "@/components/StatusIndicator";
import { focusTab } from "@/hooks/useFocusTab";
import { useDialogStore } from "@/stores";
import type { WorkspaceTerminalRow } from "./workspaceTerminals";
import type { TerminalStatusType } from "@/types";

interface Props {
  workspaceName: string;
  rows: WorkspaceTerminalRow[];
}

const STATUS_LABEL_KEYS: Partial<Record<TerminalStatusType, string>> = {
  initializing: "statusInitializing",
  idle: "statusIdle",
  thinking: "statusThinking",
  toolRunning: "statusToolRunning",
  compacting: "statusCompacting",
  waitingInput: "statusWaitingInput",
  error: "statusError",
  exited: "statusExited",
  active: "statusActive",
};

const STATUS_TEXT_COLORS: Partial<Record<TerminalStatusType, string>> = {
  waitingInput: "var(--app-status-warning)",
  error: "var(--app-status-danger)",
};

export default function WorkspaceTerminalList({ workspaceName, rows }: Props) {
  const { t } = useTranslation(["sidebar", "dialogs"]);

  if (rows.length === 0) {
    return (
      <div className="flex items-center gap-2 px-6 pb-3 pt-2 text-xs" style={{ color: "var(--app-text-tertiary)" }}>
        <span>{t("sidebar:noRunningTerminals")}</span>
        <button
          type="button"
          className="shrink-0 rounded px-1.5 py-0.5 transition-colors hover:bg-[var(--app-hover)]"
          style={{ color: "var(--app-accent)" }}
          onClick={() => useDialogStore.getState().openLauncher({ workspaceName })}
        >
          {t("sidebar:launchTerminal")}
        </button>
      </div>
    );
  }

  return (
    // 容器 padding 对齐 ProjectListView（px-3 pb-3 pt-2），行缩进与项目行一致
    <div className="flex flex-col gap-1 px-3 pb-3 pt-2">
      {rows.map((row) => {
        const labelKey = row.status ? STATUS_LABEL_KEYS[row.status] : undefined;
        const statusLabel = labelKey ? t(`dialogs:${labelKey}` as never) : "";
        return (
          <button
            key={row.tabId}
            type="button"
            className="flex w-full cursor-pointer items-center gap-2 rounded-xl border border-transparent px-3 py-2 text-left transition-colors duration-[var(--dur-fast)] text-[var(--app-text-secondary)] hover:border-[var(--app-border)] hover:bg-[var(--app-hover)] hover:text-[var(--app-text-primary)]"
            onClick={() => focusTab(row.tabId)}
          >
            <TerminalSquare size={15} className="shrink-0" style={{ color: "var(--app-accent)" }} />
            {/* 首条输入优先作行名（用户记的是「让它干什么」而非项目名），原 title 降为次行 */}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px]">
                {row.firstPrompt ?? row.title}
              </span>
              {row.firstPrompt && (
                <span className="block truncate text-[11px]" style={{ color: "var(--app-text-tertiary)" }}>
                  {row.title}
                </span>
              )}
            </span>
            {row.sessionCount > 1 && (
              <span className="shrink-0 text-[10px]" style={{ color: "var(--app-text-tertiary)" }}>
                {t("sidebar:terminalSplitCount", { count: row.sessionCount })}
              </span>
            )}
            {statusLabel && (
              <span
                className="shrink-0 text-[11px]"
                style={{ color: (row.status && STATUS_TEXT_COLORS[row.status]) || "var(--app-text-tertiary)" }}
              >
                {statusLabel}
              </span>
            )}
            <StatusIndicator status={row.status} toolName={row.toolName} size={7} />
          </button>
        );
      })}
    </div>
  );
}
