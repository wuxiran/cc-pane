import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  Bell,
  CheckCircle2,
  GripVertical,
  List,
  PanelRightClose,
  PanelRightOpen,
  Search,
  Workflow,
  X,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
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

function groupTitle(count: number, latest: NotificationRecord): string {
  if (count <= 1) return latest.title;
  if (isCompletedNotification(latest)) return `${count} tasks completed`;
  if (isErrorNotification(latest)) return `${count} task errors`;
  return `${count} notifications`;
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
            className="block w-full rounded-lg text-left transition-colors"
            style={{
              border: selected ? "1px solid var(--app-accent)" : "1px solid transparent",
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
    { key: "all" as const, label: "All" },
    { key: "running" as const, label: "Running" },
    { key: "completed" as const, label: "Done" },
  ];
  const notificationTabs = [
    { key: "all" as const, label: "All" },
    { key: "errors" as const, label: "Errors" },
    { key: "completed" as const, label: "Done" },
  ];

  return (
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
          <Workflow className="h-4 w-4" style={{ color: "var(--app-accent)" }} />
          <span className="text-sm font-semibold" style={{ color: "var(--app-text-primary)" }}>
            Orchestration
          </span>
          <div className="ml-3 flex rounded-md p-0.5" style={{ border: "1px solid var(--app-border)" }}>
            {(["tasks", "notifications"] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                className="rounded px-3 py-1 text-xs font-medium transition-colors"
                style={{
                  background: mainTab === tab ? "var(--app-accent)" : "transparent",
                  color: mainTab === tab ? "white" : "var(--app-text-secondary)",
                }}
                onClick={() => setMainTab(tab)}
              >
                {tab === "tasks" ? "Tasks" : "Notifications"}
              </button>
            ))}
          </div>
        </div>
        <Button
          variant="ghost"
          size={isOverlay ? "icon-sm" : "sm"}
          onClick={close}
          title={isOverlay ? "Close" : "Exit"}
        >
          {isOverlay ? <X className="h-4 w-4" /> : "Exit"}
        </Button>
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
                      className="rounded px-2 py-1 text-xs transition-colors"
                      style={{
                        background: filterTab === tab.key ? "var(--app-accent)" : "transparent",
                        color: filterTab === tab.key ? "white" : "var(--app-text-secondary)",
                      }}
                      onClick={() => setFilterTab(tab.key)}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
                <label className="flex h-8 items-center gap-2 rounded-md px-2" style={{ border: "1px solid var(--app-border)" }}>
                  <Search className="h-3.5 w-3.5" style={{ color: "var(--app-text-tertiary)" }} />
                  <input
                    className="min-w-0 flex-1 bg-transparent text-xs outline-none"
                    value={searchKeyword}
                    onChange={(event) => setSearchKeyword(event.target.value)}
                    placeholder="Search tasks"
                    style={{ color: "var(--app-text-primary)" }}
                  />
                </label>
                <div className="flex rounded-md p-0.5" style={{ border: "1px solid var(--app-border)" }}>
                  {(["list", "tree"] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      className="flex flex-1 items-center justify-center gap-1 rounded px-2 py-1 text-xs transition-colors"
                      style={{
                        background: viewType === mode ? "var(--app-active-bg)" : "transparent",
                        color: viewType === mode ? "var(--app-accent)" : "var(--app-text-secondary)",
                      }}
                      onClick={() => setViewType(mode)}
                    >
                      <List className="h-3 w-3" />
                      {mode === "list" ? "List" : "Tree"}
                    </button>
                  ))}
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-2">
                {bindings.length === 0 && !loading ? (
                  <div className="py-10 text-center text-xs" style={{ color: "var(--app-text-tertiary)" }}>
                    No tasks yet
                  </div>
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
                      className="rounded px-2 py-1 text-xs transition-colors"
                      style={{
                        background: notificationFilter === tab.key ? "var(--app-accent)" : "transparent",
                        color: notificationFilter === tab.key ? "white" : "var(--app-text-secondary)",
                      }}
                      onClick={() => setNotificationFilter(tab.key)}
                    >
                      {tab.label}
                    </button>
                  ))}
                  <Button className="ml-auto" variant="ghost" size="xs" onClick={clearNotifications}>
                    Clear
                  </Button>
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-2">
                {notificationGroups.length === 0 ? (
                  <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
                    <Bell className="h-7 w-7" style={{ color: "var(--app-text-tertiary)" }} />
                    <div className="text-xs" style={{ color: "var(--app-text-tertiary)" }}>
                      No notifications
                    </div>
                  </div>
                ) : (
                  <div className="space-y-1">
                    {notificationGroups.map(({ key, latest, count }) => {
                      const isError = isErrorNotification(latest);
                      const isDone = isCompletedNotification(latest);
                      return (
                        <button
                          key={`${key}:${latest.id}`}
                          type="button"
                          className="flex w-full items-start gap-2 rounded-md px-2 py-2 text-left transition-colors hover:bg-[var(--app-hover)]"
                          onClick={() => jumpToNotificationTask(latest)}
                        >
                          {isError ? (
                            <XCircle className="mt-0.5 h-4 w-4 shrink-0" style={{ color: "var(--app-status-danger)" }} />
                          ) : isDone ? (
                            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" style={{ color: "var(--app-status-success)" }} />
                          ) : (
                            <Bell className="mt-0.5 h-4 w-4 shrink-0" style={{ color: "var(--app-accent)" }} />
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
                                  <span>linked task</span>
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
            className="absolute left-0 top-0 z-10 flex h-full w-2 cursor-col-resize items-center justify-center opacity-0 transition-opacity group-hover:opacity-100"
            onPointerDown={startResize}
            title={rightCollapsed ? "Expand preview" : "Resize preview"}
          >
            <GripVertical className="h-5 w-5" style={{ color: "var(--app-text-tertiary)" }} />
          </button>
          {!rightCollapsed && (
            <>
              <div className="flex h-10 shrink-0 items-center justify-between px-3" style={{ borderBottom: "1px solid var(--app-border)" }}>
                <div className="min-w-0 truncate text-xs font-medium" style={{ color: "var(--app-text-secondary)" }}>
                  Output Preview
                </div>
                <Button variant="ghost" size="icon-xs" onClick={() => setRightCollapsed(true)} title="Collapse preview">
                  <PanelRightClose className="h-3.5 w-3.5" />
                </Button>
              </div>
              <div className="min-h-0 flex-1">
                <SessionOutputPreview sessionId={selectedBinding?.sessionId} />
              </div>
            </>
          )}
          {rightCollapsed && (
            <button
              type="button"
              className="flex h-full w-full items-center justify-center opacity-0 transition-opacity hover:opacity-100"
              onClick={() => setRightCollapsed(false)}
              title="Expand preview"
            >
              <PanelRightOpen className="h-4 w-4" style={{ color: "var(--app-text-tertiary)" }} />
            </button>
          )}
        </aside>
      </div>
    </div>
  );
}
