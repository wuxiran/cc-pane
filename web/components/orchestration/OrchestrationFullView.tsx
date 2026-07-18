import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useTranslation } from "react-i18next";
import {
  Bell,
  CheckCircle2,
  GripVertical,
  List,
  ListTree,
  PanelRightClose,
  PanelRightOpen,
  Search,
  Workflow,
  X,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";
import { IconTooltipButton } from "@/components/ui/IconTooltipButton";
import { TooltipProvider } from "@/components/ui/tooltip";
import OrchestratorTaskCard from "@/components/sidebar/OrchestratorTaskCard";
import OrchestratorTaskTree from "@/components/sidebar/OrchestratorTaskTree";
import { useActivityBarStore, useOrchestratorStore } from "@/stores";
import { useNotificationStore, type NotificationRecord } from "@/stores/useNotificationStore";
import type { TaskBinding } from "@/types";
import TaskDetailPanel from "./TaskDetailPanel";
import SessionOutputPreview from "./SessionOutputPreview";

type MainTab = "tasks" | "notifications";
type NotificationFilter = "all" | "errors" | "completed";
type OrchestrationFullViewProps = {
  variant?: "page" | "overlay";
  onClose?: () => void;
};
type TaskListProps = {
  bindings: TaskBinding[];
  selectedTaskId: string | null;
  onSelect: (id: string) => void;
};

const RIGHT_COLLAPSED_KEY = "cc-panes-orchestration-right-collapsed";
const RIGHT_WIDTH_KEY = "cc-panes-orchestration-right-width";
const DEFAULT_RIGHT_WIDTH = 400;
const MIN_RIGHT_WIDTH = 300;
const MAX_RIGHT_WIDTH = 640;

/** soft 激活态分段按钮：激活 = active-bg + accent 字，未激活 = 次级字 + hover 底 */
function segClass(active: boolean): string {
  return active
    ? "bg-[var(--app-active-bg)] text-[var(--app-accent)]"
    : "text-[var(--app-text-secondary)] hover:bg-[var(--app-hover)]";
}

function readRightCollapsed(): boolean {
  if (typeof window === "undefined") return false;
  const stored = window.sessionStorage.getItem(RIGHT_COLLAPSED_KEY);
  if (stored !== null) return stored === "true";
  // fix(H4) review: 右栏默认折叠阈值从 1360 下调到 1280。
  return window.innerWidth < 1280;
}

function readRightWidth(): number {
  if (typeof window === "undefined") return DEFAULT_RIGHT_WIDTH;
  const stored = Number(window.sessionStorage.getItem(RIGHT_WIDTH_KEY));
  return Number.isFinite(stored) ? Math.min(MAX_RIGHT_WIDTH, Math.max(MIN_RIGHT_WIDTH, stored)) : DEFAULT_RIGHT_WIDTH;
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function isErrorNotification(notification: NotificationRecord): boolean {
  const text = `${notification.kind} ${notification.title} ${notification.body ?? ""}`.toLowerCase();
  return text.includes("error") || text.includes("fail");
}

function isCompletedNotification(notification: NotificationRecord): boolean {
  const text = `${notification.kind} ${notification.title} ${notification.body ?? ""}`.toLowerCase();
  return text.includes("complete") || text.includes("completed") || text.includes("done") || text.includes("success");
}

function visibleNotifications(notifications: NotificationRecord[], filter: NotificationFilter): NotificationRecord[] {
  if (filter === "errors") return notifications.filter(isErrorNotification);
  if (filter === "completed") return notifications.filter(isCompletedNotification);
  return notifications;
}

function groupedNotifications(notifications: NotificationRecord[]) {
  const consumed = new Set<string>();
  return notifications.flatMap((latest) => {
    if (consumed.has(latest.id)) return [];
    const key = latest.groupKey ? `${latest.kind}:${latest.groupKey}` : latest.id;
    const group = notifications.filter((item) => {
      const itemKey = item.groupKey ? `${item.kind}:${item.groupKey}` : item.id;
      return itemKey === key && Math.abs(latest.timestamp - item.timestamp) <= 5000;
    });
    for (const item of group) consumed.add(item.id);
    return [{ key, latest, count: group.length }];
  });
}

function TaskList({ bindings, selectedTaskId, onSelect }: TaskListProps) {
  return (
    <div className="space-y-1">
      {bindings.map((binding) => {
        const selected = binding.id === selectedTaskId;
        return (
          <div
            key={binding.id}
            role="button"
            tabIndex={0}
            className="relative block w-full rounded-lg text-left transition-colors duration-[var(--dur-fast)]"
            style={{
              background: selected ? "var(--app-active-bg)" : "transparent",
            }}
            onClick={() => onSelect(binding.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelect(binding.id);
              }
            }}
          >
            {/* demo 式选中态：左缘 accent 竖条 + active-bg 弱底 */}
            {selected && (
              <span
                aria-hidden
                className="absolute left-0 top-1.5 bottom-1.5 z-10 w-[3px] rounded-full"
                style={{ background: "var(--app-accent)" }}
              />
            )}
            {/* fix(M3) review: 外层不再使用 button，避免 TaskCard 内部操作按钮嵌套。 */}
            <OrchestratorTaskCard binding={binding} />
          </div>
        );
      })}
    </div>
  );
}

export default function OrchestrationFullView({
  variant = "page",
  onClose,
}: OrchestrationFullViewProps) {
  const { t } = useTranslation("orchestration");
  const bindings = useOrchestratorStore((state) => state.bindings);
  const loading = useOrchestratorStore((state) => state.loading);
  const filterTab = useOrchestratorStore((state) => state.filterTab);
  const searchKeyword = useOrchestratorStore((state) => state.searchKeyword);
  const viewType = useOrchestratorStore((state) => state.viewType);
  const selectedTaskId = useOrchestratorStore((state) => state.selectedTaskId);
  const loadBindings = useOrchestratorStore((state) => state.loadBindings);
  const setFilterTab = useOrchestratorStore((state) => state.setFilterTab);
  const setSearchKeyword = useOrchestratorStore((state) => state.setSearchKeyword);
  const setViewType = useOrchestratorStore((state) => state.setViewType);
  const setSelectedTaskId = useOrchestratorStore((state) => state.setSelectedTaskId);
  const notifications = useNotificationStore((state) => state.notifications);
  const clearNotifications = useNotificationStore((state) => state.clear);

  const [mainTab, setMainTab] = useState<MainTab>("tasks");
  const [notificationFilter, setNotificationFilter] = useState<NotificationFilter>("all");
  const [rightCollapsed, setRightCollapsed] = useState(() =>
    variant === "overlay" ? true : readRightCollapsed()
  );
  const [rightWidth, setRightWidth] = useState(readRightWidth);
  const isOverlay = variant === "overlay";

  const close = useCallback(() => {
    if (onClose) {
      onClose();
      return;
    }
    useActivityBarStore.getState().closeOrchestrationOverlay();
  }, [onClose]);

  const groupTitle = useCallback(
    (count: number, latest: NotificationRecord): string => {
      if (count <= 1) return latest.title;
      if (isCompletedNotification(latest)) return t("tasksCompleted", { count, defaultValue: "{{count}} 个任务已完成" });
      if (isErrorNotification(latest)) return t("taskErrors", { count, defaultValue: "{{count}} 个任务出错" });
      return t("notificationsCount", { count, defaultValue: "{{count}} 条通知" });
    },
    [t]
  );

  useEffect(() => {
    void loadBindings({ limit: 100 });
  }, [loadBindings]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [close]);

  useEffect(() => {
    if (!selectedTaskId && bindings.length > 0) {
      setSelectedTaskId(bindings[0].id);
    }
  }, [bindings, selectedTaskId, setSelectedTaskId]);

  useEffect(() => {
    window.sessionStorage.setItem(RIGHT_COLLAPSED_KEY, String(rightCollapsed));
  }, [rightCollapsed]);

  useEffect(() => {
    window.sessionStorage.setItem(RIGHT_WIDTH_KEY, String(rightWidth));
  }, [rightWidth]);

  const selectedBinding = useMemo(
    () => bindings.find((binding) => binding.id === selectedTaskId) ?? null,
    [bindings, selectedTaskId]
  );
  const notificationGroups = useMemo(
    () => groupedNotifications(visibleNotifications(notifications, notificationFilter)),
    [notifications, notificationFilter]
  );

  const startResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (rightCollapsed) {
      setRightCollapsed(false);
      return;
    }
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = rightWidth;
    const onMove = (moveEvent: PointerEvent) => {
      const next = startWidth - (moveEvent.clientX - startX);
      setRightWidth(Math.min(MAX_RIGHT_WIDTH, Math.max(MIN_RIGHT_WIDTH, next)));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const jumpToNotificationTask = (notification: NotificationRecord) => {
    if (!notification.taskBindingId) return;
    setSelectedTaskId(notification.taskBindingId);
    setMainTab("tasks");
  };

  const taskTabs = [
    { key: "all" as const, label: t("filter.all", { defaultValue: "全部" }) },
    { key: "running" as const, label: t("filter.running", { defaultValue: "运行中" }) },
    { key: "completed" as const, label: t("filter.done", { defaultValue: "已完成" }) },
  ];
  const notificationTabs = [
    { key: "all" as const, label: t("filter.all", { defaultValue: "全部" }) },
    { key: "errors" as const, label: t("filter.errors", { defaultValue: "错误" }) },
    { key: "completed" as const, label: t("filter.done", { defaultValue: "已完成" }) },
  ];
  const mainTabs = [
    { key: "tasks" as const, label: t("tab.tasks", { defaultValue: "任务" }) },
    { key: "notifications" as const, label: t("tab.notifications", { defaultValue: "通知" }) },
  ];

  return (
    <TooltipProvider>
    <div
      className="flex h-full min-w-0 flex-col"
      style={{
        background: "var(--app-panel-bg)",
        borderRadius: isOverlay ? 8 : 0,
        overflow: "hidden",
      }}
    >
      <div className="flex h-12 shrink-0 items-center justify-between px-4" style={{ borderBottom: "1px solid var(--app-border)" }}>
        <div className="flex items-center gap-2">
          <span
            className="flex h-6 w-6 items-center justify-center rounded-md"
            style={{ background: "color-mix(in srgb, var(--app-accent) 14%, transparent)" }}
          >
            <Workflow className="h-3.5 w-3.5" strokeWidth={1.5} style={{ color: "var(--app-accent)" }} />
          </span>
          <span className="text-sm font-semibold" style={{ color: "var(--app-text-primary)" }}>
            {t("title", { defaultValue: "编排" })}
          </span>
          <div className="ml-3 flex rounded-md p-0.5" style={{ background: "var(--app-input-bg)" }}>
            {mainTabs.map((tab) => (
              <button
                key={tab.key}
                type="button"
                className={`rounded px-3 py-1 text-xs font-medium transition-colors duration-[var(--dur-fast)] ${segClass(mainTab === tab.key)}`}
                onClick={() => setMainTab(tab.key)}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>
        <IconTooltipButton
          label={isOverlay ? t("close", { defaultValue: "关闭" }) : t("exit", { defaultValue: "退出" })}
          onClick={close}
        >
          <X className="h-4 w-4" strokeWidth={1.5} />
        </IconTooltipButton>
      </div>

      <div className="flex min-h-0 flex-1">
        <aside
          className={`flex shrink-0 flex-col ${isOverlay ? "w-[320px]" : "w-[360px]"}`}
          style={{ borderRight: "1px solid var(--app-border)" }}
        >
          {mainTab === "tasks" ? (
            <>
              <div className="shrink-0 space-y-2 p-3" style={{ borderBottom: "1px solid var(--app-border)" }}>
                <div className="flex gap-1">
                  {taskTabs.map((tab) => (
                    <button
                      key={tab.key}
                      type="button"
                      className={`rounded-md px-2 py-1 text-xs transition-colors duration-[var(--dur-fast)] ${segClass(filterTab === tab.key)}`}
                      onClick={() => setFilterTab(tab.key)}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
                <label
                  className="flex h-8 items-center gap-2 rounded-md px-2 transition-colors duration-[var(--dur-fast)] focus-within:border-[var(--app-accent)]"
                  style={{ background: "var(--app-input-bg)", border: "1px solid var(--app-border)" }}
                >
                  <Search className="h-3.5 w-3.5" strokeWidth={1.5} style={{ color: "var(--app-text-tertiary)" }} />
                  <input
                    className="min-w-0 flex-1 bg-transparent text-xs outline-none"
                    value={searchKeyword}
                    onChange={(event) => setSearchKeyword(event.target.value)}
                    placeholder={t("searchPlaceholder", { defaultValue: "搜索任务" })}
                    style={{ color: "var(--app-text-primary)" }}
                  />
                </label>
                <div className="flex rounded-md p-0.5" style={{ background: "var(--app-input-bg)" }}>
                  {(["list", "tree"] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      className={`flex flex-1 items-center justify-center gap-1 rounded px-2 py-1 text-xs transition-colors duration-[var(--dur-fast)] ${segClass(viewType === mode)}`}
                      onClick={() => setViewType(mode)}
                    >
                      {mode === "list" ? (
                        <List className="h-3 w-3" strokeWidth={1.5} />
                      ) : (
                        <ListTree className="h-3 w-3" strokeWidth={1.5} />
                      )}
                      {mode === "list"
                        ? t("view.list", { defaultValue: "列表" })
                        : t("view.tree", { defaultValue: "树" })}
                    </button>
                  ))}
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-2">
                {bindings.length === 0 && !loading ? (
                  <EmptyState
                    icon={Workflow}
                    title={t("emptyTasks.title", { defaultValue: "暂无编排任务" })}
                    description={t("emptyTasks.description", {
                      defaultValue: "由 leader/worker 派发的任务会出现在这里",
                    })}
                  />
                ) : viewType === "tree" ? (
                  <OrchestratorTaskTree />
                ) : (
                  <TaskList bindings={bindings} selectedTaskId={selectedTaskId} onSelect={setSelectedTaskId} />
                )}
              </div>
            </>
          ) : (
            <>
              <div className="shrink-0 space-y-2 p-3" style={{ borderBottom: "1px solid var(--app-border)" }}>
                <div className="flex gap-1">
                  {notificationTabs.map((tab) => (
                    <button
                      key={tab.key}
                      type="button"
                      className={`rounded-md px-2 py-1 text-xs transition-colors duration-[var(--dur-fast)] ${segClass(notificationFilter === tab.key)}`}
                      onClick={() => setNotificationFilter(tab.key)}
                    >
                      {tab.label}
                    </button>
                  ))}
                  <Button className="ml-auto" variant="ghost" size="xs" onClick={clearNotifications}>
                    {t("clear", { defaultValue: "清空" })}
                  </Button>
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-2">
                {notificationGroups.length === 0 ? (
                  <EmptyState
                    icon={Bell}
                    title={t("emptyNotifications.title", { defaultValue: "暂无通知" })}
                    description={t("emptyNotifications.description", {
                      defaultValue: "任务完成或出错时会在这里提醒",
                    })}
                  />
                ) : (
                  <div className="space-y-1">
                    {notificationGroups.map(({ key, latest, count }) => {
                      const isError = isErrorNotification(latest);
                      const isDone = isCompletedNotification(latest);
                      return (
                        <button
                          key={`${key}:${latest.id}`}
                          type="button"
                          className="flex w-full items-start gap-2 rounded-md px-2 py-2 text-left transition-colors duration-[var(--dur-fast)] hover:bg-[var(--app-hover)]"
                          onClick={() => jumpToNotificationTask(latest)}
                        >
                          {isError ? (
                            <XCircle className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={1.5} style={{ color: "var(--app-status-danger)" }} />
                          ) : isDone ? (
                            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={1.5} style={{ color: "var(--app-status-success)" }} />
                          ) : (
                            <Bell className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={1.5} style={{ color: "var(--app-accent)" }} />
                          )}
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-xs font-medium" style={{ color: "var(--app-text-primary)" }}>
                              {groupTitle(count, latest)}
                            </span>
                            {latest.body && (
                              <span className="mt-0.5 line-clamp-2 text-[11px]" style={{ color: "var(--app-text-secondary)" }}>
                                {latest.body}
                              </span>
                            )}
                            <span className="mt-1 flex items-center gap-1 text-[10px]" style={{ color: "var(--app-text-tertiary)" }}>
                              <span>{latest.kind}</span>
                              <span>·</span>
                              <span>{formatTime(latest.timestamp)}</span>
                              {latest.taskBindingId && (
                                <>
                                  <span>·</span>
                                  <span>{t("linkedTask", { defaultValue: "已关联任务" })}</span>
                                </>
                              )}
                            </span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </>
          )}
        </aside>

        <main className="min-w-0 flex-1">
          <TaskDetailPanel binding={selectedBinding} />
        </main>

        <aside
          className="group relative flex shrink-0 flex-col"
          style={{
            width: rightCollapsed ? 10 : rightWidth,
            borderLeft: "1px solid var(--app-border)",
            background: "var(--app-content)",
          }}
        >
          <button
            type="button"
            className="absolute left-0 top-0 z-10 flex h-full w-2 cursor-col-resize items-center justify-center opacity-0 transition-opacity duration-[var(--dur-fast)] group-hover:opacity-100"
            onPointerDown={startResize}
            title={rightCollapsed ? t("expandPreview", { defaultValue: "展开预览" }) : t("resizePreview", { defaultValue: "调整预览宽度" })}
          >
            <GripVertical className="h-5 w-5" strokeWidth={1.5} style={{ color: "var(--app-text-tertiary)" }} />
          </button>
          {!rightCollapsed && (
            <>
              <div className="flex h-10 shrink-0 items-center justify-between px-3" style={{ borderBottom: "1px solid var(--app-border)" }}>
                <div className="min-w-0 truncate text-[10px] font-semibold uppercase tracking-wider" style={{ color: "var(--app-text-tertiary)" }}>
                  {t("outputPreview", { defaultValue: "输出预览" })}
                </div>
                <IconTooltipButton
                  label={t("collapsePreview", { defaultValue: "折叠预览" })}
                  onClick={() => setRightCollapsed(true)}
                >
                  <PanelRightClose className="h-3.5 w-3.5" strokeWidth={1.5} />
                </IconTooltipButton>
              </div>
              <div className="min-h-0 flex-1">
                <SessionOutputPreview sessionId={selectedBinding?.sessionId} />
              </div>
            </>
          )}
          {rightCollapsed && (
            <button
              type="button"
              className="flex h-full w-full items-center justify-center opacity-0 transition-opacity duration-[var(--dur-fast)] hover:opacity-100"
              onClick={() => setRightCollapsed(false)}
              title={t("expandPreview", { defaultValue: "展开预览" })}
            >
              <PanelRightOpen className="h-4 w-4" strokeWidth={1.5} style={{ color: "var(--app-text-tertiary)" }} />
            </button>
          )}
        </aside>
      </div>
    </div>
    </TooltipProvider>
  );
}
