// 工作空间树的展开体：该工作空间下运行中的会话（终端 + Agent 对话）卡片列表。
// 两行卡片（SessionCard）：项目头像/项目名/状态/相对时间 + 会话标题/用过的引擎。
// 状态用形状+颜色+状态词三重冗余（docs/46 §9）；原 tab 标题与首条提问收进 tooltip。
// 点击聚焦对应 tab；↑/↓ 在卡片间移动焦点；当前布局里激活的 tab 用浮起底色。
import { useEffect, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { focusTab } from "@/hooks/useFocusTab";
import { findPane } from "@/lib/paneTree";
import { statusLabelKey } from "@/lib/statusPresentation";
import { useDialogStore, usePanesStore } from "@/stores";
import { asTabId } from "@/types/ids";
import { startVisibleInterval } from "@/utils/visibleInterval";
import SessionCard from "./SessionCard";
import { resolveSessionTitle } from "./sessionCardModel";
import type { WorkspaceTerminalRow } from "./workspaceTerminals";
import WorkspaceTerminalRowMenu from "./WorkspaceTerminalRowMenu";

interface Props {
  workspaceName: string;
  rows: WorkspaceTerminalRow[];
}

const RELATIVE_TIME_TICK_MS = 30_000;

/** 行名：手动重命名 > 提炼标题 > 首条提问 > 标签标题（用户记的是「让它干什么」而非项目名） */
export function terminalRowName(row: WorkspaceTerminalRow): string {
  return resolveSessionTitle(row).text;
}

/** 相对时间的节拍：页面可见时每 30s 刷一次。 */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => startVisibleInterval(() => setNow(Date.now()), RELATIVE_TIME_TICK_MS), []);
  return now;
}

/** ↑/↓/Home/End 在同一列表的卡片间移动焦点（Enter/Space 由原生 button 处理）。 */
function moveCardFocus(event: KeyboardEvent<HTMLDivElement>) {
  const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
  if (!keys.includes(event.key)) return;
  const cards = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-session-card]")];
  const index = cards.indexOf(document.activeElement as HTMLButtonElement);
  if (index < 0 || cards.length === 0) return;
  event.preventDefault();
  const next = event.key === "Home" ? 0
    : event.key === "End" ? cards.length - 1
      : Math.min(cards.length - 1, Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)));
  cards[next]?.focus();
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
  const now = useNow();
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
    <div className="flex flex-col gap-0.5 pb-1.5 pt-0.5" onKeyDown={moveCardFocus}>
      {[...rows].sort((a, b) => Number(b.pinned) - Number(a.pinned)).map((row) => {
        const labelKey = statusLabelKey(row.status);
        const statusLabel = labelKey ? t(`dialogs:${labelKey}` as never) : "";
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
          name,
          row.sessionTitle && !row.titleRenamed && row.firstPrompt !== name ? row.firstPrompt : null,
          name !== row.title ? row.title : null,
        ].filter(Boolean).join("\n");
        return (
          <WorkspaceTerminalRowMenu
            key={row.tabId}
            tabId={row.tabId}
            onRename={() => setEditing({ tabId: row.tabId, value: name })}
          >
            <SessionCard
              title={name}
              projectName={row.projectName}
              status={row.status}
              statusLabel={statusLabel}
              engines={row.engines}
              lastActivityAt={row.lastActivityAt}
              now={now}
              active={active}
              pinned={row.pinned}
              sessionCount={row.sessionCount}
              tooltip={tooltip}
              aria-label={[name, row.projectName, statusLabel].filter(Boolean).join(" · ")}
              data-kind={row.kind}
              onClick={() => focusTab(asTabId(row.tabId))}
            />
          </WorkspaceTerminalRowMenu>
        );
      })}
    </div>
  );
}
