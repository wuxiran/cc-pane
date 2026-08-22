// 历史面板：铃铛/折叠条展开。过滤（severity/interruptClass 分类，不再字符串猜）、
// groupKey 分组折叠、未读点、点击跳任务/会话、全部已读、清空。
// 取代 OrchestrationFullView 的 notifications 标签页。
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconTooltipButton } from "@/components/ui/IconTooltipButton";
import {
  classifyNotification,
  isSystemNotification,
  type NotificationSeverity,
} from "@/lib/notificationTaxonomy";
import {
  selectUnreadCount,
  useNotificationStore,
  type NotificationRecord,
} from "@/stores/useNotificationStore";
import {
  displayTitle,
  focusNotificationSession,
  formatRelativeTime,
  jumpToNotificationTask,
} from "./notificationActions";

type HistoryFilter = "all" | "errors" | "completed" | "askInput" | "system";

const SEVERITY_DOT: Record<NotificationSeverity, string> = {
  error: "var(--app-status-danger)",
  warning: "var(--app-status-warning)",
  success: "var(--app-status-success)",
  info: "var(--app-accent)",
};

function matchesFilter(record: NotificationRecord, filter: HistoryFilter): boolean {
  // 「全部」必须真的是全部。铃铛徽章与折叠条数的是 selectUnreadCount（全量未读，含系统），
  // 这里再减掉系统通知，未读全是系统事件时就会出现"徽章 7 条、默认视图暂无通知"——
  // 人看得见计数却找不到内容，也就无从判断该不该清。降噪交给「系统」这个子集筛选表达，
  // 不靠让「全部」名不副实。
  if (filter === "all") return true;
  if (filter === "system") return isSystemNotification(record);
  const { severity, interruptClass } = classifyNotification(record);
  if (filter === "errors") return severity === "error";
  if (filter === "completed") return severity === "success";
  return interruptClass === "askInput";
}

/** 同 kind + groupKey 且 5s 内的通知折为一条（沿用旧编排视图口径） */
function groupNotifications(notifications: NotificationRecord[]) {
  const consumed = new Set<string>();
  return notifications.flatMap((latest) => {
    if (consumed.has(latest.id)) return [];
    const key = latest.groupKey ? `${latest.kind}:${latest.groupKey}` : latest.id;
    const group = notifications.filter((item) => {
      const itemKey = item.groupKey ? `${item.kind}:${item.groupKey}` : item.id;
      return itemKey === key && Math.abs(latest.timestamp - item.timestamp) <= 5_000;
    });
    for (const item of group) consumed.add(item.id);
    return [{ key: `${key}:${latest.id}`, latest, count: group.length }];
  });
}

export default function NotificationHistoryPanel() {
  const { t } = useTranslation("notifications");
  const notifications = useNotificationStore((state) => state.notifications);
  const markRead = useNotificationStore((state) => state.markRead);
  const markAllRead = useNotificationStore((state) => state.markAllRead);
  const clear = useNotificationStore((state) => state.clear);
  const setHistoryOpen = useNotificationStore((state) => state.setHistoryOpen);
  const [filter, setFilter] = useState<HistoryFilter>("all");

  const unreadCount = selectUnreadCount({ notifications });
  const groups = useMemo(
    () => groupNotifications(notifications.filter((n) => matchesFilter(n, filter))),
    [filter, notifications],
  );

  const filters: Array<{ id: HistoryFilter; label: string }> = [
    { id: "all", label: t("center.filterAll") },
    { id: "errors", label: t("center.filterErrors") },
    { id: "completed", label: t("center.filterCompleted") },
    { id: "askInput", label: t("center.filterAskInput") },
    { id: "system", label: t("center.filterSystem") },
  ];

  const openRecord = (record: NotificationRecord) => {
    markRead(record.id);
    if (record.taskBindingId) {
      jumpToNotificationTask(record.taskBindingId);
      setHistoryOpen(false);
      return;
    }
    if (record.sessionId && focusNotificationSession(record.sessionId)) {
      setHistoryOpen(false);
    }
  };

  return (
    <div
      data-testid="notification-history-panel"
      className="flex w-full flex-col overflow-hidden rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] shadow-lg motion-safe:animate-in motion-safe:slide-in-from-bottom-2 motion-safe:fade-in"
    >
      <div className="flex items-center gap-2 border-b border-[var(--app-border)] px-3 py-2">
        <span className="text-[13px] font-semibold text-[var(--app-text-primary)]">
          {t("center.title")}
        </span>
        {unreadCount > 0 && (
          <span className="rounded-full bg-[var(--app-active-bg)] px-1.5 text-[11px] font-semibold tabular-nums text-[var(--app-accent)]">
            {t("center.unreadCount", { count: unreadCount })}
          </span>
        )}
        <span className="flex-1" />
        <Button size="sm" variant="ghost" className="h-6 px-2 text-[11.5px]" onClick={markAllRead}>
          {t("center.markAllRead")}
        </Button>
        <Button size="sm" variant="ghost" className="h-6 px-2 text-[11.5px]" onClick={clear}>
          {t("center.clearAll")}
        </Button>
        <IconTooltipButton label={t("center.close")} side="left" onClick={() => setHistoryOpen(false)}>
          <X aria-hidden="true" size={14} />
        </IconTooltipButton>
      </div>

      <div className="flex gap-1 px-3 pb-1 pt-2">
        {filters.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            className={`rounded-full px-2.5 py-0.5 text-[11.5px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)] ${
              filter === id
                ? "bg-[var(--app-active-bg)] font-semibold text-[var(--app-accent)]"
                : "border border-[var(--app-border)] text-[var(--app-text-secondary)] hover:bg-[var(--app-hover)]"
            }`}
            onClick={() => setFilter(id)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="max-h-[320px] overflow-y-auto px-1.5 pb-2 pt-1">
        {groups.length === 0 ? (
          <p className="px-3 py-6 text-center text-[12px] text-[var(--app-text-tertiary)]">
            {t("center.empty")}
          </p>
        ) : (
          groups.map(({ key, latest, count }) => {
            const severity = classifyNotification(latest).severity;
            return (
              <button
                key={key}
                type="button"
                className="relative flex w-full gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-[var(--app-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]"
                onClick={() => openRecord(latest)}
              >
                <span
                  aria-hidden="true"
                  className="mt-[5px] size-[7px] shrink-0 rounded-full"
                  style={{ background: SEVERITY_DOT[severity] }}
                />
                <span className="min-w-0 flex-1">
                  <span
                    className={`block truncate text-[12.5px] ${
                      latest.read
                        ? "text-[var(--app-text-secondary)]"
                        : "font-medium text-[var(--app-text-primary)]"
                    }`}
                  >
                    {displayTitle(latest.kind, latest.title, t)}
                    {latest.body ? ` — ${latest.body}` : ""}
                    {count > 1 ? ` ×${count}` : ""}
                  </span>
                  <span className="block text-[11px] text-[var(--app-text-tertiary)]">
                    {latest.source ? `${latest.source} · ` : ""}
                    {formatRelativeTime(latest.timestamp, t)}
                    {latest.respondedAt !== undefined && (
                      <span className="text-[var(--app-status-success)]">
                        {" · "}
                        {t("center.respondedShort")}
                      </span>
                    )}
                  </span>
                </span>
                {!latest.read && (
                  <span
                    aria-hidden="true"
                    className="absolute right-2.5 top-2.5 size-1.5 rounded-full bg-[var(--app-accent)]"
                  />
                )}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
