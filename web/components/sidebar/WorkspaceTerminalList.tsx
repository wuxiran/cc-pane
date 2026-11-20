// 工作空间树「终端模式」的展开体：该工作空间下运行中的终端列表。
// 单行：左=首条输入（或 tab 标题），右=状态点；原 tab 标题与状态词收进 tooltip / aria-label。
// 只有需要人介入的状态（waitingInput / error）常显状态词，保留色+文字冗余（docs/46 §9）。
// 点击聚焦对应 tab；当前布局里激活的 tab 带胶囊背景。
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pin } from "lucide-react";
import StatusIndicator from "@/components/StatusIndicator";
import { focusTab } from "@/hooks/useFocusTab";
import { findPane } from "@/lib/paneTree";
import { DEFAULT_STATUS_COLOR_TOKEN, statusColorToken, statusLabelKey } from "@/lib/statusPresentation";
import { useDialogStore, usePanesStore } from "@/stores";
import type { TerminalStatusType } from "@/types";
import { asTabId } from "@/types/ids";
import type { WorkspaceTerminalRow } from "./workspaceTerminals";
import WorkspaceTerminalRowMenu from "./WorkspaceTerminalRowMenu";

interface Props {
  workspaceName: string;
  rows: WorkspaceTerminalRow[];
}

const ATTENTION_STATUSES: ReadonlySet<TerminalStatusType> = new Set(["waitingInput", "error"]);

/** 行名：手动重命名 > CLI 自己起的标题 > 首条输入 > 标签标题（用户记的是「让它干什么」而非项目名） */
export function terminalRowName(row: WorkspaceTerminalRow): string {
  if (row.titleRenamed) return row.title;
  return row.sessionTitle ?? row.firstPrompt ?? row.title;
}

/** 重命名：标签只在当前布局里可改，先聚焦过去。 */
function renameRow(tabId: string, title: string) {
  if (!focusTab(asTabId(tabId))) return;
  const store = usePanesStore.getState();
  const location = store.findTabAcrossLayouts(tabId);
  if (location) store.renameTab(location.panel.id, tabId, title);
}

export default function WorkspaceTerminalList({ workspaceName, rows }: Props) {
  const { t } = useTranslation(["sidebar", "dialogs"]);
  const [editing, setEditing] = useState<{ tabId: string; value: string } | null>(null);
  const activeTabId = usePanesStore((s) => {
    const pane = findPane(s.rootPane, s.activePaneId);
    return pane?.type === "panel" ? pane.activeTabId : null;
  });

  if (rows.length === 0) {
    return (
      <div className="flex items-center gap-2 px-3 pb-2 pt-1 text-xs" style={{ color: "var(--app-text-tertiary)" }}>
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
    <div className="flex flex-col gap-px pb-1.5 pt-0.5">
      {[...rows].sort((a, b) => Number(b.pinned) - Number(a.pinned)).map((row) => {
        const labelKey = statusLabelKey(row.status);
        const statusLabel = labelKey ? t(`dialogs:${labelKey}` as never) : "";
        const needsAttention = row.status != null && ATTENTION_STATUSES.has(row.status);
        const active = row.tabId === activeTabId;
        const name = terminalRowName(row);
        if (editing?.tabId === row.tabId) {
          const commit = () => {
            const value = editing.value.trim();
            if (value && value !== name) renameRow(row.tabId, value);
            setEditing(null);
          };
          return (
            <input
              key={row.tabId}
              autoFocus
              aria-label={t("sidebar:terminalRowMenu.rename")}
              value={editing.value}
              onChange={(event) => setEditing({ tabId: row.tabId, value: event.target.value })}
              onBlur={commit}
              onKeyDown={(event) => {
                if (event.key === "Enter") commit();
                if (event.key === "Escape") setEditing(null);
              }}
              className="w-full rounded-md border border-[var(--app-accent)] bg-[var(--app-input-bg)] px-2 py-1 text-[length:var(--text-row)] text-[var(--app-text-primary)] outline-none"
            />
          );
        }
        const tooltip = [
          row.sessionTitle && !row.titleRenamed ? row.firstPrompt : null,
          name !== row.title ? row.title : null,
          statusLabel || null,
        ].filter(Boolean).join(" · ");
        return (
          <WorkspaceTerminalRowMenu
            key={row.tabId}
            tabId={row.tabId}
            onRename={() => setEditing({ tabId: row.tabId, value: name })}
          >
          <button
            type="button"
            title={tooltip || undefined}
            aria-label={statusLabel ? `${name} ${statusLabel}` : name}
            className={`flex w-full cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors duration-[var(--dur-fast)] ${
              active
                ? "bg-[var(--app-hover)] text-[var(--app-text-primary)]"
                : "text-[var(--app-text-secondary)] hover:bg-[var(--app-hover)] hover:text-[var(--app-text-primary)]"
            }`}
            onClick={() => focusTab(asTabId(row.tabId))}
          >
            {row.pinned && (
              <Pin className="size-3 shrink-0 text-[var(--app-text-tertiary)]" aria-hidden="true" />
            )}
            <span className="min-w-0 flex-1 truncate text-[length:var(--text-row)]">{name}</span>
            {row.sessionCount > 1 && (
              <span className="shrink-0 text-[length:var(--text-micro)]" style={{ color: "var(--app-text-tertiary)" }}>
                {t("sidebar:terminalSplitCount", { count: row.sessionCount })}
              </span>
            )}
            {needsAttention && statusLabel && (
              <span
                className="shrink-0 text-[length:var(--text-caption)]"
                style={{ color: row.status ? statusColorToken(row.status) : DEFAULT_STATUS_COLOR_TOKEN }}
              >
                {statusLabel}
              </span>
            )}
            <StatusIndicator
              status={row.status}
              toolName={row.toolName}
              oscProgress={row.oscProgress}
              size={7}
            />
          </button>
          </WorkspaceTerminalRowMenu>
        );
      })}
    </div>
  );
}
