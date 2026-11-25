// Explorer「任务」模式：不按工作空间，只按「轮到谁动」排的跨工作空间任务面板（参考 T3 Code）。
//   等你处理（出错 / 等输入 / 跑完未看）→ 进行中（可折叠）→ 已结束（默认折叠）
// 「看过」的判据沿用注意标记：标签一可见即清，任务自动沉到已结束（useTabAttentionWiring）。
// 卡片复用工作空间树的 SessionCard；右上角时间在这里是「进入当前状态多久」（等了 / 跑了多久）。
// 启动入口：顶部「新任务 ⌄」（主按钮 = 启动器，⌄ = 最近项目 × 打开方式），
// 卡片右键 = 树里同款菜单 + 「在此项目新开 ▸」（打开方式与空态最近启动共用 launchMethods）。
// 只在本模式激活时订阅 panes/status，隐藏时零开销（ExplorerView 对它 keep-alive）。
import { useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, SquarePen } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import { CliIcon } from "@/components/panes/emptyStateShared";
import { LaunchMethodItems, latestLaunchFor, pickRecentLaunches } from "@/components/panes/launchMethods";
import { historyService, type LaunchRecord } from "@/services";
import { handleErrorSilent } from "@/utils";
import WorkspaceTerminalRowMenu from "./WorkspaceTerminalRowMenu";
import { focusTab } from "@/hooks/useFocusTab";
import { useFirstPromptIndex } from "@/hooks/useFirstPromptIndex";
import { findPane } from "@/lib/paneTree";
import { statusLabelKey } from "@/lib/statusPresentation";
import { useDialogStore, usePanesStore, useWorkspacesStore } from "@/stores";
import { useTabAttentionStore } from "@/stores/useTabAttentionStore";
import { useStatusSinceStore } from "@/stores/useStatusSinceStore";
import { useTerminalStatusStore } from "@/stores/useTerminalStatusStore";
import { asTabId } from "@/types/ids";
import { startVisibleInterval } from "@/utils/visibleInterval";
import SessionCard from "./SessionCard";
import type { StatusGlyphAppearance } from "./SessionStatusGlyph";
import { resolveSessionTitle } from "./sessionCardModel";
import { useAgentChatRowIndex } from "./useAgentChatRowIndex";
import { collectLayoutAgentChatTabs, collectLayoutResumeIds, collectTerminalRows } from "./workspaceTerminals";
import { groupTasks, type TaskItem, type TaskKind } from "./taskBoardGroups";

const TICK_MS = 30_000;
const HISTORY_FETCH = 60;
const NO_CHAT_TABS: { id: string; agentEngineId?: string }[] = [];

/** 「等你处理」三种的图标外观；其余按实时状态画（与工作空间树一致）。 */
const NEEDS_YOU_APPEARANCE: Partial<Record<TaskKind, StatusGlyphAppearance>> = {
  error: { colorToken: "var(--app-status-danger)", shape: "triangle", filled: true },
  waiting: { colorToken: "var(--app-status-warning)", shape: "diamond", filled: true },
  done: { colorToken: "var(--app-status-success)", shape: "circle", filled: true },
};

/** ↑/↓/Home/End 在卡片间移动焦点（同 WorkspaceTerminalList）。 */
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

/** 重命名：标签只在当前布局里可改，先聚焦过去（同 WorkspaceTerminalList）。 */
function renameTab(tabId: string, title: string) {
  if (!focusTab(asTabId(tabId))) return;
  const store = usePanesStore.getState();
  const location = store.findTabAcrossLayouts(tabId);
  if (location) store.renameTab(location.panel.id, tabId, title);
}

/** 启动历史（激活时拉取，history-updated 时刷新）；失败保持空，不报错。 */
function useLaunchHistory(enabled: boolean): LaunchRecord[] {
  const [records, setRecords] = useState<LaunchRecord[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    const load = () =>
      historyService
        .list(HISTORY_FETCH)
        .then((list) => { if (!disposed) setRecords(list); })
        .catch((error) => handleErrorSilent(error, "TaskBoardView.history"));
    load();
    window.addEventListener("cc-panes:history-updated", load);
    return () => {
      disposed = true;
      window.removeEventListener("cc-panes:history-updated", load);
    };
  }, [enabled]);
  return records;
}

interface TaskBoardViewProps {
  active: boolean;
}

export default function TaskBoardView({ active }: TaskBoardViewProps) {
  const { t } = useTranslation(["sidebar", "dialogs"]);
  const layouts = usePanesStore((s) => (active ? s.layouts : null));
  const rootPane = usePanesStore((s) => (active ? s.rootPane : null));
  const currentLayoutId = usePanesStore((s) => s.currentLayoutId);
  const activeTabId = usePanesStore((s) => {
    if (!active) return null;
    const pane = findPane(s.rootPane, s.activePaneId);
    return pane?.type === "panel" ? pane.activeTabId : null;
  });
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const statusMap = useTerminalStatusStore((s) => (active ? s.statusMap : null));
  const attention = useTabAttentionStore((s) => s.entries);
  const since = useStatusSinceStore((s) => s.since);

  const layoutSlice = useMemo(
    () => (layouts && rootPane ? { layouts, rootPane, currentLayoutId } : null),
    [layouts, rootPane, currentLayoutId],
  );
  const resumeIds = useMemo(() => (layoutSlice ? collectLayoutResumeIds(layoutSlice) : []), [layoutSlice]);
  const firstPrompts = useFirstPromptIndex(active, resumeIds);
  const chatTabs = useMemo(
    () => (layoutSlice ? collectLayoutAgentChatTabs(layoutSlice) : NO_CHAT_TABS),
    [layoutSlice],
  );
  const agentChats = useAgentChatRowIndex(chatTabs);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    return startVisibleInterval(() => setNow(Date.now()), TICK_MS);
  }, [active]);

  const records = useLaunchHistory(active);
  const [editing, setEditing] = useState<{ tabId: string; value: string } | null>(null);
  const [workingOpen, setWorkingOpen] = useState(true);
  const [settledOpen, setSettledOpen] = useState(false);

  const groups = useMemo(() => {
    if (!layoutSlice || !statusMap) return null;
    const rows = collectTerminalRows(layoutSlice, workspaces, statusMap, firstPrompts, agentChats);
    return groupTasks(rows, attention, since);
  }, [layoutSlice, workspaces, statusMap, firstPrompts, agentChats, attention, since]);

  if (!groups) return null;

  const total = groups.needsYou.length + groups.working.length + groups.settled.length;
  const workspaceNameOf = (id: string | null) => (id ? workspaces.find((ws) => ws.id === id)?.name : undefined);

  const renderCard = (item: TaskItem) => {
    const name = resolveSessionTitle(item).text;
    if (editing?.tabId === item.tabId) {
      const commit = () => {
        const value = editing.value.trim();
        if (value && value !== name) renameTab(item.tabId, value);
        setEditing(null);
      };
      return (
        <input
          key={item.tabId}
          autoFocus
          aria-label={t("sidebar:terminalRowMenu.rename")}
          value={editing.value}
          onChange={(event) => setEditing({ tabId: item.tabId, value: event.target.value })}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit();
            if (event.key === "Escape") setEditing(null);
          }}
          className="w-full rounded-md border border-[var(--app-accent)] bg-[var(--app-input-bg)] px-2 py-1 text-[length:var(--text-row)] text-[var(--app-text-primary)] outline-none"
        />
      );
    }
    let statusLabel: string;
    if (item.taskKind === "error" || item.taskKind === "waiting" || item.taskKind === "done") {
      statusLabel = t(`sidebar:taskBoard.kind.${item.taskKind}` as never);
    } else {
      const key = statusLabelKey(item.status);
      statusLabel = key ? t(`dialogs:${key}` as never) : "";
    }
    // 等你处理 / 进行中：显示「进入该状态多久」；已结束：显示最近活动
    const time = item.taskKind !== "settled" && item.since !== null ? item.since : item.lastActivityAt;
    const tooltip = [
      name,
      item.sessionTitle && !item.titleRenamed && item.firstPrompt !== name ? item.firstPrompt : null,
      name !== item.title ? item.title : null,
      item.taskKind === "working" ? item.toolName : null,
    ].filter(Boolean).join("\n");
    const launchRecord = item.projectPath ? latestLaunchFor(records, item.projectPath) : null;
    const newHere = (
      <ContextMenuSub>
        <ContextMenuSubTrigger>
          <SquarePen /> {t("sidebar:taskBoard.newHere")}
        </ContextMenuSubTrigger>
        <ContextMenuSubContent className="min-w-[200px]">
          {launchRecord ? (
            <LaunchMethodItems record={launchRecord} records={records} Item={ContextMenuItem} Separator={ContextMenuSeparator} />
          ) : (
            // 没有启动记录（如 Agent 对话、从未经启动器开过的路径）：带上下文打开启动器选 CLI
            <ContextMenuItem
              onSelect={() =>
                useDialogStore.getState().openLauncher({
                  ...(item.projectPath ? { projectPath: item.projectPath } : {}),
                  ...(workspaceNameOf(item.workspaceId) ? { workspaceName: workspaceNameOf(item.workspaceId) } : {}),
                })
              }
            >
              {t("sidebar:taskBoard.openLauncher")}
            </ContextMenuItem>
          )}
        </ContextMenuSubContent>
      </ContextMenuSub>
    );
    return (
      <WorkspaceTerminalRowMenu
        key={item.tabId}
        tabId={item.tabId}
        onRename={() => setEditing({ tabId: item.tabId, value: name })}
        leadingItems={newHere}
      >
      <SessionCard
        title={name}
        projectName={item.projectName}
        status={item.status}
        statusLabel={statusLabel}
        statusAppearance={NEEDS_YOU_APPEARANCE[item.taskKind]}
        engines={item.engines}
        lastActivityAt={time}
        now={now}
        active={item.tabId === activeTabId}
        pinned={item.pinned}
        sessionCount={item.sessionCount}
        tooltip={tooltip}
        aria-label={[name, item.projectName, statusLabel].filter(Boolean).join(" · ")}
        data-kind={item.kind}
        data-task-kind={item.taskKind}
        className={item.taskKind === "settled" ? "opacity-70" : undefined}
        onClick={() => focusTab(asTabId(item.tabId))}
      />
      </WorkspaceTerminalRowMenu>
    );
  };

  return (
    <div className="flex flex-col gap-3 px-3 pb-3 pt-1" onKeyDown={moveCardFocus}>
      <NewTaskButton records={records} />

      {total === 0 ? (
        <div className="px-2 py-1.5 text-xs" style={{ color: "var(--app-text-tertiary)" }}>
          {t("sidebar:taskBoard.empty")}
        </div>
      ) : (
      <>
      <TaskGroup label={t("sidebar:taskBoard.needsYou")} count={groups.needsYou.length}>
        {groups.needsYou.length > 0 ? (
          groups.needsYou.map(renderCard)
        ) : (
          <div className="px-2 py-1.5 text-xs" style={{ color: "var(--app-text-tertiary)" }}>
            {t("sidebar:taskBoard.allClear")}
          </div>
        )}
      </TaskGroup>

      {groups.working.length > 0 && (
        <TaskGroup
          label={t("sidebar:taskBoard.working")}
          count={groups.working.length}
          open={workingOpen}
          onToggle={() => setWorkingOpen((v) => !v)}
        >
          {groups.working.map(renderCard)}
        </TaskGroup>
      )}

      {groups.settled.length > 0 && (
        <TaskGroup
          label={t("sidebar:taskBoard.settled")}
          count={groups.settled.length}
          open={settledOpen}
          onToggle={() => setSettledOpen((v) => !v)}
        >
          {groups.settled.map(renderCard)}
        </TaskGroup>
      )}
      </>
      )}
    </div>
  );
}

/**
 * 「新任务」split button：主按钮打开启动器（启动器里本就能选 CLI / 环境）；
 * ⌄ 列最近启动过的项目，悬停展开该项目的打开方式（同空态「最近启动」卡片的 ⌄）。
 */
function NewTaskButton({ records }: { records: LaunchRecord[] }) {
  const { t } = useTranslation("sidebar");
  const recent = pickRecentLaunches(records);
  const openLauncher = () => useDialogStore.getState().openLauncher();
  return (
    <div className="flex items-stretch rounded-md transition-colors hover:bg-[var(--app-hover)]">
      <button
        type="button"
        onClick={openLauncher}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-l-md px-2 py-1.5 text-left text-[length:var(--text-row)] text-[var(--app-text-secondary)] transition-colors hover:text-[var(--app-text-primary)]"
      >
        <SquarePen className="size-4 shrink-0" strokeWidth={1.6} />
        <span className="truncate">{t("taskBoard.newTask")}</span>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={t("taskBoard.newTaskChoose")}
            className="flex items-center rounded-r-md px-1.5 text-[var(--app-text-tertiary)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-text-primary)]"
          >
            <ChevronDown className="size-3.5" strokeWidth={1.8} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[220px]">
          <DropdownMenuItem className="flex items-center gap-2 text-[length:var(--text-row)]" onSelect={openLauncher}>
            <SquarePen className="h-3.5 w-3.5" style={{ color: "var(--app-text-tertiary)" }} />
            {t("taskBoard.openLauncher")}
          </DropdownMenuItem>
          {recent.length > 0 && <DropdownMenuSeparator />}
          {recent.map((record) => (
            <DropdownMenuSub key={record.id}>
              <DropdownMenuSubTrigger className="flex items-center gap-2 text-[length:var(--text-row)]">
                <CliIcon cliTool={record.cliTool} className="h-3.5 w-3.5" />
                <span className="min-w-0 flex-1 truncate" title={record.projectPath}>{record.projectName}</span>
                {record.runtimeKind && record.runtimeKind !== "local" && (
                  <span className="text-[length:var(--text-micro)]" style={{ color: "var(--app-text-tertiary)" }}>
                    {record.runtimeKind.toUpperCase()}
                  </span>
                )}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="min-w-[200px]">
                <LaunchMethodItems record={record} records={records} Item={DropdownMenuItem} Separator={DropdownMenuSeparator} />
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

interface TaskGroupProps {
  label: string;
  count: number;
  /** 不传 onToggle = 不可折叠 */
  open?: boolean;
  onToggle?: () => void;
  children: ReactNode;
}

function TaskGroup({ label, count, open = true, onToggle, children }: TaskGroupProps) {
  const Chevron = open ? ChevronDown : ChevronRight;
  const header = (
    <>
      <span className="text-[length:var(--text-caption)] font-medium">{label}</span>
      <span className="ml-auto text-[length:var(--text-caption)] tabular-nums">{count}</span>
      {onToggle && <Chevron className="size-3.5 shrink-0" strokeWidth={1.8} />}
    </>
  );
  return (
    <section className="flex flex-col gap-0.5">
      {onToggle ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-left text-[var(--app-text-tertiary)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-text-secondary)]"
        >
          {header}
        </button>
      ) : (
        <div className="flex items-center gap-1.5 px-2 py-1 text-[var(--app-text-tertiary)]">{header}</div>
      )}
      {open && children}
    </section>
  );
}
