// 右下角卡片竖排栈：activeToastIds（新在前）自上而下渲染 + 底部折叠条。
// 容器定位由 NotificationCenter 持有；本组件只负责列表本身。
import { useTranslation } from "react-i18next";
import { ChevronDown } from "lucide-react";
import { classifyNotification } from "@/lib/notificationTaxonomy";
import {
  selectUnreadCount,
  useNotificationStore,
} from "@/stores/useNotificationStore";
import NotificationCard from "./NotificationCard";
import NotificationInputCard from "./NotificationInputCard";

export default function NotificationToastStack() {
  const { t } = useTranslation("notifications");
  const notifications = useNotificationStore((state) => state.notifications);
  const activeToastIds = useNotificationStore((state) => state.activeToastIds);
  const dismissToast = useNotificationStore((state) => state.dismissToast);
  const setHistoryOpen = useNotificationStore((state) => state.setHistoryOpen);

  const records = activeToastIds
    .map((id) => notifications.find((n) => n.id === id))
    .filter((record): record is NonNullable<typeof record> => Boolean(record));
  // 折叠条计数 = 栈外未读；栈内的用户已经看见了
  const foldedUnread =
    selectUnreadCount({ notifications }) -
    records.reduce((count, record) => (record.read ? count : count + 1), 0);

  if (records.length === 0 && foldedUnread <= 0) return null;

  return (
    <div className="flex w-full flex-col gap-2" data-testid="notification-toast-stack">
      {records.map((record) =>
        classifyNotification(record).interruptClass === "askInput" ? (
          <NotificationInputCard key={record.id} record={record} onDismiss={dismissToast} />
        ) : (
          <NotificationCard key={record.id} record={record} onDismiss={dismissToast} />
        ),
      )}
      {foldedUnread > 0 && (
        <button
          type="button"
          data-testid="notification-fold-bar"
          className="flex w-full items-center gap-1.5 rounded-lg border border-[var(--app-border)] bg-[var(--app-panel-bg)] px-3 py-1.5 text-[12px] text-[var(--app-text-secondary)] shadow-sm transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]"
          onClick={() => setHistoryOpen(true)}
        >
          <ChevronDown aria-hidden="true" size={12} className="text-[var(--app-text-tertiary)]" />
          {t("center.foldBar")}
          <span className="ml-auto rounded-full bg-[var(--app-active-bg)] px-1.5 text-[11px] font-semibold tabular-nums text-[var(--app-accent)]">
            {foldedUnread}
          </span>
        </button>
      )}
    </div>
  );
}
